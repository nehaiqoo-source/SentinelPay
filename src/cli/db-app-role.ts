/**
 * Creates the least-privilege runtime role and (with --write-env) points the app at it:
 *   npm run db:app-role -- --write-env
 * MIGRATION_DATABASE_URL keeps the owner connection for `npm run migrate`.
 * The generated password is written to .env only; it is never printed.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../config/env.js";
import { ensureAppRole } from "../db/appRole.js";
import { createPool } from "../db/pool.js";

loadDotEnv();
const ownerUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!ownerUrl) {
  console.error("Set MIGRATION_DATABASE_URL (owner connection) first");
  process.exit(1);
}
const role = process.env.APP_DB_ROLE || "sentinelpay_app";
const writeEnv = process.argv.includes("--write-env");
const password = randomBytes(24).toString("base64url");

const db = createPool(ownerUrl);
try {
  await ensureAppRole(db, role, password);
  console.log(`Runtime role "${role}" created/updated with least-privilege grants.`);
} finally {
  await db.end();
}

if (writeEnv) {
  const appUrl = new URL(ownerUrl);
  appUrl.username = role;
  appUrl.password = password;
  let env = readFileSync(".env", "utf8");
  const set = (key: string, value: string) => {
    const line = `${key}=${value}`;
    env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
  };
  set("MIGRATION_DATABASE_URL", ownerUrl);
  set("DATABASE_URL", appUrl.toString());
  writeFileSync(".env", env, { mode: 0o600 });
  console.log(".env updated: DATABASE_URL now uses the runtime role; MIGRATION_DATABASE_URL keeps the owner connection.");
} else {
  console.log("Password not saved. Re-run with --write-env to store the runtime connection string in .env.");
}
