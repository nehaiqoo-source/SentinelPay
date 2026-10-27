import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createAgent, createOperator, purchase, request, resetDatabase, startTestApp, type TestApp } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
let app: TestApp;
const keys: Record<string, string> = {};
let agentKey = "";

before(async () => {
  await resetDatabase();
  mock = await startMockPayPal();
  app = await startTestApp(mock);
  for (const role of ["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"] as const) {
    keys[role] = await createOperator(app, role.toLowerCase(), role);
  }
  agentKey = await createAgent(app, { agentId: "agent-x" });
});
after(async () => {
  await app.close();
  await mock.close();
});

const auditActions = async () => (await app.admin("GET", "/api/admin/audit?limit=500")).body.events as any[];

describe("operator authentication", () => {
  it("rejects missing, malformed, unknown and agent credentials with an identical 401", async () => {
    const bodies = new Set<string>();
    for (const token of [null, "not-a-key", `sp_op_${"x".repeat(43)}`, agentKey]) {
      const res = await app.as(token, "GET", "/api/admin/summary");
      assert.equal(res.status, 401);
      bodies.add(JSON.stringify(res.body));
    }
    assert.equal(bodies.size, 1, "responses must not reveal which check failed");
  });

  it("revoked keys stop working immediately, and the revocation is audited", async () => {
    const key = await createOperator(app, "temp-op", "OPERATOR");
    assert.equal((await app.as(key, "GET", "/api/admin/summary")).status, 200);
    const revoked = await app.admin("POST", "/api/admin/operators/temp-op/revoke", { reason: "left the team" });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.revokedAt);
    assert.equal((await app.as(key, "GET", "/api/admin/summary")).status, 401);
    const events = await auditActions();
    assert.ok(events.some((e) => e.action === "OPERATOR_REVOKED" && e.details.operatorId === "temp-op"));
    assert.ok(events.some((e) => e.action === "AUTH_FAILED" && e.details.reason === "REVOKED" && e.details.operatorId === "temp-op"));
  });

  it("expired keys are rejected", async () => {
    const key = await createOperator(app, "short-lived", "VIEWER", 1);
    await app.ownerDb.query("UPDATE operators SET expires_at = now() - interval '1 second' WHERE id = 'short-lived'");
    assert.equal((await app.as(key, "GET", "/api/admin/summary")).status, 401);
    assert.ok((await auditActions()).some((e) => e.action === "AUTH_FAILED" && e.details.reason === "EXPIRED"));
  });

  it("rotating a key invalidates the old one (self-service and admin)", async () => {
    const key = await createOperator(app, "rotator", "VIEWER");
    const self = await app.as(key, "POST", "/api/admin/operators/rotator/rotate-key");
    assert.equal(self.status, 200);
    assert.equal((await app.as(key, "GET", "/api/admin/summary")).status, 401);
    assert.equal((await app.as(self.body.apiKey, "GET", "/api/admin/summary")).status, 200);
    // A VIEWER cannot rotate someone else's key.
    assert.equal((await app.as(self.body.apiKey, "POST", "/api/admin/operators/admin/rotate-key")).status, 403);
  });

  it("keys are stored hashed and never returned by listings", async () => {
    const list = await app.admin("GET", "/api/admin/operators");
    const text = JSON.stringify(list.body);
    for (const key of Object.values(keys)) assert.ok(!text.includes(key));
    const { rows } = await app.ownerDb.query("SELECT api_key_hash FROM operators");
    for (const row of rows) assert.match(row.api_key_hash, /^[0-9a-f]{64}$/);
  });

  it("the last active ADMIN cannot be revoked", async () => {
    // Revoke the extra 'admin' operator first; the bootstrap admin remains.
    assert.equal((await app.admin("POST", "/api/admin/operators/admin/revoke", { reason: "cleanup" })).status, 200);
    const me = await app.admin("GET", "/api/admin/me");
    const res = await app.admin("POST", `/api/admin/operators/${me.body.operatorId}/revoke`, { reason: "oops" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "LAST_ADMIN");
    keys.ADMIN = app.adminKey;
  });
});

