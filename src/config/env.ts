import dotenv from "dotenv";
import { z } from "zod";

/** The only real PayPal host SentinelPay will talk to. Live (api-m.paypal.com) is refused. */
export const PAYPAL_SANDBOX_HOST = "api-m.sandbox.paypal.com";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Matches template values, including the <angle-bracket> placeholders used in .env.example. */
const PLACEHOLDER_SECRET = /change[-_ ]?me|placeholder|example|your[-_]|^<.*>$/i;

const blankToUndefined = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);

const moneyString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "must be a non-negative USD amount with at most 2 decimals")
  .transform(Number);

const secret = (name: string, minLength: number) =>
  z
    .string()
    .trim()
    .min(minLength, `${name} must be at least ${minLength} characters`)
    .refine((value) => !PLACEHOLDER_SECRET.test(value), `${name} still contains a placeholder value`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(5000),

  DATABASE_URL: z
    .string()
    .trim()
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// connection string"),

  /** Retired: operators now have individual keys (npm run operator:create). Setting it is an error. */
  ADMIN_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  /** Failed operator authentications allowed per IP per minute. */
  AUTH_FAILURE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Ed25519 private key (PEM file) for signing audit checkpoints. Keep it outside the repo and the database. */
  AUDIT_SIGNING_KEY_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  /** Append-only JSONL file (ideally on separately controlled storage) receiving every checkpoint. */
  AUDIT_CHECKPOINT_FILE: z.preprocess(blankToUndefined, z.string().optional()),
  /** Comma-separated browser origins allowed to call the API cross-origin. Empty = same-origin only. */
  CORS_ALLOWED_ORIGINS: z.preprocess(blankToUndefined, z.string().optional()),
  /** Number of trusted reverse-proxy hops in front of the app; 0 trusts no X-Forwarded-For. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  AGENT_PAYMENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  PAYPAL_CLIENT_ID: secret("PAYPAL_CLIENT_ID", 1),
  PAYPAL_CLIENT_SECRET: secret("PAYPAL_CLIENT_SECRET", 1),
  PAYPAL_BASE_URL: z
    .url()
    .default(`https://${PAYPAL_SANDBOX_HOST}`)
    .transform((url) => url.replace(/\/+$/, "")),
  /** Vaulted payment source for autonomous mode; see PAYPAL_VAULT_TOKEN_TYPE. */
  PAYPAL_VAULT_PAYMENT_TOKEN: z.preprocess(
    blankToUndefined,
    z.string().trim().regex(/^[0-9a-zA-Z_-]{1,255}$/, "must match PayPal's token pattern ^[0-9a-zA-Z_-]+$").optional(),
  ),
  /** PAYPAL_VAULT_ID -> payment_source.paypal.vault_id; BILLING_AGREEMENT -> payment_source.token. */
  PAYPAL_VAULT_TOKEN_TYPE: z.preprocess(blankToUndefined, z.enum(["PAYPAL_VAULT_ID", "BILLING_AGREEMENT"]).optional()),
  APP_BASE_URL: z
    .preprocess(blankToUndefined, z.url().optional())
    .transform((url) => url?.replace(/\/+$/, "")),

  /** Global ceilings; no agent policy may exceed them. */
  DAILY_SPENDING_CAP: moneyString.default(100),
  PER_TRANSACTION_CAP: moneyString.default(25),
  PENDING_APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(180),
  /** In-flight work untouched this long is flagged RECONCILE_REQUIRED (must exceed the 15s PayPal timeout). */
  STALE_IN_FLIGHT_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
});

export interface Config {
  nodeEnv: "development" | "production" | "test";
  port: number;
  databaseUrl: string;
  corsAllowedOrigins: string[];
  authFailureLimitPerMinute: number;
  auditSigningKeyFile: string | null;
  auditCheckpointFile: string | null;
  trustProxyHops: number;
  rateLimitPerMinute: number;
  agentPaymentRateLimitPerMinute: number;
  paypal: {
    clientId: string;
    clientSecret: string;
    baseUrl: string;
    vault: { type: "PAYPAL_VAULT_ID" | "BILLING_AGREEMENT"; token: string } | null;
  };
  appBaseUrl: string;
  globalPerTransactionCapCents: number;
  globalDailyCapCents: number;
  pendingApprovalTtlMs: number;
  staleInFlightMs: number;
  sweepIntervalMs: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Parses and validates configuration; throws ConfigError listing every problem. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw configError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  const env = parsed.data;
  const problems: string[] = [];

