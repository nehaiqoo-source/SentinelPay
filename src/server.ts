import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { AssistantService } from "./assistant/assistantService.js";
import { OperatorStore } from "./auth/operators.js";
import { loadConfig, loadDotEnv } from "./config/env.js";
import { inspectConnectedRole } from "./db/appRole.js";
import { assertMigrationsCurrent } from "./db/migrate.js";
import { assertDatabaseReachable, createPool, type Db } from "./db/pool.js";
import { createCheckpoint, signerFromPem, type CheckpointSigner } from "./engine/auditCheckpoints.js";
import { SentinelGuard } from "./engine/sentinelGuard.js";
import { LedgerStore } from "./engine/store.js";
import { PayPalService } from "./services/paypal.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  // No in-memory fallback: if the ledger is unavailable, refuse to start.
  const db = createPool(config.databaseUrl);
  await assertDatabaseReachable(db);
  await assertMigrationsCurrent(db);

  // A role that owns the audit table (or is superuser) can disable its triggers and rewrite history.
  const role = await inspectConnectedRole(db);
  if (role.superuser || role.ownsAuditLog) {
    const message = `Database role "${role.user}" is ${role.superuser ? "a superuser" : "the owner of audit_events"}; run as the least-privilege app role (npm run db:app-role)`;
    if (config.nodeEnv === "production") throw new Error(message);
    console.warn(`WARNING: ${message}`);
  }

  const auditSigner: CheckpointSigner | null = config.auditSigningKeyFile ? signerFromPem(readFileSync(config.auditSigningKeyFile, "utf8")) : null;
  if (!auditSigner) console.warn("WARNING: AUDIT_SIGNING_KEY_FILE not set; audit checkpoints are disabled");

  const store = new LedgerStore(db);
  const operators = new OperatorStore(db);
  const gateway = new PayPalService({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    baseUrl: config.paypal.baseUrl,
    vault: config.paypal.vault,
    returnUrl: `${config.appBaseUrl}/?approval=returned`,
    cancelUrl: `${config.appBaseUrl}/?approval=cancelled`,
  });
  const guard = new SentinelGuard({
    store,
    gateway,
    global: { perTransactionCapCents: config.globalPerTransactionCapCents, dailyCapCents: config.globalDailyCapCents },
    pendingApprovalTtlMs: config.pendingApprovalTtlMs,
  });

  const runSweep = async () => {
    try {
      const { expired, flagged } = await guard.sweep(config.staleInFlightMs);
      if (expired || flagged) console.log(`Sweep: ${expired} approval(s) expired, ${flagged} transaction(s) need reconciliation`);
      if (auditSigner) {
        const checkpoint = await createCheckpoint(db, auditSigner, config.auditCheckpointFile);
        if (checkpoint) console.log(`Audit checkpoint signed at seq ${checkpoint.seq}`);
      }
    } catch (error) {
      console.error("Sweep failed:", error instanceof Error ? error.message : "unknown error");
    }
  };
  await runSweep();
  const sweeper = setInterval(runSweep, config.sweepIntervalMs);

  const assistant = new AssistantService({
    store,
    guard,
    model: config.assistant.geminiApiKey ? { apiKey: config.assistant.geminiApiKey, model: config.assistant.model } : null,
  });
  if (!assistant.available) console.warn("WARNING: GEMINI_API_KEY not set; the in-app AI assistant is disabled");

  const app = createApp({ config, db, store, guard, operators, assistant, auditSigner });
  const server = app.listen(config.port, () => {
    console.log(
      `SentinelPay listening on port ${config.port} (${config.nodeEnv}, PayPal: ${config.paypal.baseUrl}, vault: ${gateway.executionMode === "AUTONOMOUS" ? "configured" : "none"}, db role: ${role.user}, assistant: ${assistant.available ? assistant.modelName : "disabled"})`,
    );
  });
  installShutdown(server, db, sweeper);
}

function installShutdown(server: Server, db: Db, sweeper: NodeJS.Timeout): void {
  server.on("error", (error) => {
    console.error("Server failed to start:", error.message);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    clearInterval(sweeper);

    const forceExit = setTimeout(() => {
      console.error(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async (error) => {
      await db.end().catch(() => undefined);
      if (error) {
        console.error("Error while closing server:", error.message);
        process.exit(1);
      }
      console.log("Server closed");
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason instanceof Error ? reason.message : "non-Error reason");
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error.stack ?? error.message);
    shutdown("uncaughtException");
  });
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
