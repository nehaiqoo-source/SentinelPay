import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inspect } from "node:util";
import { PayPalApiError, PayPalService, type PayPalCallLog, type VaultSource } from "../../src/services/paypal.js";
import { startMockPayPal, type MockPayPal } from "../helpers/mockPayPal.js";

let mock: MockPayPal;
before(async () => {
  mock = await startMockPayPal();
});
after(() => mock.close());

const service = (vault: VaultSource | null = null, overrides: Partial<{ clientSecret: string; baseUrl: string; timeoutMs: number }> = {}) =>
  new PayPalService({
    clientId: "unit-client",
    clientSecret: overrides.clientSecret ?? "unit-secret",
    baseUrl: overrides.baseUrl ?? mock.baseUrl,
    vault,
    returnUrl: "http://localhost/return",
    cancelUrl: "http://localhost/cancel",
    timeoutMs: overrides.timeoutMs ?? 1_500,
    logger: null,
  });

describe("PayPalService", () => {
  it("caches the access token across calls and concurrent callers", async () => {
    const svc = service();
    const before = mock.counters.tokenRequests;
    await Promise.all([svc.getAccessToken(), svc.getAccessToken(), svc.getAccessToken()]);
    await svc.getAccessToken();
    assert.equal(mock.counters.tokenRequests - before, 1);
  });

  it("interactive mode sends experience_context (not deprecated application_context) and returns the payer-action link", async () => {
    const outcome = await service().executePayment({ amountCents: 1299, description: "Mouse", requestId: "unit-interactive-1", useVault: false });
    assert.equal(outcome.status, "PENDING_APPROVAL");
    assert.equal(outcome.mode, "INTERACTIVE");
    assert.match(outcome.status === "PENDING_APPROVAL" ? outcome.approvalUrl : "", /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    const body = mock.lastCreateBody as any;
    assert.equal(body.application_context, undefined);
    assert.equal(body.payment_source.paypal.experience_context.return_url, "http://localhost/return");
    assert.equal(body.purchase_units[0].amount.value, "12.99");
  });

  it("sends one consistent currency: every currency_code in the outgoing order payload is USD", async () => {
    for (const [amountCents, expected] of [
      [1, "0.01"],
      [100, "1.00"],
      [2500, "25.00"],
    ] as const) {
      await service().executePayment({ amountCents, description: "Currency check", requestId: `unit-currency-${amountCents}`, useVault: false });
      const body = mock.lastCreateBody as any;
      const unit = body.purchase_units[0];
      assert.deepEqual(unit.amount, { currency_code: "USD", value: expected });
      // No breakdown/items are sent, so no second amount can disagree with the total.
      assert.equal(unit.amount.breakdown, undefined);
      assert.equal(unit.items, undefined);
      const currencies = JSON.stringify(body).match(/"currency_code":"[A-Z]{3}"/g) ?? [];
      assert.deepEqual([...new Set(currencies)], ['"currency_code":"USD"']);
    }
  });

  it("vault mode (PAYPAL_VAULT_ID) uses payment_source.paypal.vault_id with a merchant-initiated stored credential", async () => {
    const outcome = await service({ type: "PAYPAL_VAULT_ID", token: "vaultTok_123" }).executePayment({
      amountCents: 500,
      description: "API credits",
      requestId: "unit-vault-1",
      useVault: true,
    });
    assert.equal(outcome.status, "CAPTURED");
    const source = (mock.lastCreateBody as any).payment_source;
    assert.deepEqual(source, { paypal: { vault_id: "vaultTok_123", stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" } } });
  });

  it("billing-agreement mode uses token.type BILLING_AGREEMENT (the only value the spec allows) and captures", async () => {
    const outcome = await service({ type: "BILLING_AGREEMENT", token: "B-12345" }).executePayment({
      amountCents: 500,
      description: "API credits",
      requestId: "unit-ba-1",
      useVault: true,
    });
    assert.equal(outcome.status, "CAPTURED");
    assert.deepEqual((mock.lastCreateBody as any).payment_source, { token: { id: "B-12345", type: "BILLING_AGREEMENT" } });
  });

  it("maps a 422 ORDER_NOT_APPROVED capture to a structured result instead of throwing", async () => {
    const svc = service();
    const created = await svc.executePayment({ amountCents: 100, description: "Pen", requestId: "unit-na-1", useVault: false });
    const result = await svc.captureOrder({ orderId: created.orderId, requestId: "unit-na-1:capture" });
    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "ORDER_NOT_APPROVED");
    assert.match(result.success === false ? (result.approvalUrl ?? "") : "", /checkoutnow/);
  });

  it("treats ORDER_ALREADY_CAPTURED as success and returns the existing capture", async () => {
    const svc = service();
    const created = await svc.executePayment({ amountCents: 100, description: "Pen", requestId: "unit-ac-1", useVault: false });
    mock.approve(created.orderId);
    const first = await svc.captureOrder({ orderId: created.orderId, requestId: "unit-ac-1:capture" });
    const second = await svc.captureOrder({ orderId: created.orderId, requestId: "unit-ac-1:capture-other-key" });
    assert.equal(first.success && first.captures[0]?.status, "COMPLETED");
    assert.equal(second.success && second.captures[0]?.captureId, first.success ? first.captures[0]?.captureId : "x");
  });

  it("logs a sanitized record per call: status, debug_id, order id, amount, currency, approval host and error issues", async () => {
    const entries: PayPalCallLog[] = [];
    const svc = new PayPalService({
      clientId: "log-client",
      clientSecret: "LOG-SECRET-VALUE",
      baseUrl: mock.baseUrl,
      vault: null,
      returnUrl: "http://localhost/return?x=1",
      cancelUrl: "http://localhost/cancel",
      logger: (entry) => entries.push(entry),
    });
    const created = await svc.executePayment({ amountCents: 100, description: "Log check", requestId: "unit-log-1", useVault: false });
    await svc.captureOrder({ orderId: created.orderId, requestId: "unit-log-1:capture" });

    const create = entries.find((e) => e.operation === "create order");
    assert.equal(create?.httpStatus, 200);
    assert.match(create?.debugId ?? "", /^mockdbg/);
    assert.equal(create?.orderId, created.orderId);
    assert.equal(create?.currency, "USD");
    assert.equal(create?.amount, "1.00");
    assert.equal(create?.approvalUrlHost, "www.sandbox.paypal.com");

    const failed = entries.find((e) => e.operation === "capture order");
    assert.equal(failed?.httpStatus, 422);
    assert.deepEqual(failed?.issues, ["ORDER_NOT_APPROVED"]);
    assert.equal(failed?.debugId, "dbg-order_not_approved");

    const dump = JSON.stringify(entries);
    for (const secret of ["LOG-SECRET-VALUE", "mock-access-token", Buffer.from("log-client:LOG-SECRET-VALUE").toString("base64"), "token=", "checkoutnow"]) {
      assert.ok(!dump.includes(secret), `log contains ${secret}`);
    }
  });

  it("errors never carry credentials (no AxiosError cause with Authorization headers)", async () => {
    const svc = service(null, { clientSecret: "SUPER-SECRET-VALUE", baseUrl: "http://127.0.0.1:1" });
    const error = await svc.getAccessToken().catch((e: unknown) => e);
    assert.ok(error instanceof PayPalApiError);
    const dump = inspect(error, { depth: 10, showHidden: true }) + JSON.stringify(error);
    assert.ok(!dump.includes("SUPER-SECRET-VALUE"));
    assert.ok(!dump.includes(Buffer.from("unit-client:SUPER-SECRET-VALUE").toString("base64")));
    assert.ok(!dump.includes("Authorization"));
    assert.equal(error.isRetryable, true);
  });
});
