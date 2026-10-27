import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-process stand-in for the PayPal Orders v2 API (spec 2.36 behaviour that
 * SentinelPay relies on). Counts every call so tests can prove what did or did
 * not reach "PayPal". This is a test double: passing tests against it is not
 * evidence that the real sandbox behaves the same way.
 */

type Fault =
  | "timeout"
  | "server_error"
  | "instrument_declined"
  | "vault_declined"
  /** What the real sandbox returns for a nonexistent/revoked vault_id (observed: 403 PERMISSION_DENIED). */
  | "vault_permission_denied"
  /** Vault payment that needs the buyer to act again (e.g. re-consent). */
  | "vault_payer_action";

interface MockOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "PAYER_ACTION_REQUIRED" | "COMPLETED";
  amount: { currency_code: string; value: string };
  description: string;
  referenceId: string | null;
  paymentSource: Record<string, unknown> | undefined;
  captureId: string | null;
  captureAmountOverride: string | null;
  storeInVault: boolean;
  vaultId: string | null;
}

export interface MockPayPal {
  baseUrl: string;
  counters: { tokenRequests: number; createCalls: number; ordersCreated: number; captureCalls: number; capturesSucceeded: number; getCalls: number };
  orders: Map<string, MockOrder>;
  /** Simulates the buyer approving the order on PayPal. */
  approve(orderId: string): void;
  /** Next create/capture call fails with the given fault (once). */
  failNext(op: "create" | "capture", fault: Fault): void;
  /** Delay applied to every create/capture response (ms), to widen race windows. */
  delayMs: number;
  /** Capture this amount instead of the order amount (amount-mismatch tests). */
  captureAmountOverride: string | null;
  /** Report captures with this status (e.g. DECLINED) even when the order is COMPLETED. */
  captureStatusOverride: string | null;
  lastCreateBody: Record<string, unknown> | null;
  close(): Promise<void>;
}

