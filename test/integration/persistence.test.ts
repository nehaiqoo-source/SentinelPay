import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createPool } from "../../src/db/pool.js";
import { bootstrapOperator, purchase, request, resetDatabase, TEST_DATABASE_URL, testEnv } from "../helpers/harness.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

/**
 * Runs the real server entry point (src/server.ts) as a child process, kills it
 * with SIGKILL (no graceful shutdown) and restarts it against the same database.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let mock: MockPayPal;
let env: NodeJS.ProcessEnv;
let port: number;
let baseUrl: string;
let server: ChildProcess | null = null;
let output = "";
let operatorKey = "";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function spawnServer(extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  return child;
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  server = spawnServer(extraEnv);
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${baseUrl}/health`).then((r) => r.ok, () => false);
    if (ok) return;
    if (server.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${output}`);
}

async function crashServer(): Promise<void> {
  if (!server) return;
  const exited = new Promise((resolve) => server!.once("exit", resolve));
  server.kill("SIGKILL");
  await exited;
  server = null;
}

const admin = (method: string, path: string, body?: unknown) => request(baseUrl, method, path, { token: operatorKey, body });
const asAgent = (key: string, method: string, path: string, body?: unknown) => request(baseUrl, method, path, { token: key, body });

let agentKey = "";

before(async () => {
  await resetDatabase();
  const bootstrapDb = createPool(TEST_DATABASE_URL);
  operatorKey = await bootstrapOperator(bootstrapDb, "persistence-admin", "ADMIN");
  await bootstrapDb.end();
  mock = await startMockPayPal();
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  env = testEnv(mock, {
    PORT: String(port),
    APP_BASE_URL: baseUrl,
    // Explicit blanks so values from a developer's .env can never leak into this test.
    ADMIN_API_KEY: "",
    AUDIT_SIGNING_KEY_FILE: "",
    AUDIT_CHECKPOINT_FILE: "",
    MIGRATION_DATABASE_URL: "",
    PAYPAL_VAULT_PAYMENT_TOKEN: "",
    PAYPAL_VAULT_TOKEN_TYPE: "",
    CORS_ALLOWED_ORIGINS: "",
    STALE_IN_FLIGHT_SECONDS: "1",
    SWEEP_INTERVAL_SECONDS: "1",
  });
});
after(async () => {
  await crashServer();
  await mock.close();
});

describe("durable ledger across process crashes", () => {
  const replayBody = purchase({ amount: "25.00", requestId: "persist-replay-1" });
  let pendingId = "";
  let replayOrderId = "";

  it("records state, then survives SIGKILL with balances and transactions intact", async () => {
    await startServer();
    const created = await admin("POST", "/api/admin/agents", {
      agentId: "durable",
      displayName: "durable",
      perTransactionCap: "25.00",
      dailyCap: "100.00",
      allowedMerchants: null,
      allowedCategories: null,
    });
    assert.equal(created.status, 201);
    agentKey = created.body.apiKey;

    const first = await asAgent(agentKey, "POST", "/api/agent/transactions", replayBody);
    assert.equal(first.status, 202);
    replayOrderId = first.body.orderId;

    const second = await asAgent(agentKey, "POST", "/api/agent/transactions", purchase({ amount: "25.00" }));
    mock.approve(second.body.orderId);
    assert.equal((await asAgent(agentKey, "POST", `/api/agent/orders/${second.body.orderId}/capture`)).body.transaction.status, "COMPLETED");
    pendingId = first.body.transactionId;

    const before = (await admin("GET", "/api/admin/summary")).body;
    assert.deepEqual([before.reservedToday, before.committedToday], ["25.00", "25.00"]);

    await crashServer();
    await startServer();

    const after = (await admin("GET", "/api/admin/summary")).body;
    assert.deepEqual([after.reservedToday, after.committedToday], ["25.00", "25.00"]);
    const tx = await asAgent(agentKey, "GET", `/api/agent/transactions/${pendingId}`);
    assert.equal(tx.body.status, "PENDING_APPROVAL");
  });

  it("idempotent replay after restart returns the original order (no duplicate payment)", async () => {
    const ordersBefore = mock.counters.ordersCreated;
    const replay = await asAgent(agentKey, "POST", "/api/agent/transactions", replayBody);
    assert.equal(replay.body.orderId, replayOrderId);
    assert.equal(mock.counters.ordersCreated, ordersBefore);
  });

  it("the daily cap still counts spend from before the restart", async () => {
    assert.equal((await asAgent(agentKey, "POST", "/api/agent/transactions", purchase({ amount: "25.00" }))).status, 202);
    assert.equal((await asAgent(agentKey, "POST", "/api/agent/transactions", purchase({ amount: "25.00" }))).status, 202);
    const over = await asAgent(agentKey, "POST", "/api/agent/transactions", purchase({ amount: "0.01" }));
    assert.equal(over.status, 403);
    assert.equal(over.body.violations[0].code, "DAILY_SPENDING_CAP");
  });

  it("a crash during the PayPal call leaves the budget reserved and flags the transaction for reconciliation", async () => {
    // Free budget so the in-flight request is accepted.
    const list = (await admin("GET", "/api/admin/transactions?status=PENDING_APPROVAL")).body.transactions;
    for (const t of list) await admin("POST", `/api/admin/transactions/${t.transactionId}/cancel`, { reason: "free budget" });

    mock.delayMs = 3_000;
    const inFlight = asAgent(agentKey, "POST", "/api/agent/transactions", purchase({ amount: "20.00", requestId: "persist-crash-1" })).catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    await crashServer();
    await inFlight;
    mock.delayMs = 0;

    await startServer();
    let status = "";
    let tx: any;
    for (let i = 0; i < 40 && status !== "RECONCILE_REQUIRED"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const rows = (await admin("GET", "/api/admin/transactions?limit=500")).body.transactions;
      tx = rows.find((t: any) => t.requestId === "persist-crash-1");
      status = tx?.status ?? "";
    }
    assert.equal(status, "RECONCILE_REQUIRED");
    assert.equal(tx.budgetState, "RESERVED");

    // PayPal received the create (after its delay). RETRY_CREATE reuses the PayPal-Request-Id.
    await new Promise((r) => setTimeout(r, 3_000));
    const ordersBefore = mock.counters.ordersCreated;
    const reconciled = await admin("POST", `/api/admin/transactions/${tx.transactionId}/reconcile`, { resolution: "RETRY_CREATE" });
    assert.equal(reconciled.body.status, "PENDING_APPROVAL");
    assert.equal(mock.counters.ordersCreated, ordersBefore, "reconciliation did not create a second PayPal order");
  });

  it("never writes secrets, tokens or API keys to the process logs", () => {
    assert.ok(output.length > 0);
    for (const secret of [
      operatorKey,
      env.PAYPAL_CLIENT_SECRET!,
      agentKey,
      "mock-access-token",
      Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"),
    ]) {
      assert.ok(!output.includes(secret), `log output contains a secret (${secret.slice(0, 6)}...)`);
    }
  });
});

describe("startup without a database", () => {
  it("refuses to start (no silent in-memory fallback)", async () => {
    const offset = output.length;
    const deadPort = await freePort();
    const child = spawnServer({ DATABASE_URL: "postgresql://sentinelpay:x@127.0.0.1:1/sentinelpay_test", PORT: String(deadPort) });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const childOutput = output.slice(offset);
    assert.equal(code, 1);
    assert.match(childOutput, /ECONNREFUSED/);
    assert.doesNotMatch(childOutput, /listening on port/);
    assert.equal(await fetch(`http://127.0.0.1:${deadPort}/health`).then(() => "up", () => "down"), "down");
  });
});
