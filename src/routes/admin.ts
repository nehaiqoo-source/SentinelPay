import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authenticateOperator, rejectUnauthenticatedOperator, requirePermission, type OperatorLocals } from "../auth/auth.js";
import { hasPermission, OperatorError, PERMISSIONS, type OperatorStore, type Permission } from "../auth/operators.js";
import { AssistantError, type AssistantService } from "../assistant/assistantService.js";
import type { Db } from "../db/pool.js";
import { listAudit } from "../engine/audit.js";
import { createCheckpoint, verifyAuditIntegrity, type CheckpointSigner } from "../engine/auditCheckpoints.js";
import type { GlobalLimits } from "../engine/policy.js";
import { identifierSchema, toResponse, type SentinelGuard } from "../engine/sentinelGuard.js";
import type { AgentPolicyInput, LedgerStore } from "../engine/store.js";
import { HTTP_STATUS_BY_TRANSACTION_STATUS, invalidRequest, orderIdSchema, uuidSchema } from "./agent.js";

const amountCents = (allowZero: boolean) =>
  z.union([z.number(), z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/).transform(Number)]).transform((value, ctx) => {
    const cents = Math.round(value * 100);
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || Math.abs(value * 100 - cents) > 1e-6) {
      ctx.addIssue({ code: "custom", message: `must be a ${allowZero ? "non-negative" : "positive"} USD amount with at most 2 decimals` });
      return z.NEVER;
    }
    return cents;
  });

const policySchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  perTransactionCap: amountCents(false),
  dailyCap: amountCents(false),
  /** Payments up to this amount may skip buyer approval when a vault is configured. Default 0 = never. */
  autonomousLimit: amountCents(true).default(0),
  allowedMerchants: z.array(identifierSchema).max(200).nullable(),
  allowedCategories: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)).max(200).nullable(),
});

