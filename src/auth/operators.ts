import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import { appendAudit } from "../engine/audit.js";
import type { Actor, OperatorAccount, OperatorRole } from "../models/types.js";

export const OPERATOR_KEY_PREFIX = "sp_op_";
export const OPERATOR_KEY_PATTERN = /^sp_op_[A-Za-z0-9_-]{43}$/;

/**
 * Role-based permissions for the operator API. Freezing is an emergency brake any
 * OPERATOR can pull; resuming (unfreeze), policy changes and credential management
 * are ADMIN-only. Audit access is limited to AUDITOR and ADMIN.
 */
export const PERMISSIONS = {
  "dashboard:read": ["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"],
  "payments:operate": ["OPERATOR", "ADMIN"],
  "agents:freeze": ["OPERATOR", "ADMIN"],
  "agents:unfreeze": ["ADMIN"],
  "agents:manage": ["ADMIN"],
  "audit:read": ["AUDITOR", "ADMIN"],
  "audit:checkpoint": ["AUDITOR", "ADMIN"],
  "operators:manage": ["ADMIN"],
  /** Talk to the in-app AI purchasing assistant, which submits intents as a chosen agent. */
  "assistant:use": ["OPERATOR", "ADMIN"],
} as const satisfies Record<string, readonly OperatorRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: OperatorRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly OperatorRole[]).includes(role);
}

interface OperatorRow {
  id: string;
  display_name: string;
  role: OperatorRole;
  api_key_hash: string;
  api_key_prefix: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_used_at: Date | null;
  created_by: string;
  created_at: Date;
}

export interface AuthenticatedOperator {
  id: string;
  role: OperatorRole;
}

export type OperatorAuthResult =
  | { ok: true; operator: AuthenticatedOperator }
  | { ok: false; reason: "UNKNOWN_KEY" | "REVOKED" | "EXPIRED"; operatorId: string | null };

function toAccount(row: OperatorRow): OperatorAccount {
  return {
    operatorId: row.id,
    displayName: row.display_name,
    role: row.role,
    apiKeyPrefix: row.api_key_prefix,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function hashKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function generateKey(): { apiKey: string; hash: string; prefix: string } {
  const apiKey = `${OPERATOR_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { apiKey, hash: hashKey(apiKey), prefix: apiKey.slice(0, OPERATOR_KEY_PREFIX.length + 6) };
}

export class OperatorError extends Error {
  override readonly name = "OperatorError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Named operator credentials: hashed at rest, revocable, optionally expiring, every change audited. */
export class OperatorStore {
  constructor(private readonly db: Db) {}

  async authenticate(apiKey: string): Promise<OperatorAuthResult> {
    const { rows } = await this.db.query<OperatorRow>("SELECT * FROM operators WHERE api_key_hash = $1", [hashKey(apiKey)]);
    const row = rows[0];
    if (!row) return { ok: false, reason: "UNKNOWN_KEY", operatorId: null };
    if (row.revoked_at) return { ok: false, reason: "REVOKED", operatorId: row.id };
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "EXPIRED", operatorId: row.id };
    // Coarse last-used tracking (at most one write per minute per operator).
    await this.db.query(
      "UPDATE operators SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
      [row.id],
    );
    return { ok: true, operator: { id: row.id, role: row.role } };
  }

  async get(operatorId: string): Promise<OperatorAccount | null> {
    const { rows } = await this.db.query<OperatorRow>("SELECT * FROM operators WHERE id = $1", [operatorId]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async list(): Promise<OperatorAccount[]> {
    const { rows } = await this.db.query<OperatorRow>("SELECT * FROM operators ORDER BY id");
    return rows.map(toAccount);
  }

  async create(
    input: { operatorId: string; displayName: string; role: OperatorRole; expiresAt: Date | null },
    actor: Actor,
  ): Promise<{ operator: OperatorAccount; apiKey: string }> {
    const key = generateKey();
    return withTransaction(this.db, async (client) => {
      const existing = await client.query("SELECT 1 FROM operators WHERE id = $1", [input.operatorId]);
      if (existing.rowCount) throw new OperatorError(409, "OPERATOR_EXISTS", "An operator with this id already exists");
      const { rows } = await client.query<OperatorRow>(
        `INSERT INTO operators (id, display_name, role, api_key_hash, api_key_prefix, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [input.operatorId, input.displayName, input.role, key.hash, key.prefix, input.expiresAt, actor.id],
      );
      const operator = toAccount(rows[0]!);
      await appendAudit(client, {
        actor,
        action: "OPERATOR_CREATED",
        details: { operatorId: operator.operatorId, role: operator.role, apiKeyPrefix: operator.apiKeyPrefix, expiresAt: operator.expiresAt },
      });
      return { operator, apiKey: key.apiKey };
    });
  }

  async revoke(operatorId: string, reason: string, actor: Actor): Promise<OperatorAccount> {
    return withTransaction(this.db, async (client) => {
      // Lock all admins so two concurrent revocations cannot remove the last one.
      const admins = await client.query<{ id: string }>(
        "SELECT id FROM operators WHERE role = 'ADMIN' AND revoked_at IS NULL ORDER BY id FOR UPDATE",
      );
      const { rows } = await client.query<OperatorRow>("SELECT * FROM operators WHERE id = $1 FOR UPDATE", [operatorId]);
      const target = rows[0];
      if (!target) throw new OperatorError(404, "OPERATOR_NOT_FOUND", "No such operator");
      if (target.revoked_at) throw new OperatorError(409, "ALREADY_REVOKED", "Operator is already revoked");
      if (target.role === "ADMIN" && admins.rows.length <= 1) {
        throw new OperatorError(409, "LAST_ADMIN", "Cannot revoke the last active ADMIN; create another ADMIN first");
      }
      const updated = await client.query<OperatorRow>(
        "UPDATE operators SET revoked_at = now(), revoked_reason = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [operatorId, reason],
      );
      await appendAudit(client, { actor, action: "OPERATOR_REVOKED", details: { operatorId, reason } });
      return toAccount(updated.rows[0]!);
    });
  }

  /** Issues a new key and invalidates the old one immediately. */
  async rotateKey(operatorId: string, actor: Actor): Promise<{ operator: OperatorAccount; apiKey: string }> {
    const key = generateKey();
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<OperatorRow>(
        `UPDATE operators SET api_key_hash = $2, api_key_prefix = $3, updated_at = now()
         WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
        [operatorId, key.hash, key.prefix],
      );
      if (!rows[0]) throw new OperatorError(404, "OPERATOR_NOT_FOUND", "No such active operator");
      await appendAudit(client, { actor, action: "OPERATOR_KEY_ROTATED", details: { operatorId, apiKeyPrefix: key.prefix } });
      return { operator: toAccount(rows[0]), apiKey: key.apiKey };
    });
  }

  /** Records a rejected credential or permission check (callers are rate limited). */
  async auditDenied(action: "AUTH_FAILED" | "PERMISSION_DENIED", details: Record<string, unknown>, actor: Actor): Promise<void> {
    await withTransaction(this.db, (client) => appendAudit(client, { actor, action, details }));
  }
}
