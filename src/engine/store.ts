import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db, DbClient } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import {
  BUDGET_STATE_BY_STATUS,
  type Actor,
  type AgentPolicy,
  type ExecutionMode,
  type PolicyViolation,
  type TransactionError,
  type TransactionRecord,
  type TransactionStatus,
} from "../models/types.js";
import { appendAudit } from "./audit.js";
import { formatCents, type AgentLimits } from "./policy.js";

/** Serializes budget reservations across every process sharing the database. */
const BUDGET_LOCK_KEY = 72_017_002;
const AGENT_KEY_PREFIX = "sp_agent_";

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  display_name: string;
  api_key_hash: string;
  api_key_prefix: string;
  per_transaction_cap_cents: number;
  daily_cap_cents: number;
  autonomous_limit_cents: number;
  allowed_merchants: string[] | null;
  allowed_categories: string[] | null;
  frozen: boolean;
  frozen_reason: string | null;
  frozen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  agent_id: string;
  request_id: string;
  request_fingerprint: string;
  merchant_id: string;
  merchant_name: string | null;
  category: string;
  description: string;
  amount_cents: number;
  currency: "USD";
  status: TransactionStatus;
  budget_state: TransactionRecord["budgetState"];
  budget_day: string;
  mode: ExecutionMode | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  approval_url: string | null;
  violations: PolicyViolation[];
  error: TransactionError | null;
  created_at: Date;
  updated_at: Date;
}

export interface StoredTransaction {
  record: TransactionRecord;
  amountCents: number;
  fingerprint: string;
}

export interface Agent extends AgentLimits {
  id: string;
  displayName: string;
}

