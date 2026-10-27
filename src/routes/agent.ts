import { Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAgent, type AgentLocals } from "../auth/auth.js";
import { transactionRequestSchema, toResponse, type SentinelGuard } from "../engine/sentinelGuard.js";
import type { LedgerStore } from "../engine/store.js";
import { formatCents } from "../engine/policy.js";
import type { TransactionStatus } from "../models/types.js";

export const orderIdSchema = z.string().regex(/^[A-Z0-9]{1,36}$/i, "orderId must be an alphanumeric PayPal order id");
export const uuidSchema = z.uuid();

export const HTTP_STATUS_BY_TRANSACTION_STATUS: Record<TransactionStatus, number> = {
  BLOCKED: 403,
  PROCESSING: 202,
  PENDING_APPROVAL: 202,
  CAPTURING: 202,
  RECONCILE_REQUIRED: 202,
  CAPTURE_PENDING: 202,
  COMPLETED: 201,
  REFUNDED: 200,
  DECLINED: 402,
  FAILED: 502,
  EXPIRED: 410,
  CANCELLED: 409,
};

export function invalidRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "INVALID_REQUEST", issues: z.flattenError(error) });
}

export interface AgentRouterOptions {
  store: LedgerStore;
  guard: SentinelGuard;
  paymentRateLimitPerMinute: number;
}

/** Agent-facing API: every route requires the agent's own API key and sees only its own data. */
export function createAgentRouter({ store, guard, paymentRateLimitPerMinute }: AgentRouterOptions): Router {
  const router = Router();
  router.use(requireAgent(store));

  const paymentLimiter = rateLimit({
    windowMs: 60_000,
    limit: paymentRateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (_req, res) => `agent:${(res.locals as AgentLocals).agent.id}`,
    message: { error: "RATE_LIMITED", message: "Too many payment requests; slow down" },
  });

  router.post("/transactions", paymentLimiter, async (req, res) => {
    const { agent } = res.locals as AgentLocals;
    const parsed = transactionRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);

    const result = await guard.submit(agent, parsed.data);
    if (result.kind === "idempotency_conflict") {
      res.status(409).json({
        error: "IDEMPOTENCY_KEY_REUSED",
        message: "This requestId was already used for a different purchase",
        transactionId: result.transactionId,
      });
      return;
    }
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(HTTP_STATUS_BY_TRANSACTION_STATUS[result.transaction.status]).json(result.transaction);
  });

  router.get("/transactions/:transactionId", async (req, res) => {
    const { agent } = res.locals as AgentLocals;
    const id = uuidSchema.safeParse(req.params.transactionId);
    const stored = id.success ? await store.getTransaction(id.data) : null;
    // Another agent's transaction is indistinguishable from a missing one.
    if (!stored || stored.record.agentId !== agent.id) {
      res.status(404).json({ error: "TRANSACTION_NOT_FOUND", message: "No such transaction" });
      return;
    }
    res.json(toResponse(stored.record));
  });

  router.post("/orders/:orderId/capture", async (req, res) => {
    const { actor } = res.locals as AgentLocals;
    const orderId = orderIdSchema.safeParse(req.params.orderId);
    if (!orderId.success) return invalidRequest(res, orderId.error);
    const result = await guard.captureApprovedOrder(orderId.data, actor);
    if (!result.success) {
      res.status(409).json(result);
      return;
    }
    res.status(HTTP_STATUS_BY_TRANSACTION_STATUS[result.transaction.status]).json(result);
  });

  router.get("/policy", async (_req, res) => {
    const { agent } = res.locals as AgentLocals;
    const [policy, spend] = await Promise.all([store.getAgentPolicy(agent.id), store.spendingToday(agent.id)]);
    res.json({
      policy,
      spending: {
        budgetDay: spend.budgetDay,
        reservedToday: formatCents(spend.reservedCents),
        committedToday: formatCents(spend.committedCents),
      },
    });
  });

  return router;
}
