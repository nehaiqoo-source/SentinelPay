/**
 * Operator credential management from the server host (bootstrap and break-glass):
 *   npm run operator -- create --id alice --name "Alice" --role ADMIN --out .secrets/alice.key [--expires-days 90]
 *   npm run operator -- list
 *   npm run operator -- rotate --id alice --out .secrets/alice.key
 *   npm run operator -- revoke --id alice --reason "left the team"
 * Keys are written to a 0600 file and never printed. Every action is audited.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OperatorError, OperatorStore } from "../auth/operators.js";
import { loadDotEnv } from "../config/env.js";
import { createPool } from "../db/pool.js";
import type { Actor, OperatorRole } from "../models/types.js";

loadDotEnv();
const [command, ...rest] = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const actor: Actor = { type: "SYSTEM", id: `cli:${process.env.USER ?? "unknown"}` };

function writeKey(path: string | undefined, apiKey: string): void {
  if (!path) throw new Error("--out <file> is required (keys are never printed)");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${apiKey}\n`, { mode: 0o600, flag: "w" });
  console.log(`Key written to ${path} (mode 0600). Copy it with: tr -d '\\n' < ${path} | pbcopy`);
}

const db = createPool(process.env.DATABASE_URL ?? "");
const operators = new OperatorStore(db);
try {
  switch (command) {
    case "create": {
      const role = arg("role") as OperatorRole | undefined;
      if (!arg("id") || !arg("name") || !role || !["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"].includes(role)) {
        throw new Error("usage: create --id <id> --name <name> --role VIEWER|AUDITOR|OPERATOR|ADMIN --out <file> [--expires-days N]");
      }
      const days = arg("expires-days");
      const created = await operators.create(
        { operatorId: arg("id")!, displayName: arg("name")!, role, expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000) : null },
        actor,
      );
      console.log(`Created operator ${created.operator.operatorId} (${created.operator.role}), key prefix ${created.operator.apiKeyPrefix}`);
      writeKey(arg("out"), created.apiKey);
      break;
    }
    case "rotate": {
      const rotated = await operators.rotateKey(arg("id") ?? "", actor);
      console.log(`Rotated key for ${rotated.operator.operatorId}; old key revoked. New prefix ${rotated.operator.apiKeyPrefix}`);
      writeKey(arg("out"), rotated.apiKey);
      break;
    }
    case "revoke": {
      const revoked = await operators.revoke(arg("id") ?? "", arg("reason") ?? "revoked via CLI", actor);
      console.log(`Revoked ${revoked.operatorId} at ${revoked.revokedAt}`);
      break;
    }
    case "list": {
      for (const o of await operators.list()) {
        console.log(`${o.operatorId.padEnd(20)} ${o.role.padEnd(9)} ${o.apiKeyPrefix}  ${o.revokedAt ? `REVOKED ${o.revokedAt}` : o.expiresAt ? `expires ${o.expiresAt}` : "active"}`);
      }
      break;
    }
    default:
      throw new Error("commands: create | rotate | revoke | list");
  }
} catch (error) {
  console.error(error instanceof OperatorError || error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
