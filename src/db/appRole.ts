import type { Db } from "./pool.js";

/**
 * Least-privilege runtime role. The application connects as this role; schema
 * changes and anything destructive need the owner role, which the app does not use.
 *
 * The role can append to audit_events/audit_checkpoints but cannot UPDATE, DELETE
 * or TRUNCATE them, cannot disable their triggers (not the owner), and cannot
 * delete any ledger row.
 */
export const APP_ROLE_GRANTS = [
  "GRANT USAGE ON SCHEMA public TO {role}",
  "GRANT SELECT ON schema_migrations TO {role}",
  "GRANT SELECT, INSERT, UPDATE ON agents, transactions, operators TO {role}",
  "GRANT SELECT, INSERT ON audit_events, audit_checkpoints TO {role}",
  "GRANT USAGE, SELECT ON SEQUENCE audit_events_seq_seq TO {role}",
];

/** Creates (or re-passwords) the runtime role and applies its grants. Must run as the schema owner. */
export async function ensureAppRole(ownerDb: Db, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("invalid role name");
  const quotedPassword = `'${password.replace(/'/g, "''")}'`;
  const exists = await ownerDb.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  await ownerDb.query(
    exists.rowCount
      ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quotedPassword}`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${quotedPassword}`,
  );
  await grantAppRole(ownerDb, role);
}

/** (Re)applies the runtime role's grants; run after every migration so new tables are covered. */
export async function grantAppRole(ownerDb: Db, role: string): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("invalid role name");
  const exists = await ownerDb.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (!exists.rowCount) return false;
  const { rows } = await ownerDb.query<{ db: string }>("SELECT current_database() AS db");
  await ownerDb.query(`GRANT CONNECT ON DATABASE "${rows[0]!.db}" TO ${role}`);
  for (const grant of APP_ROLE_GRANTS) await ownerDb.query(grant.replaceAll("{role}", role));
  return true;
}

export interface RoleCheck {
  user: string;
  superuser: boolean;
  ownsAuditLog: boolean;
}

/** Reports whether the connected role could rewrite the audit log directly. */
export async function inspectConnectedRole(db: Db): Promise<RoleCheck> {
  const { rows } = await db.query<{ usr: string; superuser: boolean; owner: string | null }>(
    `SELECT current_user AS usr,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_events' AND schemaname = 'public') AS owner`,
  );
  const row = rows[0]!;
  return { user: row.usr, superuser: row.superuser, ownsAuditLog: row.owner === row.usr };
}
