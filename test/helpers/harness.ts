import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { AssistantService } from "../../src/assistant/assistantService.js";
import { OperatorStore } from "../../src/auth/operators.js";
import { loadConfig, type Config } from "../../src/config/env.js";
import { ensureAppRole } from "../../src/db/appRole.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createPool, type Db } from "../../src/db/pool.js";
import type { CheckpointSigner } from "../../src/engine/auditCheckpoints.js";
import { SentinelGuard } from "../../src/engine/sentinelGuard.js";
import { LedgerStore } from "../../src/engine/store.js";
import type { OperatorRole } from "../../src/models/types.js";
import { PayPalService, type VaultSource } from "../../src/services/paypal.js";
import { startMockPayPal, type MockPayPal } from "./mockPayPal.js";

/** Owner connection: schema setup and deliberate tampering only. */
export const TEST_OWNER_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://sentinelpay:sentinelpay_local_dev@127.0.0.1:5433/sentinelpay_test";
/** The app under test runs as this least-privilege role, like production should. */
export const TEST_APP_ROLE = "sentinelpay_app_test";
const TEST_APP_PASSWORD = "sentinelpay_app_test_local_only";
export const TEST_DATABASE_URL = (() => {
  const url = new URL(TEST_OWNER_DATABASE_URL);
  url.username = TEST_APP_ROLE;
  url.password = TEST_APP_PASSWORD;
  return url.toString();
})();

/** Drops and recreates the test schema, applies migrations and the runtime role's grants. Never touches the dev database. */
export async function resetDatabase(): Promise<void> {
  if (!/\/sentinelpay_test(\?|$)/.test(TEST_OWNER_DATABASE_URL)) {
    throw new Error("Refusing to reset a database that is not sentinelpay_test");
  }
  const db = createPool(TEST_OWNER_DATABASE_URL);
  try {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(db);
    await ensureAppRole(db, TEST_APP_ROLE, TEST_APP_PASSWORD);
  } finally {
    await db.end();
  }
}

export function testEnv(mock: MockPayPal, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: TEST_DATABASE_URL,
    PAYPAL_CLIENT_ID: "test-client-id",
    PAYPAL_CLIENT_SECRET: `test-client-secret-${randomBytes(8).toString("hex")}`,
    PAYPAL_BASE_URL: mock.baseUrl,
    PER_TRANSACTION_CAP: "25.00",
    DAILY_SPENDING_CAP: "100.00",
    RATE_LIMIT_PER_MINUTE: "100000",
    AGENT_PAYMENT_RATE_LIMIT_PER_MINUTE: "100000",
    AUTH_FAILURE_LIMIT_PER_MINUTE: "100000",
    ...overrides,
  };
}

/** Creates an operator directly in the database (the bootstrap path the CLI uses). */
export async function bootstrapOperator(db: Db, operatorId: string, role: OperatorRole): Promise<string> {
  const created = await new OperatorStore(db).create(
    { operatorId, displayName: operatorId, role, expiresAt: null },
    { type: "SYSTEM", id: "test-bootstrap" },
  );
  return created.apiKey;
}

