/**
 * Independent audit verification. Needs only read access to the database, the
 * PUBLIC key and the external checkpoint file; it does not trust the running server.
 *   npm run audit:verify -- --public-key .secrets/audit-signing.pub.pem --checkpoints audit-checkpoints.jsonl
 * Exit code 0 = chain and checkpoints valid, 1 = tampering detected.
 */
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadDotEnv } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { verifyAuditIntegrity } from "../src/engine/auditCheckpoints.js";

loadDotEnv();
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const publicKeyFile = arg("public-key") ?? process.env.AUDIT_PUBLIC_KEY_FILE;
const checkpointFile = arg("checkpoints") ?? process.env.AUDIT_CHECKPOINT_FILE ?? null;
if (!publicKeyFile) {
  console.error("usage: npm run audit:verify -- --public-key <file.pub.pem> [--checkpoints <file.jsonl>]");
  process.exit(2);
}

const db = createPool(process.env.AUDIT_VERIFY_DATABASE_URL || process.env.DATABASE_URL || "");
try {
  const report = await verifyAuditIntegrity(db, { publicKey: createPublicKey(readFileSync(publicKeyFile, "utf8")), externalFile: checkpointFile });
  console.log(
    JSON.stringify(
      {
        chain: { valid: report.chain.valid, events: report.chain.eventsChecked, headSeq: report.chain.headSeq, firstInvalidSeq: report.chain.firstInvalidSeq, reason: report.chain.reason },
        checkpoints: report.checkpoints,
      },
      null,
      2,
    ),
  );
  const ok = report.chain.valid && report.checkpoints.valid;
  console.log(ok ? "RESULT: audit log verified" : "RESULT: TAMPERING DETECTED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await db.end();
}
