import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Actor,
  CaptureApprovedResult,
  SpendingSummary,
  TransactionError,
  TransactionRecord,
  TransactionResponse,
  TransactionStatus,
} from "../models/types.js";
import { PayPalApiError, type CaptureDetails, type PaymentGateway } from "../services/paypal.js";
import { canonicalJson } from "./audit.js";
import { scanForInjection } from "./injectionFilter.js";
import { evaluatePolicy, formatCents, requiresBuyerApproval, type GlobalLimits } from "./policy.js";
import type { Agent, LedgerStore, StoredTransaction } from "./store.js";

const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000.00 hard input ceiling, far above any cap.

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, "may only contain letters, digits, '.', '_', ':' and '-'");

const amountCentsSchema = z
  .union([z.number(), z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, "must be a decimal USD amount").transform(Number)])
  .transform((amount, ctx) => {
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - cents) > 1e-6) {
      ctx.addIssue({ code: "custom", message: "amount must be a positive USD amount with at most 2 decimals" });
      return z.NEVER;
    }
    if (cents > MAX_AMOUNT_CENTS) {
      ctx.addIssue({ code: "custom", message: "amount is too large" });
      return z.NEVER;
    }
    return cents;
  });

/**
 * Agent purchase request. Strict: unknown fields (agentId, caps, "approved"
 * flags, ...) are rejected rather than ignored. Agent identity comes only from
 * the API key, never from the body.
 */
export const transactionRequestSchema = z.strictObject({
  /** Mandatory idempotency key, unique per agent. */
  requestId: identifierSchema,
  amount: amountCentsSchema,
  currency: z.literal("USD").default("USD"),
  merchantId: identifierSchema,
  /** Display-only and untrusted; never used for authorization. */
  merchantName: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "must be a lowercase category id"),
  description: z.string().trim().min(1).max(127),
});

export type TransactionRequest = z.infer<typeof transactionRequestSchema>;

const STATUS_MESSAGES: Record<TransactionStatus, string> = {
  BLOCKED: "Transaction blocked by SentinelPay policy.",
  PROCESSING: "Transaction is being processed.",
  PENDING_APPROVAL: "Order created but requires buyer authorization before capture.",
  CAPTURING: "Capture is in progress.",
  RECONCILE_REQUIRED: "PayPal outcome is unknown; budget stays reserved until an operator reconciles it.",
  CAPTURE_PENDING: "Payment captured but is pending settlement at PayPal.",
  COMPLETED: "Payment captured.",
  REFUNDED: "Payment was refunded.",
  DECLINED: "Payment was declined by PayPal.",
  FAILED: "Payment could not be completed.",
  EXPIRED: "Buyer approval was not received in time; the order has expired.",
  CANCELLED: "Transaction was cancelled.",
};

export class GuardError extends Error {
  override readonly name = "GuardError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SubmitResult =
  | { kind: "transaction"; transaction: TransactionResponse; replayed: boolean }
  | { kind: "idempotency_conflict"; transactionId: string };

export type ReconcileResolution = "RETRY_CREATE" | "MARK_FAILED";

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface SentinelGuardOptions {
  store: LedgerStore;
  gateway: PaymentGateway;
  global: GlobalLimits;
  pendingApprovalTtlMs: number;
}

export class SentinelGuard {
  private readonly store: LedgerStore;
  private readonly gateway: PaymentGateway;
  private readonly global: GlobalLimits;
  readonly pendingApprovalTtlMs: number;

  constructor(options: SentinelGuardOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.global = options.global;
    this.pendingApprovalTtlMs = options.pendingApprovalTtlMs;
  }

