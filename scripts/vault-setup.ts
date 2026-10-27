/**
 * One-time PayPal SANDBOX vault setup (buyer consent), per Orders v2:
 *   npm run vault:setup -- [--write-env]
 *
 * 1. Creates a $1.00 order with payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS.
 * 2. You approve it as a sandbox Personal buyer (this is the buyer's consent to save the wallet).
 * 3. The script captures it and reads payment_source.paypal.attributes.vault.id.
 *
 * The vault id is written to .secrets/paypal-vault-id (0600) and, with --write-env, into
 * .env as PAYPAL_VAULT_PAYMENT_TOKEN / PAYPAL_VAULT_TOKEN_TYPE=PAYPAL_VAULT_ID. It is never
 * printed in full. Requires the sandbox REST app to have "Save payment methods" (Vault) enabled.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv, PAYPAL_SANDBOX_HOST } from "../src/config/env.js";
import { PayPalApiError, PayPalService } from "../src/services/paypal.js";

const APPROVAL_WAIT_MS = 10 * 60_000;
loadDotEnv();
const baseUrl = (process.env.PAYPAL_BASE_URL?.trim() || `https://${PAYPAL_SANDBOX_HOST}`).replace(/\/+$/, "");
if (new URL(baseUrl).hostname !== PAYPAL_SANDBOX_HOST) {
  console.error("BLOCKED: only the PayPal sandbox is allowed");
  process.exit(2);
}
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.error("BLOCKED: sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  process.exit(2);
}

const paypal = new PayPalService({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  baseUrl,
  vault: null,
  returnUrl: "https://example.com/sentinelpay-vault-return",
  cancelUrl: "https://example.com/sentinelpay-vault-cancel",
});
const requestId = `vault-setup-${Date.now()}`;
const mask = (id: string) => `${id.slice(0, 3)}…${id.slice(-2)} (${id.length} chars)`;

try {
  const order = await paypal.createVaultSetupOrder({ amountCents: 100, description: "SentinelPay: save PayPal for agent payments", requestId });
  console.log(`Setup order ${order.orderId}: ${order.status}`);
  if (!order.approvalUrl) throw new Error("PayPal returned no approval link");
  console.log(`\nApprove as the sandbox Personal buyer (this consents to saving the wallet):\n  ${order.approvalUrl}\n`);
  console.log("Waiting for approval (polls every 5s, up to 10 minutes)...");

  const deadline = Date.now() + APPROVAL_WAIT_MS;
  for (;;) {
    const current = await paypal.getOrder(order.orderId);
    if (current.status === "APPROVED" || current.status === "COMPLETED") break;
    if (Date.now() > deadline) throw new Error(`order still ${current.status} after waiting`);
    await new Promise((r) => setTimeout(r, 5_000));
  }

  const capture = await paypal.captureOrder({ orderId: order.orderId, requestId: `${requestId}:capture` });
  if (!capture.success) throw new Error(`capture refused: ${capture.code}`);
  for (const c of capture.captures) console.log(`Capture ${c.captureId}: ${c.status} ${c.amount?.currency_code} ${c.amount?.value}`);

  const vault = capture.vault ?? (await paypal.getOrder(order.orderId)).vault;
  if (!vault) {
    console.error(
      "RESULT: FAIL captured, but PayPal returned no vault id. Enable 'Save payment methods' (Vault) for this sandbox app in the developer dashboard and retry.",
    );
    process.exit(1);
  }
  mkdirSync(".secrets", { recursive: true, mode: 0o700 });
  writeFileSync(".secrets/paypal-vault-id", `${vault.id}\n`, { mode: 0o600 });
  console.log(`Vault token ${mask(vault.id)} status ${vault.status ?? "unknown"}; saved to .secrets/paypal-vault-id`);

  if (process.argv.includes("--write-env")) {
    let env = readFileSync(".env", "utf8");
    for (const [key, value] of [
      ["PAYPAL_VAULT_PAYMENT_TOKEN", vault.id],
      ["PAYPAL_VAULT_TOKEN_TYPE", "PAYPAL_VAULT_ID"],
    ] as const) {
      const re = new RegExp(`^${key}=.*$`, "m");
      env = re.test(env) ? env.replace(re, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
    }
    writeFileSync(".env", env, { mode: 0o600 });
    console.log(".env updated with PAYPAL_VAULT_PAYMENT_TOKEN and PAYPAL_VAULT_TOKEN_TYPE=PAYPAL_VAULT_ID");
  }
  console.log("RESULT: PASS vault token created from a real sandbox buyer approval");
} catch (error) {
  const detail = error instanceof PayPalApiError ? `${error.message} (HTTP ${error.statusCode ?? "n/a"}, debug_id ${error.debugId ?? "n/a"})` : String(error instanceof Error ? error.message : error);
  console.error(`RESULT: FAIL ${detail}`);
  process.exit(1);
}
