import { createHash } from "node:crypto";
import type { Db, DbClient } from "../db/pool.js";
import type { Actor, AuditEvent, AuditVerification } from "../models/types.js";

/**
 * Hash-chained audit log. Each event's hash covers its content plus the previous
 * event's hash, so editing, deleting or reordering a stored event breaks the chain
 * from that point on.
 *
 * Limitations: this is tamper-evident, not immutable. Someone with write access to
 * the database can rewrite the whole chain consistently from the edited event
 * onward; detecting that requires comparing the head hash against a copy kept
 * outside the database (see AuditVerification.headHash).
 */

export const GENESIS_HASH = "0".repeat(64);
/** Serializes appends so each event links to the true previous head. Always the last lock taken. */
const AUDIT_CHAIN_LOCK_KEY = 72_017_003;

export interface AuditInput {
  actor: Actor;
  action: string;
  agentId?: string | null;
  transactionId?: string | null;
  details?: Record<string, unknown>;
}

interface AuditRow {
  seq: number;
  occurred_at: Date;
  actor_type: Actor["type"];
  actor_id: string;
  action: string;
  agent_id: string | null;
  transaction_id: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

/** Appends an event inside the caller's transaction, so it commits or rolls back with the change it records. */
export async function appendAudit(client: DbClient, input: AuditInput): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_CHAIN_LOCK_KEY]);
  const { rows } = await client.query<{ hash: string }>("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
  const prevHash = rows[0]?.hash ?? GENESIS_HASH;

  const event = {
    occurredAt: new Date().toISOString(),
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: input.action,
    agentId: input.agentId ?? null,
    transactionId: input.transactionId ?? null,
    details: input.details ?? {},
  };
  const hash = computeHash(prevHash, event);

  await client.query(
    `INSERT INTO audit_events (occurred_at, actor_type, actor_id, action, agent_id, transaction_id, details, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [event.occurredAt, event.actorType, event.actorId, event.action, event.agentId, event.transactionId, event.details, prevHash, hash],
  );
}

export async function listAudit(db: Db, options: { limit: number; transactionId?: string }): Promise<AuditEvent[]> {
  const { rows } = options.transactionId
    ? await db.query<AuditRow>("SELECT * FROM audit_events WHERE transaction_id = $1 ORDER BY seq DESC LIMIT $2", [
        options.transactionId,
        options.limit,
      ])
    : await db.query<AuditRow>("SELECT * FROM audit_events ORDER BY seq DESC LIMIT $1", [options.limit]);
  return rows.map(toEvent);
}

/** Recomputes the whole chain and reports the first event that does not match. */
export async function verifyAuditChain(db: Db): Promise<AuditVerification> {
  const { rows } = await db.query<AuditRow>("SELECT * FROM audit_events ORDER BY seq ASC");
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    const event = toEvent(row);
    if (event.prevHash !== expectedPrev) {
      return invalid(rows.length, event.seq, "prev_hash does not link to the preceding event (event removed, reordered or inserted)");
    }
    if (computeHash(event.prevHash, event) !== event.hash) {
      return invalid(rows.length, event.seq, "stored hash does not match event content (event modified)");
    }
    expectedPrev = event.hash;
  }
  const head = rows.at(-1);
  return {
    valid: true,
    eventsChecked: rows.length,
    headSeq: head ? Number(head.seq) : null,
    headHash: head?.hash ?? null,
    firstInvalidSeq: null,
    reason: null,
  };
}

function invalid(count: number, seq: number, reason: string): AuditVerification {
  return { valid: false, eventsChecked: count, headSeq: null, headHash: null, firstInvalidSeq: seq, reason };
}

function computeHash(
  prevHash: string,
  event: Pick<AuditEvent, "occurredAt" | "actorType" | "actorId" | "action" | "agentId" | "transactionId" | "details">,
): string {
  const payload = canonicalJson({
    occurredAt: event.occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    agentId: event.agentId,
    transactionId: event.transactionId,
    details: event.details,
  });
  return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

/** JSON with object keys sorted recursively, so jsonb's key reordering does not change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function toEvent(row: AuditRow): AuditEvent {
  return {
    seq: Number(row.seq),
    occurredAt: row.occurred_at.toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    agentId: row.agent_id,
    transactionId: row.transaction_id,
    details: row.details,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