  const paypalUrl = new URL(env.PAYPAL_BASE_URL);
  const isSandbox = paypalUrl.protocol === "https:" && paypalUrl.hostname === PAYPAL_SANDBOX_HOST;
  const isLocalMock = LOOPBACK_HOSTS.has(paypalUrl.hostname) && env.NODE_ENV !== "production";
  if (!isSandbox && !isLocalMock) {
    problems.push(
      `PAYPAL_BASE_URL: only https://${PAYPAL_SANDBOX_HOST} is allowed (live PayPal and other hosts are refused; loopback mocks only outside production)`,
    );
  }

  if (env.PAYPAL_VAULT_PAYMENT_TOKEN && !env.PAYPAL_VAULT_TOKEN_TYPE) {
    problems.push("PAYPAL_VAULT_TOKEN_TYPE: required when PAYPAL_VAULT_PAYMENT_TOKEN is set (PAYPAL_VAULT_ID or BILLING_AGREEMENT)");
  }
  if (env.PER_TRANSACTION_CAP <= 0 || env.DAILY_SPENDING_CAP <= 0) {
    problems.push("PER_TRANSACTION_CAP and DAILY_SPENDING_CAP must be greater than 0");
  }
  if (env.PER_TRANSACTION_CAP > env.DAILY_SPENDING_CAP) {
    problems.push(`PER_TRANSACTION_CAP (${env.PER_TRANSACTION_CAP}) must not exceed DAILY_SPENDING_CAP (${env.DAILY_SPENDING_CAP})`);
  }
  if (env.ADMIN_API_KEY !== undefined) {
    problems.push(
      "ADMIN_API_KEY: the shared admin key has been retired; remove it from .env and create a named operator with `npm run operator:create`",
    );
  }

  const corsAllowedOrigins: string[] = [];
  for (const raw of (env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)) {
    try {
      const url = new URL(raw);
      if (raw === "*" || url.origin !== raw.replace(/\/+$/, "")) throw new Error("not an origin");
      corsAllowedOrigins.push(url.origin);
    } catch {
      problems.push(`CORS_ALLOWED_ORIGINS: "${raw}" is not an exact origin like https://app.example.com (wildcards are not allowed)`);
    }
  }

  // Production must not be reachable without TLS, a known proxy, tight CORS and signed audit checkpoints.
  if (env.NODE_ENV === "production") {
    if (!env.APP_BASE_URL || !env.APP_BASE_URL.startsWith("https://")) {
      problems.push("APP_BASE_URL: production requires an https:// public URL");
    }
    if (env.TRUST_PROXY_HOPS < 1) {
      problems.push("TRUST_PROXY_HOPS: production must run behind a TLS-terminating reverse proxy (set the number of proxy hops, >= 1)");
    }
    if (corsAllowedOrigins.some((origin) => !origin.startsWith("https://"))) {
      problems.push("CORS_ALLOWED_ORIGINS: production allows only https:// origins");
    }
    if (!env.AUDIT_SIGNING_KEY_FILE || !env.AUDIT_CHECKPOINT_FILE) {
      problems.push("AUDIT_SIGNING_KEY_FILE and AUDIT_CHECKPOINT_FILE are required in production (signed audit checkpoints)");
    }
  }

  if (problems.length > 0) throw configError(problems);

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    corsAllowedOrigins,
    authFailureLimitPerMinute: env.AUTH_FAILURE_LIMIT_PER_MINUTE,
    auditSigningKeyFile: env.AUDIT_SIGNING_KEY_FILE ?? null,
    auditCheckpointFile: env.AUDIT_CHECKPOINT_FILE ?? null,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    agentPaymentRateLimitPerMinute: env.AGENT_PAYMENT_RATE_LIMIT_PER_MINUTE,
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl: env.PAYPAL_BASE_URL,
      vault:
        env.PAYPAL_VAULT_PAYMENT_TOKEN && env.PAYPAL_VAULT_TOKEN_TYPE
          ? { type: env.PAYPAL_VAULT_TOKEN_TYPE, token: env.PAYPAL_VAULT_PAYMENT_TOKEN }
          : null,
    },
    appBaseUrl: env.APP_BASE_URL ?? `http://localhost:${env.PORT}`,
    globalPerTransactionCapCents: Math.round(env.PER_TRANSACTION_CAP * 100),
    globalDailyCapCents: Math.round(env.DAILY_SPENDING_CAP * 100),
    pendingApprovalTtlMs: env.PENDING_APPROVAL_TTL_MINUTES * 60_000,
    staleInFlightMs: env.STALE_IN_FLIGHT_SECONDS * 1000,
    sweepIntervalMs: env.SWEEP_INTERVAL_SECONDS * 1000,
  };
}

/** Loads .env into process.env (never overriding variables already set). */
export function loadDotEnv(): void {
  dotenv.config({ quiet: true });
}

function configError(problems: string[]): ConfigError {
  return new ConfigError(
    `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\nCopy .env.example to .env and fill in the missing values.`,
  );
}