describe("role-based authorization", () => {
  // [method, path, body, permitted roles]
  const matrix: [string, string, unknown, string[]][] = [
    ["GET", "/api/admin/summary", undefined, ["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"]],
    ["GET", "/api/admin/transactions", undefined, ["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"]],
    ["GET", "/api/admin/audit", undefined, ["AUDITOR", "ADMIN"]],
    ["GET", "/api/admin/audit/verify", undefined, ["AUDITOR", "ADMIN"]],
    ["POST", "/api/admin/agents/agent-x/freeze", { reason: "matrix" }, ["OPERATOR", "ADMIN"]],
    ["POST", "/api/admin/agents/agent-x/unfreeze", undefined, ["ADMIN"]],
    ["GET", "/api/admin/operators", undefined, ["ADMIN"]],
    ["POST", "/api/admin/orders/NOTREAL123/capture", undefined, ["OPERATOR", "ADMIN"]],
  ];

  for (const [method, path, body, allowed] of matrix) {
    it(`${method} ${path}: allowed for ${allowed.join(", ")} only`, async () => {
      for (const role of ["VIEWER", "AUDITOR", "OPERATOR", "ADMIN"]) {
        const res = await app.as(keys[role]!, method, path, body);
        if (allowed.includes(role)) assert.notEqual(res.status, 403, `${role} should be allowed (got ${res.status})`);
        else assert.equal(res.status, 403, `${role} should be forbidden (got ${res.status})`);
      }
    });
  }

  it("only ADMIN can change spending policy, create agents or rotate agent keys", async () => {
    const policy = { displayName: "x", perTransactionCap: "25.00", dailyCap: "100.00", allowedMerchants: null, allowedCategories: null };
    for (const role of ["VIEWER", "AUDITOR", "OPERATOR"]) {
      assert.equal((await app.as(keys[role]!, "PUT", "/api/admin/agents/agent-x/policy", policy)).status, 403);
      assert.equal((await app.as(keys[role]!, "POST", "/api/admin/agents", { ...policy, agentId: `z-${role}` })).status, 403);
      assert.equal((await app.as(keys[role]!, "POST", "/api/admin/agents/agent-x/rotate-key")).status, 403);
      assert.equal((await app.as(keys[role]!, "POST", "/api/admin/operators", { operatorId: `x-${role.toLowerCase()}`, displayName: "x", role: "ADMIN" })).status, 403);
    }
    const agent = await app.admin("GET", "/api/admin/agents/agent-x");
    assert.equal(agent.body.perTransactionCap, "25.00");
  });

  it("an OPERATOR can freeze but not unfreeze; freeze still blocks payments", async () => {
    assert.equal((await app.as(keys.OPERATOR!, "POST", "/api/admin/agents/agent-x/freeze", { reason: "incident" })).status, 200);
    assert.equal((await app.as(keys.OPERATOR!, "POST", "/api/admin/agents/agent-x/unfreeze")).status, 403);
    const created = mock.counters.createCalls;
    assert.equal((await app.as(agentKey, "POST", "/api/agent/transactions", purchase())).status, 403);
    assert.equal(mock.counters.createCalls, created);
    assert.equal((await app.admin("POST", "/api/admin/agents/agent-x/unfreeze")).status, 200);
  });

  it("permission denials are audited with the operator identity", async () => {
    const events = await auditActions();
    const denial = events.find((e) => e.action === "PERMISSION_DENIED" && e.actorId === "viewer");
    assert.ok(denial);
    assert.equal(denial.actorType, "OPERATOR");
    assert.ok(typeof denial.details.permission === "string");
  });

  it("privileged actions are attributed to the named operator", async () => {
    const events = await auditActions();
    const freeze = events.find((e) => e.action === "AGENT_FROZEN" && e.details.reason === "incident");
    assert.equal(freeze.actorId, "operator");
    assert.equal(freeze.actorType, "OPERATOR");
  });
});

describe("brute-force protection", () => {
  it("rate-limits failed operator authentications per IP without affecting valid sessions", async () => {
    const limited = await startTestApp(mock, { env: { AUTH_FAILURE_LIMIT_PER_MINUTE: "3" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(limited.baseUrl, "GET", "/api/admin/summary", { token: `sp_op_${"y".repeat(43)}` })).status);
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
    const ok = await startTestApp(mock, { env: { AUTH_FAILURE_LIMIT_PER_MINUTE: "3" } });
    try {
      for (let i = 0; i < 6; i++) assert.equal((await ok.admin("GET", "/api/admin/summary")).status, 200);
    } finally {
      await ok.close();
    }
  });

  it("REGRESSION: an attacker's failed attempts from the SAME IP cannot lock out a valid operator", async () => {
    // Found in the Phase 4 live run: the limiter used to block every request from an IP
    // once failures exceeded the limit, including correctly authenticated operators.
    const shared = await startTestApp(mock, { env: { AUTH_FAILURE_LIMIT_PER_MINUTE: "3" } });
    try {
      const attacker: number[] = [];
      for (let i = 0; i < 6; i++) attacker.push((await request(shared.baseUrl, "GET", "/api/admin/summary", { token: `sp_op_${"z".repeat(43)}` })).status);
      assert.deepEqual(attacker, [401, 401, 401, 429, 429, 429]);
      for (let i = 0; i < 5; i++) assert.equal((await shared.admin("GET", "/api/admin/summary")).status, 200, "valid operator throttled");
      assert.equal((await shared.admin("POST", "/api/admin/audit/checkpoints")).status, 409, "authenticated write still reaches the handler");
      // Throttled attempts are not written to the audit log (bounded audit growth under attack).
      const failures = (await shared.admin("GET", "/api/admin/audit?limit=500")).body.events.filter(
        (e: any) => e.action === "AUTH_FAILED" && e.details.keyPrefix === `sp_op_${"z".repeat(6)}`,
      );
      assert.equal(failures.length, 3);
    } finally {
      await shared.close();
    }
  });
});
