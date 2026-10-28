import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentModelError,
  newConversation,
  runAgentTurn,
  summarizeDecision,
  type AgentConversation,
  type GeminiModel,
  type PurchaseTools,
  type ToolCallRecord,
} from "../agent/geminiShoppingAgent.js";
import { formatCents } from "../engine/policy.js";
import { transactionRequestSchema, type SentinelGuard } from "../engine/sentinelGuard.js";
import type { Agent, LedgerStore } from "../engine/store.js";
import { HTTP_STATUS_BY_TRANSACTION_STATUS } from "../routes/agent.js";

/**
 * In-app AI purchasing assistant. An operator types a request in the dashboard; Gemini
 * runs server-side as the chosen agent and either asks a clarifying question or submits
 * structured purchase intents.
 *
 * Intents go through exactly the same validation (transactionRequestSchema) and
 * SentinelGuard.submit path as POST /api/agent/transactions. So caps, allowlists,
 * freeze state, injection screening, idempotency and the buyer-approval requirement
 * apply unchanged, and the model never holds a credential of any kind.
 *
 * Conversation state is kept in this process's memory (never sent to the browser,
 * which receives only an opaque id), bound to one operator and one agent.
 */

const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 200;
const MAX_MESSAGES_PER_CONVERSATION = 12;

export class AssistantError extends Error {
  override readonly name = "AssistantError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Session {
  operatorId: string;
  agentId: string;
  conversation: AgentConversation;
  messages: number;
  updatedAt: number;
  busy: boolean;
}

export interface AssistantToolCall {
  tool: string;
  /** What the model asked for (untrusted input, shown for transparency). */
  args: Record<string, unknown>;
  /** SentinelPay's decision or the tool's result. */
  result: Record<string, unknown>;
}

export interface AssistantReply {
  conversationId: string;
  agentId: string;
  model: string;
  status: "ANSWER" | "QUESTION" | "LIMIT" | "MODEL_ERROR";
  text: string;
  toolCalls: AssistantToolCall[];
  /** Purchase intents the model submitted to SentinelPay in this message. */
  intentsSubmitted: number;
  /** Submissions where money moved (COMPLETED / CAPTURE_PENDING). */
  paymentsCaptured: number;
  /** Submissions that created a PayPal order awaiting buyer approval (no money moved yet). */
  awaitingApproval: number;
  error: { message: string; httpStatus: number | null } | null;
}

export interface AssistantOptions {
  store: LedgerStore;
  guard: SentinelGuard;
  model: GeminiModel | null;
}

