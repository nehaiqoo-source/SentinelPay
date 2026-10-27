import { loadDotEnv } from "../config/env.js";
import { grantAppRole } from "./appRole.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";

// Schema changes need the owner role; the app itself runs as the least-privilege role.
loadDotEnv();
const databaseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(1);
}
const appRole = process.env.APP_DB_ROLE || "sentinelpay_app";

const db = createPool(databaseUrl);
try {
  const { applied, alreadyApplied } = await runMigrations(db);
  console.log(`Migrations applied: ${applied.length ? applied.join(", ") : "none"} (already applied: ${alreadyApplied.length})`);
  if (await grantAppRole(db, appRole)) console.log(`Grants refreshed for runtime role ${appRole}`);
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