  /**
   * Screens an agent purchase, atomically reserves budget, and only then calls
   * PayPal. Anything blocked here never reaches PayPal.
   */
  async submit(agent: Agent, request: TransactionRequest): Promise<SubmitResult> {
    const actor: Actor = { type: "AGENT", id: agent.id };
    const findings = scanForInjection({
      description: request.description,
      ...(request.merchantName ? { merchantName: request.merchantName } : {}),
    });
    const preViolations = findings.length
      ? [
          {
            code: "PROMPT_INJECTION" as const,
            message: `Request text looks like a prompt-injection attempt: ${[...new Set(findings.map((f) => f.label))].join("; ")}`,
            matchedRules: [...new Set(findings.map((f) => f.rule))],
            fields: [...new Set(findings.map((f) => f.field))],
          },
        ]
      : [];

    const reservation = await this.store.reserve(
      {
        agentId: agent.id,
        requestId: request.requestId,
        fingerprint: fingerprint(request),
        amountCents: request.amount,
        merchantId: request.merchantId,
        merchantName: request.merchantName ?? null,
        category: request.category,
        description: request.description,
        preViolations,
        evaluate: (current, agentSpent, globalSpent) =>
          evaluatePolicy({
            agent: current,
            global: this.global,
            amountCents: request.amount,
            merchantId: request.merchantId,
            category: request.category,
            agentSpentTodayCents: agentSpent,
            globalSpentTodayCents: globalSpent,
          }),
        decideMode: (current) =>
          requiresBuyerApproval(current, request.amount, this.gateway.executionMode === "AUTONOMOUS") ? "INTERACTIVE" : "AUTONOMOUS",
      },
      actor,
    );

    switch (reservation.kind) {
      case "idempotency_conflict":
        return { kind: "idempotency_conflict", transactionId: reservation.transaction.record.transactionId };
      case "replay":
        return { kind: "transaction", transaction: toResponse(reservation.transaction.record), replayed: true };
      case "blocked": {
        const { record } = reservation.transaction;
        const injection = record.violations.find((v) => v.code === "PROMPT_INJECTION");
        if (injection) {
          // Log identifiers and rule ids only; never echo the attacker's text into logs.
          console.warn("Blocked prompt-injection attempt", {
            transactionId: record.transactionId,
            agentId: agent.id,
            rules: injection.matchedRules,
            fields: injection.fields,
          });
        }
        return { kind: "transaction", transaction: toResponse(record), replayed: false };
      }
      case "reserved":
        return { kind: "transaction", transaction: toResponse(await this.execute(reservation.transaction, actor)), replayed: false };
    }
  }

  private async execute(transaction: StoredTransaction, actor: Actor, from: TransactionStatus[] = ["PROCESSING"]): Promise<TransactionRecord> {
    const { record } = transaction;
    try {
      const outcome = await this.gateway.executePayment({
        amountCents: transaction.amountCents,
        description: record.description,
        referenceId: record.transactionId,
        // The transaction id is the PayPal-Request-Id, so retries reuse the same PayPal order.
        requestId: record.transactionId,
        // Decided under the reservation lock from the agent's server-side policy.
        useVault: record.mode === "AUTONOMOUS",
      });
      if (outcome.status === "PENDING_APPROVAL") {
        return this.settle(
          record.transactionId,
          from,
          { status: "PENDING_APPROVAL", mode: outcome.mode, orderId: outcome.orderId, approvalUrl: outcome.approvalUrl, error: null },
          { actor, action: "PAYPAL_ORDER_CREATED", details: { orderId: outcome.orderId, mode: outcome.mode } },
        );
      }
      return this.applyCaptures(transaction, from, outcome.captures, actor, { mode: outcome.mode, orderId: outcome.orderId });
    } catch (error) {
      return this.settleFailure(record.transactionId, from, error, actor);
    }
  }

  /**
   * Captures an order after the buyer approved it in PayPal. Returns a structured
   * ORDER_NOT_APPROVED result (not an error) when approval is still outstanding.
   * Only one caller can hold the capture claim, so duplicate requests cannot double-capture.
   */
  async captureApprovedOrder(orderId: string, actor: Actor): Promise<CaptureApprovedResult> {
    const claim = await this.store.claimCapture(orderId, actor);
    switch (claim.kind) {
      case "not_found":
        throw new GuardError(404, "ORDER_NOT_FOUND", "No SentinelPay transaction exists for this order");
      case "agent_frozen":
        throw new GuardError(423, "AGENT_FROZEN", "The agent is frozen; captures are refused until it is unfrozen");
      case "invalid_state": {
        const { status } = claim.transaction.record;
        if (status === "COMPLETED" || status === "CAPTURE_PENDING" || status === "DECLINED") {
          return { success: true, transaction: toResponse(claim.transaction.record) };
        }
        if (status === "CAPTURING") {
          throw new GuardError(409, "CAPTURE_IN_PROGRESS", "Another capture for this order is already in progress");
        }
        throw new GuardError(409, "INVALID_TRANSACTION_STATE", `Transaction is ${status} and cannot be captured`);
      }
      case "claimed":
        break;
    }

    const { transaction } = claim;
    const transactionId = transaction.record.transactionId;
    let result;
    try {
      result = await this.gateway.captureOrder({ orderId, requestId: `${transactionId}:capture` });
    } catch (error) {
      if (error instanceof PayPalApiError && error.isRetryable) {
        // Outcome unknown: reopen for retry. The retry reuses the same PayPal-Request-Id,
        // and ORDER_ALREADY_CAPTURED is treated as success, so it cannot double-capture.
        await this.store.transition(
          transactionId,
          ["CAPTURING"],
          { status: "PENDING_APPROVAL", error: describeError(error) },
          { actor, action: "CAPTURE_RETRYABLE_ERROR", details: { debugId: error.debugId } },
        );
        throw error;
      }
      await this.settleFailure(transactionId, ["CAPTURING"], error, actor);
      throw error;
    }

    if (!result.success) {
      const reopened = await this.settle(
        transactionId,
        ["CAPTURING"],
        { status: "PENDING_APPROVAL", ...(result.approvalUrl ? { approvalUrl: result.approvalUrl } : {}) },
        { actor, action: "CAPTURE_NOT_APPROVED" },
      );
      return {
        success: false,
        code: result.code,
        message: result.message,
        approvalUrl: reopened.approvalUrl,
        transaction: toResponse(reopened),
      };
    }
    const settled = await this.applyCaptures(transaction, ["CAPTURING"], result.captures, actor, { approvalUrl: null });
    return { success: true, transaction: toResponse(settled) };
  }

