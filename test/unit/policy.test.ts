import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePolicy, type PolicyInput } from "../../src/engine/policy.js";

const base: PolicyInput = {
  agent: {
    frozen: false,
    frozenReason: null,
    perTransactionCapCents: 2500,
    dailyCapCents: 10000,
    allowedMerchants: null,
    allowedCategories: null,
    autonomousLimitCents: 0,
  },
  global: { perTransactionCapCents: 2500, dailyCapCents: 10000 },
  amountCents: 1000,
  merchantId: "acme-store",
  category: "electronics",
  agentSpentTodayCents: 0,
  globalSpentTodayCents: 0,
};

const codes = (input: Partial<Omit<PolicyInput, "agent">> & { agent?: Partial<PolicyInput["agent"]> }) =>
  evaluatePolicy({ ...base, ...input, agent: { ...base.agent, ...input.agent } }).map((v) => v.code);

describe("evaluatePolicy", () => {
  it("allows a request within every limit", () => {
    assert.deepEqual(codes({}), []);
  });

  it("allows exactly the per-transaction cap and blocks one cent over", () => {
    assert.deepEqual(codes({ amountCents: 2500 }), []);
    assert.deepEqual(codes({ amountCents: 2501 }), ["PER_TRANSACTION_CAP", "GLOBAL_PER_TRANSACTION_CAP"]);
  });

  it("allows reaching the daily cap exactly and blocks one cent over", () => {
    assert.deepEqual(codes({ amountCents: 1000, agentSpentTodayCents: 9000, globalSpentTodayCents: 9000 }), []);
    assert.deepEqual(codes({ amountCents: 1001, agentSpentTodayCents: 9000, globalSpentTodayCents: 9000 }), [
      "DAILY_SPENDING_CAP",
      "GLOBAL_DAILY_SPENDING_CAP",
    ]);
  });

  it("enforces the global daily cap across agents even when the agent's own budget is free", () => {
    assert.deepEqual(codes({ agentSpentTodayCents: 0, globalSpentTodayCents: 9500 }), ["GLOBAL_DAILY_SPENDING_CAP"]);
  });

  it("enforces the stricter agent cap below the global cap", () => {
    assert.deepEqual(codes({ amountCents: 600, agent: { perTransactionCapCents: 500 } }), ["PER_TRANSACTION_CAP"]);
  });

  it("blocks frozen agents regardless of amount", () => {
    assert.deepEqual(codes({ amountCents: 1, agent: { frozen: true, frozenReason: "incident" } }), ["AGENT_FROZEN"]);
  });

  it("treats null allowlists as unrestricted and empty allowlists as deny-all", () => {
    assert.deepEqual(codes({ agent: { allowedMerchants: ["acme-store"], allowedCategories: ["electronics"] } }), []);
    assert.deepEqual(codes({ agent: { allowedMerchants: ["other"] } }), ["MERCHANT_NOT_ALLOWED"]);
    assert.deepEqual(codes({ agent: { allowedCategories: [] } }), ["CATEGORY_NOT_ALLOWED"]);
  });

  it("matches allowlists exactly (no case folding or prefix tricks)", () => {
    assert.deepEqual(codes({ merchantId: "ACME-STORE", agent: { allowedMerchants: ["acme-store"] } }), ["MERCHANT_NOT_ALLOWED"]);
    assert.deepEqual(codes({ merchantId: "acme-store.evil", agent: { allowedMerchants: ["acme-store"] } }), ["MERCHANT_NOT_ALLOWED"]);
  });
});