export class AssistantService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: AssistantOptions) {}

  get available(): boolean {
    return this.options.model !== null;
  }

  get modelName(): string | null {
    return this.options.model?.model ?? null;
  }

  async handleMessage(input: { operatorId: string; agentId: string; conversationId?: string; message: string }): Promise<AssistantReply> {
    const model = this.options.model;
    if (!model) throw new AssistantError(503, "ASSISTANT_UNAVAILABLE", "The AI assistant is not configured (set GEMINI_API_KEY on the server)");

    this.evictStale();
    const agent = await this.options.store.getAgent(input.agentId);
    if (!agent) throw new AssistantError(404, "AGENT_NOT_FOUND", "No such agent");

    let conversationId = input.conversationId;
    let session: Session | undefined;
    if (conversationId) {
      session = this.sessions.get(conversationId);
      // Another operator's (or another agent's) conversation is indistinguishable from a missing one.
      if (!session || session.operatorId !== input.operatorId || session.agentId !== input.agentId) {
        throw new AssistantError(404, "CONVERSATION_NOT_FOUND", "Conversation not found or expired; start a new one");
      }
      if (session.busy) throw new AssistantError(409, "CONVERSATION_BUSY", "This conversation is still processing the previous message");
      if (session.messages >= MAX_MESSAGES_PER_CONVERSATION) {
        throw new AssistantError(409, "CONVERSATION_LIMIT", "This conversation is too long; start a new one");
      }
    } else {
      conversationId = randomUUID();
      session = { operatorId: input.operatorId, agentId: input.agentId, conversation: newConversation(), messages: 0, updatedAt: Date.now(), busy: false };
      this.sessions.set(conversationId, session);
    }

    session.busy = true;
    session.messages++;
    session.updatedAt = Date.now();
    let reply: AssistantReply;
    try {
      const result = await runAgentTurn(model, session.conversation, input.message, this.toolsFor(agent));
      reply = this.reply(conversationId, agent.id, model.model, result.outcome.kind === "answer" ? "ANSWER" : result.outcome.kind === "question" ? "QUESTION" : "LIMIT",
        result.outcome.kind === "question" ? result.outcome.question : result.outcome.text, result.toolCalls, null);
    } catch (error) {
      if (!(error instanceof AgentModelError)) throw error;
      // The model failed mid-conversation: report exactly what (if anything) was already submitted.
      this.sessions.delete(conversationId);
      reply = this.reply(conversationId, agent.id, model.model, "MODEL_ERROR", "The AI model is unavailable right now.", error.toolCalls, {
        message: error.message,
        httpStatus: error.httpStatus,
      });
    } finally {
      session.busy = false;
    }

    await this.options.store.audit({
      actor: { type: "OPERATOR", id: input.operatorId },
      action: "ASSISTANT_MESSAGE",
      agentId: agent.id,
      details: {
        conversationId,
        status: reply.status,
        intentsSubmitted: reply.intentsSubmitted,
        transactionIds: reply.toolCalls.map((c) => c.result.transactionId).filter(Boolean),
        messageLength: input.message.length,
      },
    });
    return reply;
  }

  /** In-process tools that call the same code path as the agent HTTP API. */
  private toolsFor(agent: Agent): PurchaseTools {
    const { store, guard } = this.options;
    const agentId = agent.id;
    return {
      async getPolicy() {
        const [policy, spend] = await Promise.all([store.getAgentPolicy(agentId), store.spendingToday(agentId)]);
        return {
          perTransactionCap: policy?.perTransactionCap,
          dailyCap: policy?.dailyCap,
          autonomousLimit: policy?.autonomousLimit,
          allowedMerchants: policy?.allowedMerchants,
          allowedCategories: policy?.allowedCategories,
          frozen: policy?.frozen,
          spentToday: { reservedToday: formatCents(spend.reservedCents), committedToday: formatCents(spend.committedCents) },
        };
      },
      async submitIntent(intent) {
        const parsed = transactionRequestSchema.safeParse({ requestId: `assistant-${randomUUID()}`, ...intent });
        if (!parsed.success) {
          return summarizeDecision(400, { error: "INVALID_REQUEST", issues: z.flattenError(parsed.error).fieldErrors });
        }
        const result = await guard.submit(agent, parsed.data);
        if (result.kind === "idempotency_conflict") {
          return summarizeDecision(409, { error: "IDEMPOTENCY_KEY_REUSED", transactionId: result.transactionId });
        }
        return summarizeDecision(HTTP_STATUS_BY_TRANSACTION_STATUS[result.transaction.status], result.transaction);
      },
    };
  }

  private reply(
    conversationId: string,
    agentId: string,
    model: string,
    status: AssistantReply["status"],
    text: string,
    toolCalls: ToolCallRecord[],
    error: AssistantReply["error"],
  ): AssistantReply {
    const decisions = toolCalls.filter((c) => c.tool === "submit_purchase_intent" && c.result.decision !== undefined && c.result.error !== "SUBMISSION_LIMIT");
    return {
      conversationId,
      agentId,
      model,
      status,
      text,
      toolCalls: toolCalls.map((c) => ({ tool: c.tool, args: c.args, result: c.result })),
      intentsSubmitted: decisions.length,
      paymentsCaptured: decisions.filter((c) => c.result.decision === "COMPLETED" || c.result.decision === "CAPTURE_PENDING").length,
      awaitingApproval: decisions.filter((c) => c.result.decision === "PENDING_APPROVAL").length,
      error,
    };
  }

  private evictStale(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of this.sessions) if (!s.busy && s.updatedAt < cutoff) this.sessions.delete(id);
    // Hard cap: drop the oldest idle sessions.
    if (this.sessions.size >= MAX_SESSIONS) {
      const idle = [...this.sessions.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [id] of idle.slice(0, this.sessions.size - MAX_SESSIONS + 1)) this.sessions.delete(id);
    }
  }
}
