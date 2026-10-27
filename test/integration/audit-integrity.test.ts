import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { canonicalJson, GENESIS_HASH } from "../../src/engine/audit.js";
import { createCheckpoint, generateSigningKeyPair, signerFromPem, verifyAuditIntegrity } from "../../src/engine/auditCheckpoints.js";
import { createHash } from "node:crypto";
import { createAgent, purchase, resetDatabase, startTestApp, type TestApp } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
let app: TestApp;
let externalFile = "";
const signer = signerFromPem(generateSigningKeyPair().privatePem);

before(async () => {
  mock = await startMockPayPal();
});
beforeEach(async () => {
  await app?.close();
  await resetDatabase();
  externalFile = join(mkdtempSync(join(tmpdir(), "sentinelpay-audit-")), "checkpoints.jsonl");
  app = await startTestApp(mock, { auditSigner: signer, env: { AUDIT_CHECKPOINT_FILE: externalFile } });
  const key = await createAgent(app, { agentId: "audited" });
  await app.as(key, "POST", "/api/agent/transactions", purchase());
  await app.as(key, "POST", "/api/agent/transactions", purchase({ amount: "500.00" }));
  assert.equal((await app.admin("POST", "/api/admin/audit/checkpoints")).status, 201);
});
after(async () => {
  await app.close();
  await mock.close();
});

const verify = () => verifyAuditIntegrity(app.db, { publicKey: signer.publicKey, externalFile });