export interface TestApp {
  baseUrl: string;
  config: Config;
  /** App connection (least-privilege role). */
  db: Db;
  /** Owner connection, for tests that deliberately tamper with data. */
  ownerDb: Db;
  store: LedgerStore;
  guard: SentinelGuard;
  /** The bootstrap ADMIN operator's key. */
  adminKey: string;
  /** Calls the API with the bootstrap ADMIN operator key. */
  admin(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  /** Calls the API with any key (or none). */
  as(apiKey: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  close(): Promise<void>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let payload: string | undefined;
  if (options.rawBody !== undefined) {
    payload = options.rawBody;
    headers["Content-Type"] ??= "application/json";
  } else if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    payload = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body (static files)
  }
  return { status: res.status, headers: res.headers, body };
}

let adminCounter = 0;

/** Builds a full app (real Postgres ledger as the app role, PayPal client pointed at the mock) on an ephemeral port. */
export async function startTestApp(
  mock: MockPayPal,
  options: {
    env?: Record<string, string>;
    vault?: VaultSource | null;
    paypalTimeoutMs?: number;
    config?: Config;
    auditSigner?: CheckpointSigner | null;
    adminKey?: string;
  } = {},
): Promise<TestApp> {
  const config = options.config ?? loadConfig(testEnv(mock, options.env));
  const db = createPool(config.databaseUrl);
  const ownerDb = createPool(TEST_OWNER_DATABASE_URL);
  const store = new LedgerStore(db);
  const operators = new OperatorStore(db);
  const gateway = new PayPalService({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    baseUrl: config.paypal.baseUrl,
    vault: options.vault === undefined ? config.paypal.vault : options.vault,
    returnUrl: "http://localhost/return",
    cancelUrl: "http://localhost/cancel",
    timeoutMs: options.paypalTimeoutMs ?? 1_500,
    logger: null,
  });
  const guard = new SentinelGuard({
    store,
    gateway,
    global: { perTransactionCapCents: config.globalPerTransactionCapCents, dailyCapCents: config.globalDailyCapCents },
    pendingApprovalTtlMs: config.pendingApprovalTtlMs,
  });
  const adminKey = options.adminKey ?? (await bootstrapOperator(db, `test-admin-${process.pid}-${++adminCounter}`, "ADMIN"));
  const assistant = new AssistantService({
    store,
    guard,
    model: config.assistant.geminiApiKey ? { apiKey: config.assistant.geminiApiKey, model: config.assistant.model } : null,
  });
  const app = createApp({ config, db, store, guard, operators, assistant, auditSigner: options.auditSigner ?? null });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    config,
    db,
    ownerDb,
    store,
    guard,
    adminKey,
    admin: (method, path, body) => request(baseUrl, method, path, { token: adminKey, body }),
    as: (apiKey, method, path, body, headers) => request(baseUrl, method, path, { token: apiKey, body, ...(headers ? { headers } : {}) }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.end();
      await ownerDb.end();
    },
  };
}

export interface AgentSpec {
  agentId: string;
  perTransactionCap?: string;
  dailyCap?: string;
  autonomousLimit?: string;
  allowedMerchants?: string[] | null;
  allowedCategories?: string[] | null;
}

/** Creates an agent through the admin API and returns its one-time API key. */
export async function createAgent(app: TestApp, spec: AgentSpec): Promise<string> {
  const res = await app.admin("POST", "/api/admin/agents", {
    agentId: spec.agentId,
    displayName: spec.agentId,
    perTransactionCap: spec.perTransactionCap ?? "25.00",
    dailyCap: spec.dailyCap ?? "100.00",
    ...(spec.autonomousLimit ? { autonomousLimit: spec.autonomousLimit } : {}),
    allowedMerchants: spec.allowedMerchants === undefined ? null : spec.allowedMerchants,
    allowedCategories: spec.allowedCategories === undefined ? null : spec.allowedCategories,
  });
  if (res.status !== 201) throw new Error(`createAgent failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.apiKey as string;
}

/** Creates an operator through the admin API and returns its one-time key. */
export async function createOperator(app: TestApp, operatorId: string, role: OperatorRole, expiresInDays?: number): Promise<string> {
  const res = await app.admin("POST", "/api/admin/operators", {
    operatorId,
    displayName: operatorId,
    role,
    ...(expiresInDays ? { expiresInDays } : {}),
  });
  if (res.status !== 201) throw new Error(`createOperator failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.apiKey as string;
}

let requestCounter = 0;
export function purchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `req-${process.pid}-${++requestCounter}`,
    amount: "10.00",
    merchantId: "acme-store",
    category: "electronics",
    description: "USB-C cable, 2m",
    ...overrides,
  };
}

export { startMockPayPal };
