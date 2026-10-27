/** Shared domain types used across the PayPal service, policy engine, ledger store and routes. */

export type Currency = "USD";

/** AUTONOMOUS pays with a vaulted payment source; INTERACTIVE needs a buyer to approve each order. */
export type ExecutionMode = "AUTONOMOUS" | "INTERACTIVE";

/**
 * Transaction lifecycle. Each status maps to exactly one budget state
 * (enforced by a database CHECK constraint, mirrored in BUDGET_STATE_BY_STATUS).
 */
export type TransactionStatus =
  | "BLOCKED"
  | "PROCESSING"
  | "PENDING_APPROVAL"
  | "CAPTURING"
  | "RECONCILE_REQUIRED"
  | "CAPTURE_PENDING"
  | "COMPLETED"
  | "REFUNDED"
  | "DECLINED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

/**
 * NONE: never counted (blocked before reservation).
 * RESERVED: counts against the cap while the outcome is unknown.
 * COMMITTED: money moved; counts against the cap (refunds do not restore budget).
 * RELEASED: payment did not happen; no longer counts.
 */
export type BudgetState = "NONE" | "RESERVED" | "COMMITTED" | "RELEASED";

export const BUDGET_STATE_BY_STATUS: Readonly<Record<TransactionStatus, BudgetState>> = {
  BLOCKED: "NONE",
  PROCESSING: "RESERVED",
  PENDING_APPROVAL: "RESERVED",
  CAPTURING: "RESERVED",
  RECONCILE_REQUIRED: "RESERVED",
  CAPTURE_PENDING: "COMMITTED",
  COMPLETED: "COMMITTED",
  REFUNDED: "COMMITTED",
  DECLINED: "RELEASED",
  FAILED: "RELEASED",
  EXPIRED: "RELEASED",
  CANCELLED: "RELEASED",
};

export type PolicyCode =
  | "AGENT_FROZEN"
  | "MERCHANT_NOT_ALLOWED"
  | "CATEGORY_NOT_ALLOWED"
  | "PER_TRANSACTION_CAP"
  | "GLOBAL_PER_TRANSACTION_CAP"
  | "DAILY_SPENDING_CAP"
  | "GLOBAL_DAILY_SPENDING_CAP"
  | "PROMPT_INJECTION";

export interface PolicyViolation {
  code: PolicyCode;
  message: string;
  /** Spending rules: the configured limit, as a USD amount. */
  limit?: string;
  /** Spending rules: the amount that would have been reached. */
  attempted?: string;
  /** PROMPT_INJECTION: ids of the detection rules that matched. */
  matchedRules?: string[];
  /** PROMPT_INJECTION: request fields that triggered a match. */
  fields?: string[];
}

export interface TransactionError {
  message: string;
  debugId: string | null;
}

export interface TransactionRecord {
  transactionId: string;
  agentId: string;
  requestId: string;
  merchantId: string;
  merchantName: string | null;
  category: string;
  description: string;
  amount: string;
  currency: Currency;
  status: TransactionStatus;
  budgetState: BudgetState;
  mode: ExecutionMode | null;
  orderId: string | null;
  captureId: string | null;
  approvalUrl: string | null;
  violations: PolicyViolation[];
  error: TransactionError | null;
  createdAt: string;
  updatedAt: string;
}

export type TransactionResponse = TransactionRecord & { message: string };

export type CaptureApprovedResult =
  | { success: true; transaction: TransactionResponse }
  | {
      success: false;
      code: "ORDER_NOT_APPROVED";
      message: string;
      approvalUrl: string | null;
      transaction: TransactionResponse;
    };

export interface AgentPolicy {
  agentId: string;
  displayName: string;
  apiKeyPrefix: string;
  perTransactionCap: string;
  dailyCap: string;
  /** Payments up to this amount skip buyer approval when a vault is configured; "0.00" = never. */
  autonomousLimit: string;
  /** null = any merchant; [] = none. */
  allowedMerchants: string[] | null;
  /** null = any category; [] = none. */
  allowedCategories: string[] | null;
  frozen: boolean;
  frozenReason: string | null;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpendingSummary {
  /** AUTONOMOUS = a vaulted source is configured (per-agent limits still apply). */
  executionMode: ExecutionMode;
  currency: Currency;
  budgetDay: string;
  globalPerTransactionCap: string;
  globalDailyCap: string;
  committedToday: string;
  reservedToday: string;
  remainingToday: string;
}

/** ADMIN appears only on events written before named operator accounts existed. */
export type ActorType = "AGENT" | "ADMIN" | "OPERATOR" | "SYSTEM";

export type OperatorRole = "VIEWER" | "AUDITOR" | "OPERATOR" | "ADMIN";

export interface OperatorAccount {
  operatorId: string;
  displayName: string;
  role: OperatorRole;
  apiKeyPrefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Actor {
  type: ActorType;
  id: string;
}

export interface AuditEvent {
  seq: number;
  occurredAt: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  agentId: string | null;
  transactionId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  valid: boolean;
  eventsChecked: number;
  headSeq: number | null;
  headHash: string | null;
  /** First event whose stored hash or link does not match the recomputed chain. */
  firstInvalidSeq: number | null;
  reason: string | null;
}