  /** Operator action: cancel a pending or unresolved transaction and release its budget. */
  async cancel(transactionId: string, actor: Actor, reason: string): Promise<TransactionResponse> {
    const cancelled = await this.store.transition(
      transactionId,
      ["PENDING_APPROVAL", "RECONCILE_REQUIRED"],
      { status: "CANCELLED", approvalUrl: null },
      { actor, action: "TRANSACTION_CANCELLED", details: { reason } },
    );
    if (!cancelled) throw await this.stateError(transactionId, "cancelled");
    return toResponse(cancelled.record);
  }

  /**
   * Operator action: resolve a RECONCILE_REQUIRED transaction against PayPal.
   * With a known order id the PayPal order state decides. Without one, the
   * operator must choose: RETRY_CREATE re-sends the original create call with the
   * same PayPal-Request-Id; MARK_FAILED releases the budget (only after checking
   * the PayPal dashboard for a matching payment).
   */
  async reconcile(transactionId: string, actor: Actor, resolution?: ReconcileResolution): Promise<TransactionResponse> {
    const stored = await this.store.getTransaction(transactionId);
    if (!stored) throw new GuardError(404, "TRANSACTION_NOT_FOUND", "No such transaction");
    if (stored.record.status !== "RECONCILE_REQUIRED") {
      throw new GuardError(409, "INVALID_TRANSACTION_STATE", `Transaction is ${stored.record.status}, not RECONCILE_REQUIRED`);
    }

    const from: TransactionStatus[] = ["RECONCILE_REQUIRED"];
    if (stored.record.orderId) {
      const order = await this.gateway.getOrder(stored.record.orderId);
      if (order.status === "COMPLETED") {
        return toResponse(await this.applyCaptures(stored, from, order.captures, actor, { approvalUrl: null }));
      }
      if (order.status === "VOIDED") {
        return toResponse(
          await this.settle(transactionId, from, { status: "CANCELLED", approvalUrl: null }, { actor, action: "RECONCILED", details: { orderStatus: order.status } }),
        );
      }
      return toResponse(
        await this.settle(
          transactionId,
          from,
          { status: "PENDING_APPROVAL", approvalUrl: order.approvalUrl ?? stored.record.approvalUrl },
          { actor, action: "RECONCILED", details: { orderStatus: order.status } },
        ),
      );
    }

    if (resolution === "MARK_FAILED") {
      return toResponse(
        await this.settle(
          transactionId,
          from,
          { status: "FAILED", error: { message: "Marked failed by operator during reconciliation", debugId: null } },
          { actor, action: "RECONCILED", details: { resolution } },
        ),
      );
    }
    if (resolution === "RETRY_CREATE") {
      return toResponse(await this.execute(stored, actor, from));
    }
    throw new GuardError(
      409,
      "RESOLUTION_REQUIRED",
      "No PayPal order id was recorded; choose resolution RETRY_CREATE or MARK_FAILED after checking the PayPal dashboard",
    );
  }

  /** Releases expired approvals and flags abandoned in-flight work. Safe to run on every instance. */
  async sweep(staleInFlightMs: number): Promise<{ expired: number; flagged: number }> {
    const expired = await this.store.expirePendingApprovals(this.pendingApprovalTtlMs);
    const flagged = await this.store.flagStaleInFlight(staleInFlightMs);
    return { expired, flagged };
  }

  async summary(): Promise<SpendingSummary> {
    const spend = await this.store.spendingToday();
    const used = spend.reservedCents + spend.committedCents;
    return {
      executionMode: this.gateway.executionMode,
      currency: "USD",
      budgetDay: spend.budgetDay,
      globalPerTransactionCap: formatCents(this.global.perTransactionCapCents),
      globalDailyCap: formatCents(this.global.dailyCapCents),
      committedToday: formatCents(spend.committedCents),
      reservedToday: formatCents(spend.reservedCents),
      remainingToday: formatCents(Math.max(this.global.dailyCapCents - used, 0)),
    };
  }

