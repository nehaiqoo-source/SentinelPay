import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createAgent, purchase, resetDatabase, startTestApp, type TestApp } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
let instanceA: TestApp;
let instanceB: TestApp;

before(async () => {
  mock = await startMockPayPal();
});
beforeEach(async () => {
  await instanceA?.close();
  await instanceB?.close();
  await resetDatabase();
  mock.delayMs = 50; // widen race windows around the PayPal call
  instanceA = await startTestApp(mock);
  // Second instance: separate process-level state and pool, same database and config.
  instanceB = await startTestApp(mock, { config: instanceA.config });
});
after(async () => {
  await instanceA.close();
  await instanceB.close();
  await mock.close();
});

const instances = () => [instanceA, instanceB];

describe("concurrent spending across two server instances", () => {
  it("40 parallel $10 requests against a $100 agent cap reserve exactly $100", async () => {
    const key = await createAgent(instanceA, { agentId: "racer", perTransactionCap: "25.00", dailyCap: "100.00" });
    const createdBefore = mock.counters.ordersCreated;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => instances()[i % 2]!.as(key, "POST", "/api/agent/transactions", purchase({ amount: "10.00" }))),
    );
    const accepted = results.filter((r) => r.status === 202).length;
    const blocked = results.filter((r) => r.status === 403).length;
    assert.equal(accepted, 10);
    assert.equal(blocked, 30);
    const spend = await instanceA.store.spendingToday("racer");
    assert.equal(spend.reservedCents + spend.committedCents, 10_000);
    assert.equal(mock.counters.ordersCreated - createdBefore, 10, "only accepted requests reached PayPal");
  });

  it("parallel requests from many agents never exceed the global daily cap", async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, (_, i) => createAgent(instanceA, { agentId: `fleet-${i}` })));
    const results = await Promise.all(
      Array.from({ length: 48 }, (_, i) =>
        instances()[i % 2]!.as(keys[i % keys.length]!, "POST", "/api/agent/transactions", purchase({ amount: "7.00" })),
      ),
    );
    const spend = await instanceA.store.spendingToday();
    assert.ok(spend.reservedCents + spend.committedCents <= 10_000, `spent ${spend.reservedCents + spend.committedCents}`);
    assert.equal(results.filter((r) => r.status === 202).length, Math.floor(10_000 / 700));
  });

  it("20 parallel duplicates of one requestId create exactly one PayPal order", async () => {
    const key = await createAgent(instanceA, { agentId: "dup" });
    const body = purchase({ amount: "5.00" });
    const createdBefore = mock.counters.ordersCreated;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => instances()[i % 2]!.as(key, "POST", "/api/agent/transactions", body)));
    const ids = new Set(results.map((r) => r.body.transactionId));
    assert.equal(ids.size, 1);
    assert.equal(mock.counters.ordersCreated - createdBefore, 1);
    const { rows } = await instanceA.db.query("SELECT count(*)::int AS n FROM transactions WHERE agent_id = 'dup'");
    assert.equal(rows[0].n, 1);
  });

  it("10 parallel captures of one approved order produce exactly one PayPal capture", async () => {
    const key = await createAgent(instanceA, { agentId: "capt" });
    const res = await instanceA.as(key, "POST", "/api/agent/transactions", purchase({ amount: "9.99" }));
    mock.approve(res.body.orderId);
    const callsBefore = mock.counters.captureCalls;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 3 === 0
          ? instances()[i % 2]!.admin("POST", `/api/admin/orders/${res.body.orderId}/capture`)
          : instances()[i % 2]!.as(key, "POST", `/api/agent/orders/${res.body.orderId}/capture`),
      ),
    );
    assert.equal(mock.counters.captureCalls - callsBefore, 1, "only the claim winner called PayPal");
    for (const r of results) assert.ok([201, 409].includes(r.status), `unexpected ${r.status}`);
    const final = await instanceA.store.getTransaction(res.body.transactionId);
    assert.equal(final?.record.status, "COMPLETED");
  });

  it("a freeze racing a request flood: nothing reserved after the freeze commits", async () => {
    const key = await createAgent(instanceA, { agentId: "freezer", perTransactionCap: "1.00", dailyCap: "100.00" });
    const flood = Array.from({ length: 30 }, (_, i) => instances()[i % 2]!.as(key, "POST", "/api/agent/transactions", purchase({ amount: "1.00" })));
    const freeze = instanceB.admin("POST", "/api/admin/agents/freezer/freeze", { reason: "race test" });
    await Promise.all([...flood, freeze]);
    const { rows } = await instanceA.db.query(
      `SELECT count(*)::int AS n FROM transactions t JOIN agents a ON a.id = t.agent_id
       WHERE t.agent_id = 'freezer' AND t.status <> 'BLOCKED' AND t.created_at > a.frozen_at`,
    );
    assert.equal(rows[0].n, 0);
  });
});