function toRecord(row: TransactionRow): TransactionRecord {
  return {
    transactionId: row.id,
    agentId: row.agent_id,
    requestId: row.request_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    category: row.category,
    description: row.description,
    amount: formatCents(row.amount_cents),
    currency: row.currency,
    status: row.status,
    budgetState: row.budget_state,
    mode: row.mode,
    orderId: row.paypal_order_id,
    captureId: row.paypal_capture_id,
    approvalUrl: row.approval_url,
    violations: row.violations,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toStored(row: TransactionRow): StoredTransaction {
  return { record: toRecord(row), amountCents: row.amount_cents, fingerprint: row.request_fingerprint };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    displayName: row.display_name,
    frozen: row.frozen,
    frozenReason: row.frozen_reason,
    perTransactionCapCents: row.per_transaction_cap_cents,
    dailyCapCents: row.daily_cap_cents,
    autonomousLimitCents: row.autonomous_limit_cents,
    allowedMerchants: row.allowed_merchants,
    allowedCategories: row.allowed_categories,
  };
}

function toPolicy(row: AgentRow): AgentPolicy {
  return {
    agentId: row.id,
    displayName: row.display_name,
    apiKeyPrefix: row.api_key_prefix,
    perTransactionCap: formatCents(row.per_transaction_cap_cents),
    dailyCap: formatCents(row.daily_cap_cents),
    autonomousLimit: formatCents(row.autonomous_limit_cents),
    allowedMerchants: row.allowed_merchants,
    allowedCategories: row.allowed_categories,
    frozen: row.frozen,
    frozenReason: row.frozen_reason,
    frozenAt: row.frozen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function generateAgentKey(): { apiKey: string; hash: string; prefix: string } {
  const apiKey = `${AGENT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { apiKey, hash: hashApiKey(apiKey), prefix: apiKey.slice(0, AGENT_KEY_PREFIX.length + 6) };
}

// ---------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------

export interface ReserveInput {
  agentId: string;
  requestId: string;
  fingerprint: string;
  amountCents: number;
  merchantId: string;
  merchantName: string | null;
  category: string;
  description: string;
  /** Violations found before reservation (e.g. prompt injection); recorded as BLOCKED. */
  preViolations: PolicyViolation[];
  evaluate: (agent: Agent, agentSpentTodayCents: number, globalSpentTodayCents: number) => PolicyViolation[];
  /** Decides vault vs buyer approval from the locked, current agent row. */
  decideMode: (agent: Agent) => ExecutionMode;
}

export type ReserveResult =
  | { kind: "reserved"; transaction: StoredTransaction }
  | { kind: "blocked"; transaction: StoredTransaction }
  | { kind: "replay"; transaction: StoredTransaction }
  | { kind: "idempotency_conflict"; transaction: StoredTransaction };

export interface TransitionChanges {
  status: TransactionStatus;
  mode?: ExecutionMode;
  orderId?: string;
  captureId?: string | null;
  approvalUrl?: string | null;
  error?: TransactionError | null;
}

export interface AuditNote {
  actor: Actor;
  action: string;
  details?: Record<string, unknown>;
}

export type CaptureClaim =
  | { kind: "claimed"; transaction: StoredTransaction }
  | { kind: "not_found" }
  | { kind: "agent_frozen"; transaction: StoredTransaction }
  | { kind: "invalid_state"; transaction: StoredTransaction };

export interface AgentPolicyInput {
  displayName: string;
  perTransactionCapCents: number;
  dailyCapCents: number;
  autonomousLimitCents: number;
  allowedMerchants: string[] | null;
  allowedCategories: string[] | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** PostgreSQL-backed ledger; the single accounting authority for SentinelPay. */
export class LedgerStore {
  constructor(private readonly db: Db) {}

  // ----- agents -----------------------------------------------------------

  async createAgent(agentId: string, policy: AgentPolicyInput, actor: Actor): Promise<{ agent: AgentPolicy; apiKey: string }> {
    const key = generateAgentKey();
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<AgentRow>(
        `INSERT INTO agents (id, display_name, api_key_hash, api_key_prefix, per_transaction_cap_cents, daily_cap_cents,
                             autonomous_limit_cents, allowed_merchants, allowed_categories)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          agentId,
          policy.displayName,
          key.hash,
          key.prefix,
          policy.perTransactionCapCents,
          policy.dailyCapCents,
          policy.autonomousLimitCents,
          policy.allowedMerchants,
          policy.allowedCategories,
        ],
      );
      const agent = toPolicy(rows[0]!);
      await appendAudit(client, { actor, action: "AGENT_CREATED", agentId, details: { policy: policySnapshot(agent) } });
      return { agent, apiKey: key.apiKey };
    });
  }

  async findAgentByApiKey(apiKey: string): Promise<Agent | null> {
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE api_key_hash = $1", [hashApiKey(apiKey)]);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async getAgentPolicy(agentId: string): Promise<AgentPolicy | null> {
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [agentId]);
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  async listAgents(): Promise<AgentPolicy[]> {
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents ORDER BY id");
    return rows.map(toPolicy);
  }

  async updateAgentPolicy(agentId: string, policy: AgentPolicyInput, actor: Actor): Promise<AgentPolicy | null> {
    return withTransaction(this.db, async (client) => {
      const before = await client.query<AgentRow>("SELECT * FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
      if (!before.rows[0]) return null;
      const { rows } = await client.query<AgentRow>(
        `UPDATE agents SET display_name = $2, per_transaction_cap_cents = $3, daily_cap_cents = $4,
                allowed_merchants = $5, allowed_categories = $6, autonomous_limit_cents = $7, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          agentId,
          policy.displayName,
          policy.perTransactionCapCents,
          policy.dailyCapCents,
          policy.allowedMerchants,
          policy.allowedCategories,
          policy.autonomousLimitCents,
        ],
      );
      const agent = toPolicy(rows[0]!);
      await appendAudit(client, {
        actor,
        action: "AGENT_POLICY_UPDATED",
        agentId,
        details: { before: policySnapshot(toPolicy(before.rows[0])), after: policySnapshot(agent) },
      });
      return agent;
    });
  }

  async setFrozen(agentId: string, frozen: boolean, reason: string | null, actor: Actor): Promise<AgentPolicy | null> {
    return withTransaction(this.db, async (client) => {
      // Row lock: waits for in-flight reservations holding FOR SHARE, so once this
      // commits no new reservation for the agent can pass the freeze check.
      const { rows } = await client.query<AgentRow>(
        `UPDATE agents SET frozen = $2, frozen_reason = $3, frozen_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [agentId, frozen, frozen ? reason : null],
      );
      if (!rows[0]) return null;
      await appendAudit(client, {
        actor,
        action: frozen ? "AGENT_FROZEN" : "AGENT_UNFROZEN",
        agentId,
        details: frozen ? { reason } : {},
      });
      return toPolicy(rows[0]);
    });
  }

  async rotateAgentKey(agentId: string, actor: Actor): Promise<{ agent: AgentPolicy; apiKey: string } | null> {
    const key = generateAgentKey();
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<AgentRow>(
        "UPDATE agents SET api_key_hash = $2, api_key_prefix = $3, updated_at = now() WHERE id = $1 RETURNING *",
        [agentId, key.hash, key.prefix],
      );
      if (!rows[0]) return null;
      await appendAudit(client, { actor, action: "AGENT_KEY_ROTATED", agentId, details: { apiKeyPrefix: key.prefix } });
      return { agent: toPolicy(rows[0]), apiKey: key.apiKey };
    });
  }

  // ----- reservations -----------------------------------------------------

  /**
   * Atomically: replays an existing request, or evaluates policy against today's
   * reserved+committed spend and inserts the transaction as PROCESSING (budget
   * reserved) or BLOCKED. Serialized by a database advisory lock, so concurrent
   * requests on any number of server instances cannot overspend.
   */
  async reserve(input: ReserveInput, actor: Actor): Promise<ReserveResult> {
    return withTransaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_LOCK_KEY]);

      const existing = await client.query<TransactionRow>(
        "SELECT * FROM transactions WHERE agent_id = $1 AND request_id = $2",
        [input.agentId, input.requestId],
      );
      if (existing.rows[0]) {
        const transaction = toStored(existing.rows[0]);
        if (transaction.fingerprint !== input.fingerprint) {
          await appendAudit(client, {
            actor,
            action: "IDEMPOTENCY_KEY_CONFLICT",
            agentId: input.agentId,
            transactionId: transaction.record.transactionId,
            details: { requestId: input.requestId },
          });
          return { kind: "idempotency_conflict", transaction };
        }
        return { kind: "replay", transaction };
      }

      const agentRow = await client.query<AgentRow>("SELECT * FROM agents WHERE id = $1 FOR SHARE", [input.agentId]);
      if (!agentRow.rows[0]) throw new Error(`Agent ${input.agentId} does not exist`);
      const agent = toAgent(agentRow.rows[0]);

      const { rows: dayRows } = await client.query<{ day: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day");
      const budgetDay = dayRows[0]!.day;
      const { rows: spend } = await client.query<{ agent_cents: number; global_cents: number }>(
        `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE agent_id = $2), 0)::bigint AS agent_cents,
                COALESCE(SUM(amount_cents), 0)::bigint AS global_cents
         FROM transactions
         WHERE budget_day = $1 AND budget_state IN ('RESERVED', 'COMMITTED')`,
        [budgetDay, input.agentId],
      );
      const violations = [...input.preViolations, ...input.evaluate(agent, spend[0]!.agent_cents, spend[0]!.global_cents)];
      const status: TransactionStatus = violations.length > 0 ? "BLOCKED" : "PROCESSING";
      // Recorded at reservation, so retries and reconciliation reuse the same decision.
      const mode = status === "BLOCKED" ? null : input.decideMode(agent);

      const { rows } = await client.query<TransactionRow>(
        `INSERT INTO transactions (id, agent_id, request_id, request_fingerprint, merchant_id, merchant_name, category, description,
                                   amount_cents, currency, status, budget_state, budget_day, violations, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', $10, $11, $12, $13, $14) RETURNING *`,
        [
          randomUUID(),
          input.agentId,
          input.requestId,
          input.fingerprint,
          input.merchantId,
          input.merchantName,
          input.category,
          input.description,
          input.amountCents,
          status,
          BUDGET_STATE_BY_STATUS[status],
          budgetDay,
          JSON.stringify(violations),
          mode,
        ],
      );
      const transaction = toStored(rows[0]!);
      await appendAudit(client, {
        actor,
        action: status === "BLOCKED" ? "TRANSACTION_BLOCKED" : "BUDGET_RESERVED",
        agentId: input.agentId,
        transactionId: transaction.record.transactionId,
        details: {
          amount: transaction.record.amount,
          merchantId: input.merchantId,
          category: input.category,
          ...(mode ? { mode } : {}),
          violations: violations.map((v) => ({ code: v.code, ...(v.matchedRules ? { matchedRules: v.matchedRules } : {}) })),
        },
      });
      return { kind: status === "BLOCKED" ? "blocked" : "reserved", transaction };
    });
  }

  // ----- state transitions ------------------------------------------------

  /**
   * Moves a transaction to a new status only if it is currently in one of `from`
   * (compare-and-set). Returns null when another actor already moved it.
   */
  async transition(transactionId: string, from: TransactionStatus[], changes: TransitionChanges, note: AuditNote): Promise<StoredTransaction | null> {
    return withTransaction(this.db, (client) => this.transitionIn(client, transactionId, from, changes, note));
  }

  private async transitionIn(
    client: DbClient,
    transactionId: string,
    from: TransactionStatus[],
    changes: TransitionChanges,
    note: AuditNote,
  ): Promise<StoredTransaction | null> {
    const sets = ["status = $3", "budget_state = $4", "updated_at = now()"];
    const params: unknown[] = [transactionId, from, changes.status, BUDGET_STATE_BY_STATUS[changes.status]];
    const set = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (changes.mode !== undefined) set("mode", changes.mode);
    if (changes.orderId !== undefined) set("paypal_order_id", changes.orderId);
    if (changes.captureId !== undefined) set("paypal_capture_id", changes.captureId);
    if (changes.approvalUrl !== undefined) set("approval_url", changes.approvalUrl);
    if (changes.error !== undefined) set("error", changes.error === null ? null : JSON.stringify(changes.error));

    const { rows } = await client.query<TransactionRow>(
      `UPDATE transactions SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2) RETURNING *`,
      params,
    );
    if (!rows[0]) return null;
    const transaction = toStored(rows[0]);
    await appendAudit(client, {
      actor: note.actor,
      action: note.action,
      agentId: transaction.record.agentId,
      transactionId,
      details: { status: changes.status, ...(note.details ?? {}) },
    });
    return transaction;
  }

  /**
   * Claims a PENDING_APPROVAL order for capture (PENDING_APPROVAL -> CAPTURING) so
   * only one caller across all instances proceeds to PayPal. Agents may only
   * claim their own orders; frozen agents cannot capture.
   */
  async claimCapture(orderId: string, actor: Actor): Promise<CaptureClaim> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<TransactionRow>(
        "SELECT * FROM transactions WHERE paypal_order_id = $1 FOR UPDATE",
        [orderId],
      );
      const row = rows[0];
      // Agents probing another agent's order get the same answer as a missing order.
      if (!row || (actor.type === "AGENT" && row.agent_id !== actor.id)) return { kind: "not_found" };
      const transaction = toStored(row);

      const agent = await client.query<{ frozen: boolean }>("SELECT frozen FROM agents WHERE id = $1 FOR SHARE", [row.agent_id]);
      if (agent.rows[0]?.frozen && row.status === "PENDING_APPROVAL") {
        await appendAudit(client, {
          actor,
          action: "CAPTURE_REFUSED_AGENT_FROZEN",
          agentId: row.agent_id,
          transactionId: row.id,
        });
        return { kind: "agent_frozen", transaction };
      }
      if (row.status !== "PENDING_APPROVAL") return { kind: "invalid_state", transaction };

      const claimed = await this.transitionIn(client, row.id, ["PENDING_APPROVAL"], { status: "CAPTURING" }, { actor, action: "CAPTURE_STARTED" });
      return claimed ? { kind: "claimed", transaction: claimed } : { kind: "invalid_state", transaction };
    });
  }

  /** Releases budget held by approvals that were never completed in time. */
  async expirePendingApprovals(ttlMs: number): Promise<number> {
    return this.sweep(
      "PENDING_APPROVAL",
      "EXPIRED",
      "created_at < now() - ($1::bigint * interval '1 millisecond')",
      ttlMs,
      "APPROVAL_EXPIRED",
      { approval_url: null },
    );
  }

  /**
   * Flags work abandoned mid-flight (e.g. the process crashed while calling PayPal).
   * The budget stays reserved until an operator reconciles it against PayPal.
   */
  async flagStaleInFlight(staleAfterMs: number): Promise<number> {
    const processing = await this.sweep(
      "PROCESSING",
      "RECONCILE_REQUIRED",
      "updated_at < now() - ($1::bigint * interval '1 millisecond')",
      staleAfterMs,
      "RECONCILE_REQUIRED",
      {},
    );
    const capturing = await this.sweep(
      "CAPTURING",
      "RECONCILE_REQUIRED",
      "updated_at < now() - ($1::bigint * interval '1 millisecond')",
      staleAfterMs,
      "RECONCILE_REQUIRED",
      {},
    );
    return processing + capturing;
  }

  private async sweep(
    from: TransactionStatus,
    to: TransactionStatus,
    condition: string,
    param: number,
    action: string,
    extra: { approval_url?: null },
  ): Promise<number> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<{ id: string; agent_id: string }>(
        `UPDATE transactions SET status = '${to}', budget_state = '${BUDGET_STATE_BY_STATUS[to]}', updated_at = now()
           ${"approval_url" in extra ? ", approval_url = NULL" : ""}
         WHERE status = '${from}' AND ${condition} RETURNING id, agent_id`,
        [param],
      );
      for (const row of rows) {
        await appendAudit(client, {
          actor: { type: "SYSTEM", id: "sweeper" },
          action,
          agentId: row.agent_id,
          transactionId: row.id,
          details: { from, status: to },
        });
      }
      return rows.length;
    });
  }

  // ----- queries ----------------------------------------------------------

  async getTransaction(transactionId: string): Promise<StoredTransaction | null> {
    const { rows } = await this.db.query<TransactionRow>("SELECT * FROM transactions WHERE id = $1", [transactionId]);
    return rows[0] ? toStored(rows[0]) : null;
  }

  async listTransactions(filter: { agentId?: string; status?: TransactionStatus; limit: number }): Promise<TransactionRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) {
      params.push(filter.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    params.push(filter.limit);
    const { rows } = await this.db.query<TransactionRow>(
      `SELECT * FROM transactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRecord);
  }

  async spendingToday(agentId?: string): Promise<{ budgetDay: string; reservedCents: number; committedCents: number }> {
    const { rows } = await this.db.query<{ day: string; reserved: number; committed: number }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              COALESCE(SUM(amount_cents) FILTER (WHERE budget_state = 'RESERVED'), 0)::bigint AS reserved,
              COALESCE(SUM(amount_cents) FILTER (WHERE budget_state = 'COMMITTED'), 0)::bigint AS committed
       FROM transactions
       WHERE budget_day = (now() AT TIME ZONE 'UTC')::date AND ($1::text IS NULL OR agent_id = $1)`,
      [agentId ?? null],
    );
    const row = rows[0]!;
    return { budgetDay: row.day, reservedCents: row.reserved, committedCents: row.committed };
  }
}

function policySnapshot(agent: AgentPolicy): Record<string, unknown> {
  return {
    perTransactionCap: agent.perTransactionCap,
    dailyCap: agent.dailyCap,
    autonomousLimit: agent.autonomousLimit,
    allowedMerchants: agent.allowedMerchants,
    allowedCategories: agent.allowedCategories,
  };
}
