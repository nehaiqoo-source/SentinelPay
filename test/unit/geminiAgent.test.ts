import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { runShoppingAgent } from "../../src/agent/geminiShoppingAgent.js";

/**
 * Agent harness behaviour without calling Google: a local stub stands in for both the
 * Gemini API (the harness reads GEMINI_API_BASE) and SentinelPay.
 */
let stub: ReturnType<typeof createServer>;
let baseUrl = "";
let geminiCalls = 0;
let mode: "quota" | "tool-then-answer" = "quota";
const submitted: unknown[] = [];

before(async () => {
  stub = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url?.includes(":generateContent")) {
      geminiCalls++;
      if (mode === "quota") {
        return json(429, {
          error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "52851s" }] },
        });
      }
      const body = JSON.parse(raw);
      const last = body.contents.at(-1);
      if (last.parts.some((p: any) => p.functionResponse)) {
        return json(200, { candidates: [{ content: { role: "model", parts: [{ text: "Submitted; SentinelPay decided." }] } }] });
      }
      return json(200, {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "submit_purchase_intent", args: { merchantId: "acme-store", category: "electronics", amountUsd: "1.00", description: "Cable", agentId: "someone-else" } } }] } }],
      });
    }
    if (req.url === "/api/agent/transactions") {
      submitted.push(JSON.parse(raw));
      return json(202, { status: "PENDING_APPROVAL", transactionId: "t1" });
    }
    json(404, {});
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  process.env.GEMINI_API_BASE = `${baseUrl}/v1beta`;
});
after(() => {
  delete process.env.GEMINI_API_BASE;
  stub.close();
});

const config = () => ({ geminiApiKey: "test-key", model: "test-model", sentinelPayUrl: baseUrl, agentApiKey: "sp_agent_test" });

describe("Gemini shopping agent harness", () => {
  it("fails fast (no retries) when Google reports an exhausted daily quota", async () => {
    mode = "quota";
    geminiCalls = 0;
    const started = Date.now();
    await assert.rejects(runShoppingAgent(config(), "buy a cable"), /HTTP 429: RESOURCE_EXHAUSTED/);
    assert.equal(geminiCalls, 1);
    assert.ok(Date.now() - started < 2_000, "did not wait out the backoff");
  });

  it("forwards only the structured intent fields; the harness picks the idempotency key, not the model", async () => {
    mode = "tool-then-answer";
    const run = await runShoppingAgent(config(), "buy a cable");
    assert.equal(run.finalText, "Submitted; SentinelPay decided.");
    const intent = submitted.at(-1) as Record<string, unknown>;
    assert.deepEqual(Object.keys(intent).sort(), ["amount", "category", "description", "merchantId", "requestId"]);
    assert.match(String(intent.requestId), /^agent-[0-9a-f-]{36}$/);
    assert.equal(intent.agentId, undefined, "model-supplied agentId is dropped (identity comes from the key)");
  });
});
