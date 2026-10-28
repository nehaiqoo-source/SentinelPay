import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scriptable stand-in for the Gemini generateContent API. Each queued step answers one
 * model call; tests use it to drive the agent deterministically without calling Google.
 */
type Step = { status: number; body: unknown };

export interface StubGemini {
  baseUrl: string;
  /** Request bodies received, in order. */
  requests: any[];
  enqueue(...steps: Step[]): void;
  close(): Promise<void>;
}

const reply = (parts: unknown[]): Step => ({ status: 200, body: { candidates: [{ content: { role: "model", parts } }] } });
export const say = (text: string) => reply([{ text }]);
export const callPolicy = () => reply([{ functionCall: { name: "get_spending_policy", args: {} } }]);
export const callSubmit = (args: Record<string, unknown>) => reply([{ functionCall: { name: "submit_purchase_intent", args } }]);
export const callAsk = (question: string) => reply([{ functionCall: { name: "ask_clarifying_question", args: { question } } }]);
export const quotaExhausted = (): Step => ({
  status: 429,
  body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ retryDelay: "52851s" }] } },
});
export const perMinuteLimited = (): Step => ({
  status: 429,
  body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "per-minute limit", details: [{ retryDelay: "1s" }] } },
});
export const serverError = (): Step => ({ status: 500, body: { error: { code: 500, status: "INTERNAL", message: "boom" } } });
export const badRequest = (): Step => ({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad request" } } });
export const emptyReply = (): Step => ({ status: 200, body: { candidates: [{ finishReason: "SAFETY" }] } });

export async function startStubGemini(): Promise<StubGemini> {
  const queue: Step[] = [];
  const stub: StubGemini = {
    baseUrl: "",
    requests: [],
    enqueue: (...steps) => void queue.push(...steps),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!req.url?.includes(":generateContent")) {
      res.writeHead(404).end();
      return;
    }
    stub.requests.push(JSON.parse(raw));
    const step = queue.shift() ?? say("(stub: no scripted reply)");
    res.writeHead(step.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(step.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  return stub;
}
