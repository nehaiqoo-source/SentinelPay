import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { OperatorStore } from "./auth/operators.js";
import type { Config } from "./config/env.js";
import type { Db } from "./db/pool.js";
import type { CheckpointSigner } from "./engine/auditCheckpoints.js";
import { GuardError, type SentinelGuard } from "./engine/sentinelGuard.js";
import type { LedgerStore } from "./engine/store.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAgentRouter } from "./routes/agent.js";
import { PayPalApiError } from "./services/paypal.js";

// Resolves to <project>/public from both src/ (tsx) and dist/ (compiled).
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// AG Grid is served from node_modules so the CSP can forbid third-party scripts.
// (The package does not export ./package.json, so resolve by path from src/ or dist/.)
const AG_GRID_DIR = fileURLToPath(new URL("../node_modules/ag-grid-community", import.meta.url));

export interface AppDeps {
  config: Config;
  db: Db;
  store: LedgerStore;
  guard: SentinelGuard;
  operators: OperatorStore;
  auditSigner: CheckpointSigner | null;
}

export function createApp({ config, db, store, guard, operators, auditSigner }: AppDeps): express.Express {
  const app = express();
  const startedAt = Date.now();

  app.disable("x-powered-by");
  // Only trust X-Forwarded-For when a known number of proxies sits in front.
  app.set("trust proxy", config.trustProxyHops);
  app.use(requestLogger);
  if (config.nodeEnv === "production") app.use(requireHttps);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(
    cors({
      // No wildcard: unlisted origins get no CORS headers, so browsers block the response.
      origin: (origin, callback) => callback(null, origin !== undefined && config.corsAllowedOrigins.includes(origin)),
      methods: ["GET", "POST", "PUT"],
      allowedHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "RATE_LIMITED", message: "Too many requests; slow down" },
    }),
  );
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", async (_req, res) => {
    const database = await db
      .query("SELECT 1")
      .then(() => "ok" as const)
      .catch(() => "unavailable" as const);
    res.status(database === "ok" ? 200 : 503).json({
      status: database === "ok" ? "ok" : "degraded",
      service: "sentinelpay",
      database,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.use("/api/agent", createAgentRouter({ store, guard, paymentRateLimitPerMinute: config.agentPaymentRateLimitPerMinute }));
  app.use(
    "/api/admin",
    createAdminRouter({
      db,
      store,
      guard,
      operators,
      global: { perTransactionCapCents: config.globalPerTransactionCapCents, dailyCapCents: config.globalDailyCapCents },
      authFailureLimitPerMinute: config.authFailureLimitPerMinute,
      audit: { signer: auditSigner, externalFile: config.auditCheckpointFile },
    }),
  );
  // Only the built bundle and stylesheets; not package metadata or sources.
  app.use("/vendor/ag-grid/dist", express.static(`${AG_GRID_DIR}/dist`, { index: false, fallthrough: false }));
  app.use("/vendor/ag-grid/styles", express.static(`${AG_GRID_DIR}/styles`, { index: false, fallthrough: false }));
  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` });
  });
  app.use(errorHandler);

  return app;
}

/** Logs method, path (no query string: PayPal return URLs carry payer ids) and status. */
const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
};

/**
 * Production: refuse plain-HTTP requests (bearer keys must never cross the network
 * unencrypted). req.secure reflects X-Forwarded-Proto only from the trusted proxy hops.
 * /health stays reachable for load-balancer probes and exposes nothing sensitive.
 */
const requireHttps: RequestHandler = (req, res, next) => {
  if (req.secure || req.path === "/health") return next();
  res.status(403).json({ error: "HTTPS_REQUIRED", message: "Use HTTPS" });
};

const errorHandler: ErrorRequestHandler =(err: unknown, _req, res, _next) => {
  if (err instanceof GuardError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  if (err instanceof PayPalApiError) {
    // PayPalApiError never carries request headers or credentials.
    console.error(err.message, { statusCode: err.statusCode, debugId: err.debugId });
    const status = err.statusCode !== null && err.statusCode >= 400 && err.statusCode < 500 ? 422 : 502;
    res.status(status).json({ error: "PAYPAL_ERROR", message: err.message, debugId: err.debugId, retryable: err.isRetryable });
    return;
  }

  // body-parser errors (malformed JSON, payload too large) carry a 4xx status.
  if (isHttpError(err) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", message: err.expose ? err.message : "Bad request" });
    return;
  }

  // Log only name/message/stack, never the whole object (which could hold request data).
  console.error("Unhandled error:", err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : "non-Error thrown");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" });
};

function isHttpError(err: unknown): err is Error & { status: number; expose?: boolean } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}
