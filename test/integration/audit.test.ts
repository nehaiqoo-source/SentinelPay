import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createAgent, purchase, resetDatabase, startTestApp, type TestApp } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
let app: TestApp;
let key: string;

before(async () => {
  await resetDatabase();
  mock = await startMockPayPal();
  app = await startTestApp(mock);
  key = await createAgent(app, { agentId: "audited" });
  const res = await app.as(key, "POST", "/api/agent/transactions", purchase());
  mock.approve(res.body.orderId);
  await app.as(key, "POST", `/api/agent/orders/${res.body.orderId}/capture`);
  await app.as(key, "POST", "/api/agent/transactions", purchase({ amount: "500.00" }));
  await app.admin("POST", "/api/admin/agents/audited/freeze", { reason: "audit test" });
  await app.admin("POST", "/api/admin/agents/audited/unfreeze");
});
after(async () => {
  await app.close();
  await mock.close();
});

describe("hash-chained audit log", () => {
  it("records the full lifecycle and verifies as an intact chain", async () => {
    const actions = (await app.admin("GET", "/api/admin/audit?limit=100")).body.events.map((e: any) => e.action).reverse();
    assert.deepEqual(actions, [
      "OPERATOR_CREATED",
      "AGENT_CREATED",
      "BUDGET_RESERVED",
      "PAYPAL_ORDER_CREATED",
      "CAPTURE_STARTED",
      "PAYMENT_CAPTURED",
      "TRANSACTION_BLOCKED",
      "AGENT_FROZEN",
      "AGENT_UNFROZEN",
    ]);
    const verify = await app.admin("GET", "/api/admin/audit/verify");
    assert.equal(verify.body.valid, true);
    assert.equal(verify.body.eventsChecked, 9);
    assert.match(verify.body.headHash, /^[0-9a-f]{64}$/);
  });

  it("the app role has no UPDATE/DELETE/TRUNCATE privilege; even the owner hits the append-only trigger", async () => {
    for (const sql of ["UPDATE audit_events SET action = 'X' WHERE seq = 1", "DELETE FROM audit_events WHERE seq = 1", "TRUNCATE audit_events"]) {
      await assert.rejects(app.db.query(sql), /permission denied/);
      await assert.rejects(app.ownerDb.query(sql), /append-only/);
    }
  });

  it("detects an edit made by someone who bypasses the trigger (table owner)", async () => {
    const client = await app.ownerDb.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
      await client.query("UPDATE audit_events SET details = jsonb_set(details, '{amount}', '\"0.01\"') WHERE seq = 3");
      await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const verify = await app.admin("GET", "/api/admin/audit/verify");
    assert.equal(verify.body.valid, false);
    assert.equal(verify.body.firstInvalidSeq, 3);
    assert.match(verify.body.reason, /modified/);
  });

  it("detects a deleted event", async () => {
    const client = await app.ownerDb.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
      await client.query("DELETE FROM audit_events WHERE seq = 5");
      await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const verify = await app.admin("GET", "/api/admin/audit/verify");
    assert.equal(verify.body.valid, false);
  });

  it("agents and anonymous callers cannot read or verify the audit log", async () => {
    assert.equal((await app.as(key, "GET", "/api/admin/audit")).status, 401);
    assert.equal((await app.as(null, "GET", "/api/admin/audit/verify")).status, 401);
  });
});
