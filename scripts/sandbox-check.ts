/**
 * Real PayPal SANDBOX end-to-end check (no mocks). Creates one $1.00 order using
 * the configured mode, waits for buyer approval when needed, captures it, and
 * prints the actual PayPal ids and statuses as evidence.
 *
 *   npm run sandbox:check
 *
 * Refuses to run against anything but https://api-m.sandbox.paypal.com.
 */
import { loadDotEnv, PAYPAL_SANDBOX_HOST } from "../src/config/env.js";
import { PayPalApiError, PayPalService, type VaultSource } from "../src/services/paypal.js";

const AMOUNT_CENTS = 100;
const APPROVAL_WAIT_MS = 10 * 60_000;

loadDotEnv();
const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
const baseUrl = (process.env.PAYPAL_BASE_URL?.trim() || `https://${PAYPAL_SANDBOX_HOST}`).replace(/\/+$/, "");

if (new URL(baseUrl).hostname !== PAYPAL_SANDBOX_HOST || !baseUrl.startsWith("https://")) {
  console.error(`BLOCKED: PAYPAL_BASE_URL must be https://${PAYPAL_SANDBOX_HOST}; refusing to touch any other PayPal environment.`);
  process.exit(2);
}
if (!clientId || !clientSecret || /^</.test(clientId) || /^</.test(clientSecret)) {
  console.error("BLOCKED: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set to sandbox credentials in .env.");
  process.exit(2);
}

const token = process.env.PAYPAL_VAULT_PAYMENT_TOKEN?.trim();
const tokenType = process.env.PAYPAL_VAULT_TOKEN_TYPE?.trim();
const vault: VaultSource | null =
  token && (tokenType === "PAYPAL_VAULT_ID" || tokenType === "BILLING_AGREEMENT") ? { type: tokenType, token } : null;

const paypal = new PayPalService({
  clientId,
  clientSecret,
  baseUrl,
  vault,
  returnUrl: "https://example.com/sentinelpay-sandbox-return",
  cancelUrl: "https://example.com/sentinelpay-sandbox-cancel",
});

const requestId = `sandbox-check-${Date.now()}`;
const log = (label: string, value: unknown) => console.log(`${label.padEnd(22)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

try {
  await paypal.getAccessToken();
  log("OAuth token", "obtained (value not printed)");
  log("Mode", paypal.executionMode);

  const outcome = await paypal.executePayment({ amountCents: AMOUNT_CENTS, description: "SentinelPay sandbox check", requestId, useVault: vault !== null });
  log("Order id", outcome.orderId);
  log("Outcome", outcome.status);

  let captureResult;
  if (outcome.status === "PENDING_APPROVAL") {
    console.log(`\nApprove the order as a sandbox BUYER (personal sandbox account):\n  ${outcome.approvalUrl}\n`);
    console.log("Waiting for approval (polls every 5s, up to 10 minutes)...");
    const deadline = Date.now() + APPROVAL_WAIT_MS;
    for (;;) {
      const order = await paypal.getOrder(outcome.orderId);
      if (order.status === "APPROVED" || order.status === "COMPLETED") break;
      if (Date.now() > deadline) throw new Error(`order still ${order.status} after waiting`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    const early = await paypal.captureOrder({ orderId: outcome.orderId, requestId: `${requestId}:capture` });
    captureResult = early;
    // Idempotency check: the same PayPal-Request-Id must not capture twice.
    const replay = await paypal.captureOrder({ orderId: outcome.orderId, requestId: `${requestId}:capture` });
    log("Replay same request id", replay.success ? replay.captures.map((c) => c.captureId) : replay.code);
  } else {
    captureResult = { success: true as const, orderId: outcome.orderId, status: "COMPLETED" as const, captures: outcome.captures };
  }

  if (!captureResult.success) throw new Error(`capture not possible: ${captureResult.code}`);
  for (const c of captureResult.captures) {
    log("Capture id", c.captureId);
    log("Capture status", c.status);
    log("Captured amount", c.amount);
  }
  const final = await paypal.getOrder(outcome.orderId);
  log("Final order status", final.status);
  console.log("\nRESULT: PASS (real PayPal sandbox responses above)");
} catch (error) {
  if (error instanceof PayPalApiError) {
    console.error(`RESULT: FAIL ${error.message} (HTTP ${error.statusCode ?? "n/a"}, debug_id ${error.debugId ?? "n/a"})`);
  } else {
    console.error(`RESULT: FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