const createAgentSchema = policySchema.extend({ agentId: identifierSchema });
const reasonSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });
const reconcileSchema = z.strictObject({ resolution: z.enum(["RETRY_CREATE", "MARK_FAILED"]).optional() });
const operatorIdSchema = z.string().regex(/^[a-z0-9._-]{1,64}$/, "lowercase letters, digits, '.', '_' and '-'");
const createOperatorSchema = z.strictObject({
  operatorId: operatorIdSchema,
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
const listSchema = z.strictObject({
  agentId: identifierSchema.optional(),
  status: z
    .enum([
      "BLOCKED",
      "PROCESSING",
      "PENDING_APPROVAL",
      "CAPTURING",
      "RECONCILE_REQUIRED",
      "CAPTURE_PENDING",
      "COMPLETED",
      "REFUNDED",
      "DECLINED",
      "FAILED",
      "EXPIRED",
      "CANCELLED",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  transactionId: z.uuid().optional(),
});

const assistantMessageSchema = z.strictObject({
  agentId: identifierSchema,
  message: z.string().trim().min(1).max(2000),
  conversationId: z.uuid().optional(),
});

export interface AdminRouterOptions {
  db: Db;
  store: LedgerStore;
  guard: SentinelGuard;
  operators: OperatorStore;
  assistant: AssistantService;
  global: GlobalLimits;
  authFailureLimitPerMinute: number;
  assistantRateLimitPerMinute: number;
  audit: { signer: CheckpointSigner | null; externalFile: string | null };
}

/** Operator API: every route requires a named operator key and a role-based permission. */
export function createAdminRouter({
  db,
  store,
  guard,
  operators,
  assistant,
  global,
  authFailureLimitPerMinute,
  assistantRateLimitPerMinute,
  audit,
}: AdminRouterOptions): Router {
  const router = Router();

  // Authenticate first, then throttle ONLY requests that failed authentication, then reject them.
  // Authenticated operators skip this limiter entirely, so failed attempts from a shared IP
  // (or an attacker behind the same proxy) cannot lock legitimate operators out.
  router.use(authenticateOperator(operators));
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: authFailureLimitPerMinute,
      skip: (_req, res) => res.locals.operator !== undefined,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "RATE_LIMITED", message: "Too many failed authentication attempts; try again later" },
    }),
  );
  router.use(rejectUnauthenticatedOperator(operators));
  const can = (permission: Permission): RequestHandler => requirePermission(operators, permission);

  const checkCeilings = (policy: AgentPolicyInput): string | null => {
    if (policy.perTransactionCapCents > global.perTransactionCapCents) return "perTransactionCap exceeds the global per-transaction cap";
    if (policy.dailyCapCents > global.dailyCapCents) return "dailyCap exceeds the global daily cap";
    if (policy.perTransactionCapCents > policy.dailyCapCents) return "perTransactionCap must not exceed dailyCap";
    if (policy.autonomousLimitCents > policy.perTransactionCapCents) return "autonomousLimit must not exceed perTransactionCap";
    return null;
  };
  const toPolicyInput = (body: z.infer<typeof policySchema>): AgentPolicyInput => ({
    displayName: body.displayName,
    perTransactionCapCents: body.perTransactionCap,
    dailyCapCents: body.dailyCap,
    autonomousLimitCents: body.autonomousLimit,
    allowedMerchants: body.allowedMerchants,
    allowedCategories: body.allowedCategories,
  });

  // ----- identity -----------------------------------------------------------

  router.get("/me", can("dashboard:read"), async (_req, res) => {
    const { operator } = res.locals as OperatorLocals;
    const account = await operators.get(operator.id);
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => hasPermission(operator.role, p));
    res.json({ ...account, permissions });
  });

  // ----- read-only ------------------------------------------------------------

  router.get("/summary", can("dashboard:read"), async (_req, res) => {
    res.json(await guard.summary());
  });

  router.get("/agents", can("dashboard:read"), async (_req, res) => {
    res.json({ agents: await store.listAgents() });
  });

  router.get("/agents/:agentId", can("dashboard:read"), async (req, res) => {
    const id = identifierSchema.safeParse(req.params.agentId);
    const agent = id.success ? await store.getAgentPolicy(id.data) : null;
    if (!agent) return void res.status(404).json({ error: "AGENT_NOT_FOUND", message: "No such agent" });
    res.json(agent);
  });

  router.get("/transactions", can("dashboard:read"), async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const transactions = await store.listTransactions({
      limit: parsed.data.limit,
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    });
    res.json({ summary: await guard.summary(), transactions: transactions.map(toResponse) });
  });

  router.get("/transactions/:transactionId", can("dashboard:read"), async (req, res) => {
    const id = uuidSchema.safeParse(req.params.transactionId);
    const stored = id.success ? await store.getTransaction(id.data) : null;
    if (!stored) return void res.status(404).json({ error: "TRANSACTION_NOT_FOUND", message: "No such transaction" });
    res.json(toResponse(stored.record));
  });

  // ----- agent administration -----------------------------------------------

  router.post("/agents", can("agents:manage"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const policy = toPolicyInput(parsed.data);
    const problem = checkCeilings(policy);
    if (problem) return void res.status(400).json({ error: "POLICY_EXCEEDS_LIMITS", message: problem });
    if (await store.getAgentPolicy(parsed.data.agentId)) {
      return void res.status(409).json({ error: "AGENT_EXISTS", message: "An agent with this id already exists" });
    }
    // The plaintext key is returned exactly once; only its hash is stored.
    res.status(201).json(await store.createAgent(parsed.data.agentId, policy, actor));
  });

  router.put("/agents/:agentId/policy", can("agents:manage"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = identifierSchema.safeParse(req.params.agentId);
    const parsed = policySchema.safeParse(req.body);
    if (!id.success) return invalidRequest(res, id.error);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const policy = toPolicyInput(parsed.data);
    const problem = checkCeilings(policy);
    if (problem) return void res.status(400).json({ error: "POLICY_EXCEEDS_LIMITS", message: problem });
    const agent = await store.updateAgentPolicy(id.data, policy, actor);
    if (!agent) return void res.status(404).json({ error: "AGENT_NOT_FOUND", message: "No such agent" });
    res.json(agent);
  });

  router.post("/agents/:agentId/freeze", can("agents:freeze"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = identifierSchema.safeParse(req.params.agentId);
    const parsed = reasonSchema.safeParse(req.body);
    if (!id.success) return invalidRequest(res, id.error);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const agent = await store.setFrozen(id.data, true, parsed.data.reason, actor);
    if (!agent) return void res.status(404).json({ error: "AGENT_NOT_FOUND", message: "No such agent" });
    res.json(agent);
  });

  router.post("/agents/:agentId/unfreeze", can("agents:unfreeze"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = identifierSchema.safeParse(req.params.agentId);
    if (!id.success) return invalidRequest(res, id.error);
    const agent = await store.setFrozen(id.data, false, null, actor);
    if (!agent) return void res.status(404).json({ error: "AGENT_NOT_FOUND", message: "No such agent" });
    res.json(agent);
  });

  router.post("/agents/:agentId/rotate-key", can("agents:manage"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = identifierSchema.safeParse(req.params.agentId);
    const rotated = id.success ? await store.rotateAgentKey(id.data, actor) : null;
    if (!rotated) return void res.status(404).json({ error: "AGENT_NOT_FOUND", message: "No such agent" });
    res.json(rotated);
  });

  // ----- payment operations -------------------------------------------------

  router.post("/orders/:orderId/capture", can("payments:operate"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const orderId = orderIdSchema.safeParse(req.params.orderId);
    if (!orderId.success) return invalidRequest(res, orderId.error);
    const result = await guard.captureApprovedOrder(orderId.data, actor);
    if (!result.success) return void res.status(409).json(result);
    res.status(HTTP_STATUS_BY_TRANSACTION_STATUS[result.transaction.status]).json(result);
  });

  router.post("/transactions/:transactionId/cancel", can("payments:operate"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = uuidSchema.safeParse(req.params.transactionId);
    const parsed = reasonSchema.safeParse(req.body);
    if (!id.success) return invalidRequest(res, id.error);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    res.json(await guard.cancel(id.data, actor, parsed.data.reason));
  });

  router.post("/transactions/:transactionId/reconcile", can("payments:operate"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = uuidSchema.safeParse(req.params.transactionId);
    const parsed = reconcileSchema.safeParse(req.body ?? {});
    if (!id.success) return invalidRequest(res, id.error);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    res.json(await guard.reconcile(id.data, actor, parsed.data.resolution));
  });

  // ----- audit --------------------------------------------------------------

  router.get("/audit", can("audit:read"), async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    res.json({
      events: await listAudit(db, {
        limit: parsed.data.limit,
        ...(parsed.data.transactionId ? { transactionId: parsed.data.transactionId } : {}),
      }),
    });
  });

  router.get("/audit/verify", can("audit:read"), async (_req, res) => {
    const report = await verifyAuditIntegrity(db, { publicKey: audit.signer?.publicKey ?? null, externalFile: audit.externalFile });
    // Backwards-compatible top-level fields mirror the chain result.
    res.json({ ...report.chain, valid: report.chain.valid && report.checkpoints.valid, chain: report.chain, checkpoints: report.checkpoints });
  });

  router.post("/audit/checkpoints", can("audit:checkpoint"), async (_req, res) => {
    if (!audit.signer) {
      return void res.status(409).json({ error: "CHECKPOINTS_NOT_CONFIGURED", message: "Set AUDIT_SIGNING_KEY_FILE to enable signed checkpoints" });
    }
    const checkpoint = await createCheckpoint(db, audit.signer, audit.externalFile);
    res.status(checkpoint ? 201 : 200).json({ checkpoint, message: checkpoint ? "Checkpoint signed" : "Chain head already checkpointed (or empty)" });
  });

  // ----- AI assistant -----------------------------------------------------------

  router.get("/assistant/status", can("assistant:use"), (_req, res) => {
    res.json({ available: assistant.available, model: assistant.modelName });
  });

  // Each message can make several model calls; limit per operator to protect the model quota.
  const assistantLimiter = rateLimit({
    windowMs: 60_000,
    limit: assistantRateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (_req, res) => `operator:${(res.locals as OperatorLocals).operator.id}`,
    message: { error: "RATE_LIMITED", message: "Too many assistant messages; wait a minute" },
  });

  router.post("/assistant/messages", can("assistant:use"), assistantLimiter, async (req, res) => {
    const { operator } = res.locals as OperatorLocals;
    const parsed = assistantMessageSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    try {
      const reply = await assistant.handleMessage({
        operatorId: operator.id,
        agentId: parsed.data.agentId,
        message: parsed.data.message,
        ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
      });
      res.status(reply.status === "MODEL_ERROR" ? 502 : 200).json(reply);
    } catch (error) {
      if (error instanceof AssistantError) return void res.status(error.statusCode).json({ error: error.code, message: error.message });
      throw error;
    }
  });

  // ----- operator management --------------------------------------------------

  router.get("/operators", can("operators:manage"), async (_req, res) => {
    res.json({ operators: await operators.list() });
  });

  router.post("/operators", can("operators:manage"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const parsed = createOperatorSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const expiresAt = parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000) : null;
    try {
      // The plaintext key is returned exactly once.
      res.status(201).json(await operators.create({ ...parsed.data, expiresAt }, actor));
    } catch (error) {
      if (error instanceof OperatorError) return void res.status(error.statusCode).json({ error: error.code, message: error.message });
      throw error;
    }
  });

  router.post("/operators/:operatorId/revoke", can("operators:manage"), async (req, res) => {
    const { actor } = res.locals as OperatorLocals;
    const id = operatorIdSchema.safeParse(req.params.operatorId);
    const parsed = reasonSchema.safeParse(req.body);
    if (!id.success) return invalidRequest(res, id.error);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    try {
      res.json(await operators.revoke(id.data, parsed.data.reason, actor));
    } catch (error) {
      if (error instanceof OperatorError) return void res.status(error.statusCode).json({ error: error.code, message: error.message });
      throw error;
    }
  });

  /** Any operator may rotate their own key; rotating someone else's needs operators:manage. */
  router.post("/operators/:operatorId/rotate-key", async (req, res, next) => {
    const { operator, actor } = res.locals as OperatorLocals;
    const id = operatorIdSchema.safeParse(req.params.operatorId);
    if (!id.success) return invalidRequest(res, id.error);
    if (id.data !== operator.id) return can("operators:manage")(req, res, () => rotate(id.data));
    return rotate(id.data);

    async function rotate(target: string): Promise<void> {
      try {
        res.json(await operators.rotateKey(target, actor));
      } catch (error) {
        if (error instanceof OperatorError) return void res.status(error.statusCode).json({ error: error.code, message: error.message });
        next(error);
      }
    }
  });

  return router;
}
