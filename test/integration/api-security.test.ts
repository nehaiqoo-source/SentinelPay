import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createAgent, purchase, request, resetDatabase, startTestApp, type TestApp } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
let app: TestApp;
let keyA: string;
let keyB: string;

before(async () => {
  await resetDatabase();
  mock = await startMockPayPal();
  app = await startTestApp(mock, { env: { CORS_ALLOWED_ORIGINS: "https://dashboard.example" } });
  keyA = await createAgent(app, { agentId: "agent-a" });
  keyB = await createAgent(app, { agentId: "agent-b" });
});
after(async () => {
  await app.close();
  await mock.close();
});

describe("authentication", () => {
  const agentRoutes: [string, string][] = [
    ["POST", "/api/agent/transactions"],
    ["GET", "/api/agent/transactions/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/agent/orders/ABC123/capture"],
    ["GET", "/api/agent/policy"],
  ];
  const adminRoutes: [string, string][] = [
    ["GET", "/api/admin/summary"],
    ["GET", "/api/admin/agents"],
    ["POST", "/api/admin/agents"],
    ["PUT", "/api/admin/agents/agent-a/policy"],
    ["POST", "/api/admin/agents/agent-a/freeze"],
    ["POST", "/api/admin/agents/agent-a/unfreeze"],
    ["POST", "/api/admin/agents/agent-a/rotate-key"],
    ["GET", "/api/admin/transactions"],
    ["POST", "/api/admin/orders/ABC123/capture"],
    ["POST", "/api/admin/transactions/00000000-0000-4000-8000-000000000000/cancel"],
    ["GET", "/api/admin/audit"],
    ["GET", "/api/admin/audit/verify"],
  ];

  for (const [method, path] of agentRoutes) {
    it(`${method} ${path} rejects missing and forged agent keys`, async () => {
      assert.equal((await app.as(null, method, path, {})).status, 401);
      assert.equal((await app.as(`sp_agent_${"x".repeat(43)}`, method, path, {})).status, 401);
      assert.equal((await app.as(app.adminKey, method, path, {})).status, 401, "operator key is not an agent key");
    });
  }

  for (const [method, path] of adminRoutes) {
    it(`${method} ${path} rejects anonymous callers and agent keys`, async () => {
      assert.equal((await app.as(null, method, path, { reason: "x" })).status, 401);
      assert.equal((await app.as(keyA, method, path, { reason: "x" })).status, 401);
      assert.equal((await app.as(`${app.adminKey}x`, method, path, { reason: "x" })).status, 401);
    });
  }

  it("an agent cannot freeze, unfreeze or re-key another agent, and nothing changed", async () => {
    await app.as(keyA, "POST", "/api/admin/agents/agent-b/freeze", { reason: "hostile" });
    await app.as(keyA, "POST", "/api/admin/agents/agent-b/rotate-key");
    const b = await app.admin("GET", "/api/admin/agents/agent-b");
    assert.equal(b.body.frozen, false);
    assert.equal((await app.as(keyB, "GET", "/api/agent/policy")).status, 200, "agent-b key still valid");
  });
});

