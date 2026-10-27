import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.js";
import { withTransaction } from "./pool.js";

// Resolves to <project>/migrations from both src/db (tsx) and dist/db (compiled).
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_LOCK_KEY = 72_017_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending SQL migrations in filename order, each in its own transaction.
 * Refuses to run if an applied migration file has since been edited.
 */
export async function runMigrations(db: Db): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied; add a new migration instead`);
        }
        result.alreadyApplied.push(file);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      result.applied.push(file);
    }
  });

  return result;
}

/** Throws unless every migration file has been applied (used at server startup). */
export async function assertMigrationsCurrent(db: Db): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d+_.+\.sql$/.test(name));
  const { rows } = await db
    .query<{ name: string }>("SELECT name FROM schema_migrations")
    .catch(() => ({ rows: [] as { name: string }[] }));
  const applied = new Set(rows.map((row) => row.name));
  const pending = files.filter((file) => !applied.has(file));
  if (pending.length > 0) {
    throw new Error(`Database has pending migrations (${pending.join(", ")}); run "npm run migrate"`);
  }
}