  // ----- helpers ----------------------------------------------------------

  private async applyCaptures(
    transaction: StoredTransaction,
    from: TransactionStatus[],
    captures: CaptureDetails[],
    actor: Actor,
    extra: { mode?: TransactionRecord["mode"] & {}; orderId?: string; approvalUrl?: null },
  ): Promise<TransactionRecord> {
    const capture = captures.find((c) => c.status === "COMPLETED") ?? captures[0];
    const expectedValue = formatCents(transaction.amountCents);

    // PayPal must have captured exactly what policy approved; anything else needs a human.
    if (capture && capture.amount && (capture.amount.value !== expectedValue || capture.amount.currency_code !== "USD")) {
      return this.settle(
        transaction.record.transactionId,
        from,
        {
          ...extra,
          status: "RECONCILE_REQUIRED",
          captureId: capture.captureId,
          error: { message: `Captured ${capture.amount.currency_code} ${capture.amount.value} but $${expectedValue} was approved`, debugId: null },
        },
        { actor, action: "CAPTURE_AMOUNT_MISMATCH", details: { captureId: capture.captureId } },
      );
    }

    let status: TransactionStatus;
    switch (capture?.status) {
      case "COMPLETED":
        status = "COMPLETED";
        break;
      case "PARTIALLY_REFUNDED":
      case "REFUNDED":
        status = "REFUNDED";
        break;
      case "PENDING":
        status = "CAPTURE_PENDING";
        break;
      case "DECLINED":
      case "FAILED":
        status = "DECLINED";
        break;
      default:
        status = "RECONCILE_REQUIRED";
    }
    return this.settle(
      transaction.record.transactionId,
      from,
      {
        ...extra,
        status,
        captureId: capture?.captureId ?? null,
        error:
          status === "RECONCILE_REQUIRED"
            ? { message: "PayPal returned no capture for this order", debugId: null }
            : status === "DECLINED"
              ? { message: `Capture declined${capture?.statusReason ? `: ${capture.statusReason}` : ""}`, debugId: null }
              : null,
      },
      { actor, action: "PAYMENT_CAPTURED", details: { captureId: capture?.captureId ?? null, captureStatus: capture?.status ?? null } },
    );
  }

  /** Records a PayPal failure: unknown outcomes keep the budget reserved; definite failures release it. */
  private settleFailure(transactionId: string, from: TransactionStatus[], error: unknown, actor: Actor): Promise<TransactionRecord> {
    const unknownOutcome = error instanceof PayPalApiError && error.isRetryable;
    return this.settle(
      transactionId,
      from,
      { status: unknownOutcome ? "RECONCILE_REQUIRED" : "FAILED", error: describeError(error) },
      {
        actor,
        action: unknownOutcome ? "RECONCILE_REQUIRED" : "PAYMENT_FAILED",
        details: { debugId: error instanceof PayPalApiError ? error.debugId : null },
      },
    );
  }

  private async settle(
    transactionId: string,
    from: TransactionStatus[],
    changes: Parameters<LedgerStore["transition"]>[2],
    note: Parameters<LedgerStore["transition"]>[3],
  ): Promise<TransactionRecord> {
    const updated = await this.store.transition(transactionId, from, changes, note);
    if (updated) return updated.record;
    // Another actor (e.g. the sweeper) moved it first; report the current state.
    const current = await this.store.getTransaction(transactionId);
    if (!current) throw new GuardError(404, "TRANSACTION_NOT_FOUND", "No such transaction");
    return current.record;
  }

  private async stateError(transactionId: string, verb: string): Promise<GuardError> {
    const current = await this.store.getTransaction(transactionId);
    if (!current) return new GuardError(404, "TRANSACTION_NOT_FOUND", "No such transaction");
    return new GuardError(409, "INVALID_TRANSACTION_STATE", `Transaction is ${current.record.status} and cannot be ${verb}`);
  }
}

export function toResponse(record: TransactionRecord): TransactionResponse {
  return { ...record, message: STATUS_MESSAGES[record.status] };
}

/** Identifies the economic content of a request, so an idempotency key cannot be reused for a different purchase. */
function fingerprint(request: TransactionRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        amountCents: request.amount,
        currency: request.currency,
        merchantId: request.merchantId,
        merchantName: request.merchantName ?? null,
        category: request.category,
        description: request.description,
      }),
    )
    .digest("hex");
}

function describeError(error: unknown): TransactionError {
  if (error instanceof PayPalApiError) return { message: error.message, debugId: error.debugId };
  return { message: error instanceof Error ? error.message : String(error), debugId: null };
}