/** Owner-level tampering: disable the trigger, run statements, re-enable. */
async function asOwner(...statements: string[]): Promise<void> {
  const client = await app.ownerDb.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await client.query("ALTER TABLE audit_checkpoints DISABLE TRIGGER audit_checkpoints_append_only");
    for (const sql of statements) await client.query(sql);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    await client.query("ALTER TABLE audit_checkpoints ENABLE TRIGGER audit_checkpoints_append_only");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

/** Recomputes every hash from seq `from` onward, as an attacker with owner access would to hide an edit. */
async function rewriteChainConsistently(): Promise<void> {
  const { rows } = await app.ownerDb.query("SELECT * FROM audit_events ORDER BY seq");
  let prev = GENESIS_HASH;
  const updates: string[] = [];
  for (const r of rows) {
    const payload = canonicalJson({
      occurredAt: r.occurred_at.toISOString(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      agentId: r.agent_id,
      transactionId: r.transaction_id,
      details: r.details,
    });
    const hash = createHash("sha256").update(`${prev}\n${payload}`).digest("hex");
    updates.push(`UPDATE audit_events SET prev_hash = '${prev}', hash = '${hash}' WHERE seq = ${r.seq}`);
    prev = hash;
  }
  // Two passes avoid transient UNIQUE(hash) collisions.
  await asOwner(...updates.map((u) => u.replace(/hash = '([0-9a-f]+)' WHERE/, "hash = md5(random()::text) || md5(random()::text) WHERE")), ...updates);
}

describe("least-privilege runtime role", () => {
  it("cannot modify, delete, truncate or disable triggers on the audit tables", async () => {
    for (const sql of [
      "UPDATE audit_events SET action = 'X'",
      "DELETE FROM audit_events",
      "TRUNCATE audit_events",
      "ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only",
      "UPDATE audit_checkpoints SET head_hash = head_hash",
      "DELETE FROM audit_checkpoints",
      "DELETE FROM transactions",
      "DROP TABLE audit_events",
    ]) {
      await assert.rejects(app.db.query(sql), /permission denied|must be owner/, sql);
    }
  });

  it("is not a superuser and does not own the audit log", async () => {
    const { rows } = await app.db.query(
      "SELECT rolsuper, (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_events') AS owner, current_user AS me FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(rows[0].rolsuper, false);
    assert.notEqual(rows[0].owner, rows[0].me);
  });
});

describe("signed checkpoints", () => {
  it("an untouched log verifies: chain, DB checkpoint and external checkpoint", async () => {
    const report = await verify();
    assert.equal(report.chain.valid, true);
    assert.equal(report.checkpoints.valid, true, report.checkpoints.problems.join("; "));
    assert.equal(report.checkpoints.checked, 1);
    assert.equal(report.checkpoints.externalChecked, 1);
    const line = JSON.parse(readFileSync(externalFile, "utf8").trim());
    assert.equal(line.keyId, signer.keyId);
  });

  it("checkpointing is idempotent for an unchanged head", async () => {
    assert.equal((await app.admin("POST", "/api/admin/audit/checkpoints")).status, 200);
    assert.equal(readFileSync(externalFile, "utf8").trim().split("\n").length, 1);
  });

  it("detects a CONSISTENT rewrite of the whole chain, which the hash chain alone cannot", async () => {
    await asOwner("UPDATE audit_events SET details = jsonb_set(details, '{amount}', '\"0.01\"') WHERE action = 'BUDGET_RESERVED'");
    await rewriteChainConsistently();
    const report = await verify();
    assert.equal(report.chain.valid, true, "the attacker's recomputed chain is internally consistent");
    assert.equal(report.checkpoints.valid, false);
    assert.ok(report.checkpoints.problems.some((p) => /history rewritten/.test(p)), report.checkpoints.problems.join("; "));
  });

  it("detects deleting events up to the checkpoint (tail truncation)", async () => {
    const { rows } = await app.ownerDb.query("SELECT max(seq) AS m FROM audit_events");
    await asOwner(`DELETE FROM audit_events WHERE seq >= ${Number(rows[0].m) - 1}`);
    const report = await verify();
    assert.equal(report.chain.valid, true, "a truncated tail still forms a valid chain");
    assert.ok(report.checkpoints.problems.some((p) => /no longer exists/.test(p)));
  });

  it("detects reordering of events", async () => {
    await asOwner(
      "UPDATE audit_events SET seq = -1 WHERE seq = 2",
      "UPDATE audit_events SET seq = 2 WHERE seq = 3",
      "UPDATE audit_events SET seq = 3 WHERE seq = -1",
    );
    const report = await verify();
    assert.equal(report.chain.valid, false);
    assert.match(report.chain.reason ?? "", /does not link/);
  });

  it("detects a forged checkpoint row signed with an attacker's key, and deleted DB checkpoints", async () => {
    const attacker = signerFromPem(generateSigningKeyPair().privatePem);
    const { rows } = await app.ownerDb.query("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1");
    await asOwner("DELETE FROM audit_checkpoints");
    const signedAt = new Date().toISOString();
    await app.ownerDb.query("INSERT INTO audit_checkpoints VALUES ($1, $2, $3, $4, $5)", [
      rows[0].seq,
      rows[0].hash,
      signer.keyId, // claims the real key id
      signedAt,
      attacker.sign(`sentinelpay-audit-checkpoint:v1|${rows[0].seq}|${rows[0].hash}|${signedAt}`),
    ]);
    const report = await verify();
    assert.ok(report.checkpoints.problems.some((p) => /database checkpoint .*invalid signature/.test(p)), report.checkpoints.problems.join("; "));
  });

  it("detects deleted DB checkpoints using the external copy", async () => {
    await asOwner("DELETE FROM audit_checkpoints");
    const report = await verify();
    assert.equal(report.checkpoints.checked, 0);
    assert.ok(report.checkpoints.problems.some((p) => /missing from database/.test(p)), report.checkpoints.problems.join("; "));
  });

  it("detects a doctored external checkpoint file", async () => {
    const line = JSON.parse(readFileSync(externalFile, "utf8").trim());
    writeFileSync(externalFile, `${JSON.stringify({ ...line, headHash: "f".repeat(64) })}\n`);
    const report = await verify();
    assert.ok(report.checkpoints.problems.some((p) => /external checkpoint .*invalid signature/.test(p)));
  });

  it("LIMITATION: changes after the newest checkpoint are only caught by the chain, not by signatures", async () => {
    const key = await createAgent(app, { agentId: "late" });
    await app.as(key, "POST", "/api/agent/transactions", purchase());
    await asOwner("DELETE FROM audit_events WHERE seq = (SELECT max(seq) FROM audit_events)");
    const report = await verify();
    // Deleting the newest, un-checkpointed event leaves a valid chain and valid checkpoints.
    assert.equal(report.chain.valid, true);
    assert.equal(report.checkpoints.valid, true);
  });

  it("the verify endpoint reports checkpoint status and needs audit permission", async () => {
    const res = await app.admin("GET", "/api/admin/audit/verify");
    assert.equal(res.body.valid, true);
    assert.equal(res.body.checkpoints.configured, true);
    assert.equal(res.body.checkpoints.latestSeq !== null, true);
  });

  it("createCheckpoint signs the head and appends one external line per new head", async () => {
    const key = await createAgent(app, { agentId: "another" });
    await app.as(key, "POST", "/api/agent/transactions", purchase());
    const cp = await createCheckpoint(app.db, signer, externalFile);
    assert.ok(cp);
    assert.equal(readFileSync(externalFile, "utf8").trim().split("\n").length, 2);
    assert.equal((await verify()).checkpoints.valid, true);
  });
});
