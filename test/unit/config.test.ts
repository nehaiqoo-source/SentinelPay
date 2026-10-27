import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/db",
  PAYPAL_CLIENT_ID: "sandbox-client-id",
  PAYPAL_CLIENT_SECRET: "sandbox-client-secret",
};

const problemsFor = (overrides: Record<string, string | undefined>): string => {
  try {
    loadConfig({ ...valid, ...overrides });
    return "";
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.message;
  }
};

describe("loadConfig", () => {
  it("accepts a sandbox configuration and defaults to the sandbox host", () => {
    const config = loadConfig(valid);
    assert.equal(config.paypal.baseUrl, "https://api-m.sandbox.paypal.com");
    assert.deepEqual(config.corsAllowedOrigins, []);
    assert.equal(config.trustProxyHops, 0);
  });

  it("refuses the live PayPal endpoint and arbitrary hosts", () => {
    assert.match(problemsFor({ PAYPAL_BASE_URL: "https://api-m.paypal.com" }), /only https:\/\/api-m\.sandbox\.paypal\.com/);
    assert.match(problemsFor({ PAYPAL_BASE_URL: "https://api.paypal.com" }), /PAYPAL_BASE_URL/);
    assert.match(problemsFor({ PAYPAL_BASE_URL: "http://api-m.sandbox.paypal.com" }), /PAYPAL_BASE_URL/);
    assert.match(problemsFor({ PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com.evil.example" }), /PAYPAL_BASE_URL/);
  });

  it("allows loopback mocks only outside production", () => {
    assert.equal(problemsFor({ PAYPAL_BASE_URL: "http://127.0.0.1:9999" }), "");
    assert.match(problemsFor({ NODE_ENV: "production", PAYPAL_BASE_URL: "http://127.0.0.1:9999" }), /PAYPAL_BASE_URL/);
  });

  it("refuses the retired shared ADMIN_API_KEY so nobody assumes it still grants access", () => {
    assert.match(problemsFor({ ADMIN_API_KEY: "a".repeat(48) }), /shared admin key has been retired/);
    assert.equal(problemsFor({ ADMIN_API_KEY: "" }), "");
  });

  it("production refuses to start without HTTPS URL, proxy, https-only CORS and audit signing", () => {
    const prod = problemsFor({ NODE_ENV: "production", APP_BASE_URL: "http://pay.example.com", CORS_ALLOWED_ORIGINS: "http://dash.example.com" });
    assert.match(prod, /APP_BASE_URL: production requires an https/);
    assert.match(prod, /TRUST_PROXY_HOPS/);
    assert.match(prod, /CORS_ALLOWED_ORIGINS: production allows only https/);
    assert.match(prod, /AUDIT_SIGNING_KEY_FILE and AUDIT_CHECKPOINT_FILE are required/);
    assert.equal(
      problemsFor({
        NODE_ENV: "production",
        APP_BASE_URL: "https://pay.example.com",
        TRUST_PROXY_HOPS: "1",
        CORS_ALLOWED_ORIGINS: "https://dash.example.com",
        AUDIT_SIGNING_KEY_FILE: "/run/secrets/audit.pem",
        AUDIT_CHECKPOINT_FILE: "/mnt/worm/checkpoints.jsonl",
      }),
      "",
    );
  });

  it("rejects placeholder PayPal credentials", () => {
    assert.match(problemsFor({ PAYPAL_CLIENT_SECRET: "<sandbox-client-secret>" }), /placeholder/);
  });

  it("rejects CORS wildcards and non-origin values", () => {
    assert.match(problemsFor({ CORS_ALLOWED_ORIGINS: "*" }), /CORS_ALLOWED_ORIGINS/);
    assert.match(problemsFor({ CORS_ALLOWED_ORIGINS: "https://app.example.com/path" }), /CORS_ALLOWED_ORIGINS/);
    assert.deepEqual(loadConfig({ ...valid, CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example" }).corsAllowedOrigins, [
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("requires an explicit vault token type and validates the token format", () => {
    assert.match(problemsFor({ PAYPAL_VAULT_PAYMENT_TOKEN: "abc123" }), /PAYPAL_VAULT_TOKEN_TYPE/);
    assert.match(problemsFor({ PAYPAL_VAULT_PAYMENT_TOKEN: "bad token!", PAYPAL_VAULT_TOKEN_TYPE: "PAYPAL_VAULT_ID" }), /token pattern/);
    assert.deepEqual(loadConfig({ ...valid, PAYPAL_VAULT_PAYMENT_TOKEN: "8kk8451t", PAYPAL_VAULT_TOKEN_TYPE: "PAYPAL_VAULT_ID" }).paypal.vault, {
      type: "PAYPAL_VAULT_ID",
      token: "8kk8451t",
    });
  });

  it("requires DATABASE_URL (no in-memory fallback)", () => {
    assert.match(problemsFor({ DATABASE_URL: undefined }), /DATABASE_URL/);
  });

  it("rejects a per-transaction cap above the daily cap", () => {
    assert.match(problemsFor({ PER_TRANSACTION_CAP: "50.00", DAILY_SPENDING_CAP: "10.00" }), /must not exceed/);
  });
});