describe("agent identity and object-level authorization", () => {
  it("ignores no body fields: agentId and policy fields in the body are rejected", async () => {
    for (const extra of [{ agentId: "agent-b" }, { perTransactionCap: "1000" }, { dailyCap: "1000" }, { approved: true }, { status: "COMPLETED" }]) {
      const res = await app.as(keyA, "POST", "/api/agent/transactions", purchase(extra));
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
      assert.match(JSON.stringify(res.body.issues), /Unrecognized key/);
    }
  });

  it("records the transaction under the key's agent", async () => {
    const res = await app.as(keyA, "POST", "/api/agent/transactions", purchase());
    assert.equal(res.status, 202);
    assert.equal(res.body.agentId, "agent-a");
  });

  it("an agent cannot read or capture another agent's transaction (404, not 403)", async () => {
    const res = await app.as(keyA, "POST", "/api/agent/transactions", purchase());
    const { transactionId, orderId } = res.body;
    mock.approve(orderId);
    assert.equal((await app.as(keyB, "GET", `/api/agent/transactions/${transactionId}`)).status, 404);
    const captureCalls = mock.counters.captureCalls;
    assert.equal((await app.as(keyB, "POST", `/api/agent/orders/${orderId}/capture`)).status, 404);
    assert.equal(mock.counters.captureCalls, captureCalls, "PayPal capture was never called");
    assert.equal((await app.as(keyA, "GET", `/api/agent/transactions/${transactionId}`)).status, 200);
  });

  it("agents cannot change spending limits: no agent route exists and the admin route refuses agent keys", async () => {
    assert.equal((await app.as(keyA, "PUT", "/api/agent/policy", { perTransactionCap: "1000" })).status, 404);
    assert.equal(
      (await app.as(keyA, "PUT", "/api/admin/agents/agent-a/policy", {
        displayName: "a",
        perTransactionCap: "25.00",
        dailyCap: "1000.00",
        allowedMerchants: null,
        allowedCategories: null,
      })).status,
      401,
    );
    const policy = await app.as(keyA, "GET", "/api/agent/policy");
    assert.equal(policy.body.policy.dailyCap, "100.00");
  });

  it("admins cannot raise an agent above the global ceilings", async () => {
    const res = await app.admin("PUT", "/api/admin/agents/agent-a/policy", {
      displayName: "a",
      perTransactionCap: "25.00",
      dailyCap: "100000.00",
      allowedMerchants: null,
      allowedCategories: null,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "POLICY_EXCEEDS_LIMITS");
  });

  it("agent API keys are shown once and never returned by listings", async () => {
    const list = await app.admin("GET", "/api/admin/agents");
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes(keyA) && !text.includes(keyB));
    assert.ok(!text.includes("api_key_hash") && !text.includes("apiKeyHash"));
  });

  it("rotating a key revokes the old one", async () => {
    const key = await createAgent(app, { agentId: "agent-rotate" });
    const rotated = await app.admin("POST", "/api/admin/agents/agent-rotate/rotate-key");
    assert.equal((await app.as(key, "GET", "/api/agent/policy")).status, 401);
    assert.equal((await app.as(rotated.body.apiKey, "GET", "/api/agent/policy")).status, 200);
  });
});