export async function startMockPayPal(): Promise<MockPayPal> {
  const orders = new Map<string, MockOrder>();
  const createByRequestId = new Map<string, string>();
  const captureByRequestId = new Map<string, unknown>();
  const faults: { op: "create" | "capture"; fault: Fault }[] = [];
  let seq = 0;

  const mock: MockPayPal = {
    baseUrl: "",
    counters: { tokenRequests: 0, createCalls: 0, ordersCreated: 0, captureCalls: 0, capturesSucceeded: 0, getCalls: 0 },
    orders,
    approve(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`mock: no order ${orderId}`);
      if (order.status === "CREATED" || order.status === "PAYER_ACTION_REQUIRED") order.status = "APPROVED";
    },
    failNext(op, fault) {
      faults.push({ op, fault });
    },
    delayMs: 0,
    captureAmountOverride: null,
    captureStatusOverride: null,
    lastCreateBody: null,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const takeFault = (op: "create" | "capture"): Fault | null => {
    const index = faults.findIndex((f) => f.op === op);
    return index === -1 ? null : faults.splice(index, 1)[0]!.fault;
  };

  const view = (o: MockOrder) => ({
    id: o.id,
    status: o.status,
    intent: "CAPTURE",
    create_time: new Date().toISOString(),
    purchase_units: [
      {
        reference_id: o.referenceId ?? undefined,
        description: o.description,
        amount: o.amount,
        ...(o.captureId
          ? {
              payments: {
                captures: [
                  {
                    id: o.captureId,
                    status: mock.captureStatusOverride ?? "COMPLETED",
                    amount: { currency_code: o.amount.currency_code, value: o.captureAmountOverride ?? o.amount.value },
                    final_capture: true,
                  },
                ],
              },
            }
          : {}),
      },
    ],
    links: [
      { rel: "self", href: `${mock.baseUrl}/v2/checkout/orders/${o.id}`, method: "GET" },
      ...(o.status === "PAYER_ACTION_REQUIRED"
        ? [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, method: "GET" }]
        : o.status === "CREATED"
          ? [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, method: "GET" }]
          : []),
    ],
    ...(o.vaultId ? { payment_source: { paypal: { attributes: { vault: { id: o.vaultId, status: "CREATED", customer: { id: "mockcust1" } } } } } } : {}),
  });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "paypal-debug-id": `mockdbg${seq}` });
    res.end(JSON.stringify(body));
  };
  const issue = (res: ServerResponse, status: number, name: string, issueCode: string, description: string) =>
    send(res, status, { name, message: description, debug_id: `dbg-${issueCode.toLowerCase()}`, details: [{ issue: issueCode, description }] });

  const applyFault = async (res: ServerResponse, fault: Fault | null): Promise<boolean> => {
    if (fault === "timeout") {
      // Hold the connection open longer than the client timeout; the request may still have "happened".
      await new Promise((r) => setTimeout(r, 4_000));
      if (!res.writableEnded) send(res, 504, { name: "TIMEOUT" });
      return true;
    }
    if (fault === "server_error") {
      send(res, 500, { name: "INTERNAL_SERVER_ERROR", message: "mock 500", debug_id: "dbg-500" });
      return true;
    }
    return false;
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://mock");
    const auth = req.headers.authorization ?? "";

    if (url.pathname === "/v1/oauth2/token") {
      mock.counters.tokenRequests++;
      if (!auth.startsWith("Basic ")) return send(res, 401, { error: "invalid_client" });
      return send(res, 200, { access_token: "mock-access-token", token_type: "Bearer", expires_in: 32_400 });
    }
    if (auth !== "Bearer mock-access-token") return send(res, 401, { name: "AUTHENTICATION_FAILURE" });

    const requestId = String(req.headers["paypal-request-id"] ?? "");

    if (url.pathname === "/v2/checkout/orders" && req.method === "POST") {
      mock.counters.createCalls++;
      if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
      // Idempotency: same PayPal-Request-Id returns the original order.
      const existing = requestId ? createByRequestId.get(requestId) : undefined;
      if (existing) return send(res, 200, view(orders.get(existing)!));
      const createFault = takeFault("create");
      if (createFault === "server_error" && (await applyFault(res, createFault))) return;
      if (createFault === "vault_permission_denied") {
        return send(res, 403, {
          name: "NOT_AUTHORIZED",
          message: "Authorization failed due to insufficient permissions.",
          debug_id: "dbg-permission-denied",
          details: [{ issue: "PERMISSION_DENIED", description: "You do not have permission to access or perform operations on this resource." }],
        });
      }
      if (createFault === "vault_declined") {
        return issue(res, 422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "The vaulted instrument was declined.");
      }

      const body = JSON.parse(raw) as Record<string, any>;
      mock.lastCreateBody = body;
      const source = body.payment_source as Record<string, any> | undefined;
      if (source?.token && source.token.type !== "BILLING_AGREEMENT") {
        return issue(res, 422, "UNPROCESSABLE_ENTITY", "INVALID_PARAMETER_VALUE", "payment_source.token.type must be BILLING_AGREEMENT");
      }
      const unit = body.purchase_units?.[0];
      const id = `MOCK${String(++seq).padStart(8, "0")}`;
      let status: MockOrder["status"] = "CREATED";
      let captureId: string | null = null;
      if (source?.paypal?.vault_id && createFault === "vault_payer_action") {
        status = "PAYER_ACTION_REQUIRED";
      } else if (source?.paypal?.vault_id) {
        status = "COMPLETED"; // vaulted PayPal wallet + intent CAPTURE completes on creation (observed in sandbox)
        captureId = `CAP${id}`;
        mock.counters.capturesSucceeded++;
      } else if (source?.token) {
        status = "APPROVED";
      } else if (source?.paypal?.experience_context) {
        status = "PAYER_ACTION_REQUIRED";
      }
      const storeInVault = source?.paypal?.attributes?.vault?.store_in_vault === "ON_SUCCESS";
      const order: MockOrder = {
        id,
        status,
        amount: unit.amount,
        description: unit.description,
        referenceId: unit.reference_id ?? null,
        paymentSource: source,
        captureId,
        captureAmountOverride: captureId ? mock.captureAmountOverride : null,
        storeInVault,
        vaultId: null,
      };
      orders.set(id, order);
      mock.counters.ordersCreated++;
      if (requestId) createByRequestId.set(requestId, id);
      // Timeout after the order exists: PayPal did the work but the response is lost.
      if (createFault === "timeout" && (await applyFault(res, createFault))) return;
      return send(res, status === "COMPLETED" ? 201 : 200, view(order));
    }

    const match = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
    if (match) {
      const order = orders.get(match[1]!);
      if (!order) return issue(res, 404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.");
      if (!match[2]) {
        mock.counters.getCalls++;
        return send(res, 200, view(order));
      }
      mock.counters.captureCalls++;
      if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
      if (requestId && captureByRequestId.has(requestId)) return send(res, 201, captureByRequestId.get(requestId));
      const fault = takeFault("capture");
      if (await applyFault(res, fault)) return;
      if (fault === "instrument_declined") {
        return issue(res, 422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "The instrument presented was either declined by the processor or bank.");
      }
      if (order.status === "COMPLETED") return issue(res, 422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", "Order already captured.");
      if (order.status !== "APPROVED") {
        return issue(res, 422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
      }
      order.status = "COMPLETED";
      order.captureId = `CAP${order.id}`;
      order.captureAmountOverride = mock.captureAmountOverride;
      if (order.storeInVault) order.vaultId = `mockvault${order.id.slice(-4)}`;
      mock.counters.capturesSucceeded++;
      const body = view(order);
      if (requestId) captureByRequestId.set(requestId, body);
      return send(res, 201, body);
    }

    send(res, 404, { name: "NOT_FOUND" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}