describe("transport and input hardening", () => {
  it("CORS: allowed origin gets the header, others get none", async () => {
    const ok = await request(app.baseUrl, "GET", "/health", { headers: { Origin: "https://dashboard.example" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://dashboard.example");
    const evil = await request(app.baseUrl, "POST", "/api/agent/transactions", {
      token: keyA,
      body: purchase(),
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  it("rejects oversized bodies with 413 before reaching the guard", async () => {
    const res = await request(app.baseUrl, "POST", "/api/agent/transactions", {
      token: keyA,
      rawBody: JSON.stringify(purchase({ description: "x".repeat(20_000) })),
    });
    assert.equal(res.status, 413);
  });

  it("rejects malformed JSON, wrong types and over-long fields", async () => {
    assert.equal((await request(app.baseUrl, "POST", "/api/agent/transactions", { token: keyA, rawBody: "{bad" })).status, 400);
    for (const bad of [
      { amount: "1e3" },
      { amount: -5 },
      { amount: 0 },
      { amount: "10.001" },
      { amount: Number.MAX_VALUE },
      { amount: "NaN" },
      { currency: "EUR" },
      { description: "x".repeat(128) },
      { merchantName: "m".repeat(101) },
      { category: "Electronics!" },
      { merchantId: "acme store" },
      { requestId: "has spaces" },
    ]) {
      assert.equal((await app.as(keyA, "POST", "/api/agent/transactions", purchase(bad))).status, 400, JSON.stringify(bad));
    }
    const { requestId: _omitted, ...withoutRequestId } = purchase();
    assert.equal((await app.as(keyA, "POST", "/api/agent/transactions", withoutRequestId)).status, 400, "requestId is mandatory");
  });

  it("sets security headers and a strict CSP", async () => {
    const res = await request(app.baseUrl, "GET", "/");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("health exposes no configuration or secrets", async () => {
    const res = await request(app.baseUrl, "GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ["database", "service", "status", "uptimeSeconds"]);
  });

  it("the console's transaction grid shows the PayPal order id, capture id, currency and status", async () => {
    const res = await request(app.baseUrl, "GET", "/app.js");
    assert.equal(res.status, 200);
    for (const field of ["orderId", "captureId", "currency", "amount", "status", "budgetState"]) {
      assert.match(String(res.body), new RegExp(`field: "${field}"`), `transactions grid lacks a ${field} column`);
    }
  });

  it("serves AG Grid locally (no third-party script origin needed)", async () => {
    const res = await request(app.baseUrl, "GET", "/vendor/ag-grid/dist/ag-grid-community.min.js");
    assert.equal(res.status, 200);
    assert.equal((await request(app.baseUrl, "GET", "/vendor/ag-grid/package.json")).status, 404, "package metadata is not exposed");
  });
});

describe("production transport enforcement", () => {
  it("rejects plain-HTTP requests, accepts HTTPS from the trusted proxy, and sends HSTS", async () => {
    const prod = await startTestApp(mock, { config: { ...app.config, nodeEnv: "production", trustProxyHops: 1 } });
    try {
      const plain = await request(prod.baseUrl, "GET", "/api/admin/summary", { token: prod.adminKey });
      assert.equal(plain.status, 403);
      assert.equal(plain.body.error, "HTTPS_REQUIRED");
      const proxied = await request(prod.baseUrl, "GET", "/api/admin/summary", { token: prod.adminKey, headers: { "X-Forwarded-Proto": "https" } });
      assert.equal(proxied.status, 200);
      assert.match(proxied.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
      assert.equal((await request(prod.baseUrl, "GET", "/health")).status, 200, "health probe stays reachable");
      // A forged header is only honoured from trusted hops: with 0 hops, req.secure stays false.
      const untrusted = await startTestApp(mock, { config: { ...app.config, nodeEnv: "production", trustProxyHops: 0 } });
      try {
        const forged = await request(untrusted.baseUrl, "GET", "/api/admin/summary", { token: untrusted.adminKey, headers: { "X-Forwarded-Proto": "https" } });
        assert.equal(forged.status, 403);
      } finally {
        await untrusted.close();
      }
    } finally {
      await prod.close();
    }
  });
});

describe("rate limiting", () => {
  it("limits payment requests per agent", async () => {
    const limited = await startTestApp(mock, { env: { AGENT_PAYMENT_RATE_LIMIT_PER_MINUTE: "3" } });
    try {
      const key = await createAgent(limited, { agentId: "agent-ratelimited" });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await limited.as(key, "POST", "/api/agent/transactions", purchase({ amount: "1.00" }))).status);
      assert.deepEqual(statuses.slice(3), [429, 429]);
    } finally {
      await limited.close();
    }
  });

  it("limits requests per IP across the API (unauthenticated floods too)", async () => {
    const limited = await startTestApp(mock, { env: { RATE_LIMIT_PER_MINUTE: "5" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await limited.as(null, "GET", "/api/admin/agents")).status);
      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.deepEqual(statuses.slice(5), [429, 429]);
    } finally {
      await limited.close();
    }
  });

  it("ignores spoofed X-Forwarded-For when no proxy is trusted", async () => {
    const limited = await startTestApp(mock, { env: { RATE_LIMIT_PER_MINUTE: "2" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await request(limited.baseUrl, "GET", "/health", { headers: { "X-Forwarded-For": `10.0.0.${i}` } })).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
