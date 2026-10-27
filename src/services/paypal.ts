import { randomUUID } from "node:crypto";
import axios, { AxiosError, type AxiosInstance } from "axios";
import type { ExecutionMode } from "../models/types.js";

/** Refresh the access token this long before PayPal says it expires. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** PayPal limit for purchase_units[].description. */
const MAX_DESCRIPTION_LENGTH = 127;
const ORDER_NOT_APPROVED_MESSAGE = "Order created but requires buyer authorization before capture.";
/** Capture issues that mean "the buyer still has to act", per PayPal's Orders v2 error reference. */
const NOT_APPROVED_ISSUES = ["ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"];

// ---------------------------------------------------------------------------
// PayPal API types (subset of the Orders v2 / OAuth2 schemas we rely on)
// ---------------------------------------------------------------------------

export type CurrencyCode = "USD";

export type OrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export type CaptureStatus =
  | "COMPLETED"
  | "DECLINED"
  | "PARTIALLY_REFUNDED"
  | "PENDING"
  | "REFUNDED"
  | "FAILED";

export interface Money {
  currency_code: CurrencyCode;
  value: string;
}

export interface LinkDescription {
  href: string;
  rel: string;
  method?: string;
}

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue: string;
  description?: string;
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  // OAuth2 endpoint uses a different error shape.
  error?: string;
  error_description?: string;
}

interface PayPalCapture {
  id: string;
  status: CaptureStatus;
  amount?: Money;
  final_capture?: boolean;
  create_time?: string;
  status_details?: { reason?: string };
}

interface PayPalPurchaseUnit {
  reference_id?: string;
  description?: string;
  custom_id?: string;
  amount?: Money;
  payments?: { captures?: PayPalCapture[] };
}

interface PayPalOrder {
  id: string;
  status: OrderStatus;
  create_time?: string;
  purchase_units?: PayPalPurchaseUnit[];
  links?: LinkDescription[];
  payment_source?: {
    paypal?: { attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } } };
  };
}

/** Vault result reported on an order captured with store_in_vault (spec: payment_source.paypal.attributes.vault). */
export interface VaultResult {
  id: string;
  status: string | null;
  customerId: string | null;
}

// ---------------------------------------------------------------------------
// Public service types
// ---------------------------------------------------------------------------

/**
 * Vaulted payment source for autonomous mode (Orders v2 spec 2.36):
 * - PAYPAL_VAULT_ID: a Vault v3 PayPal-wallet token -> payment_source.paypal.vault_id
 * - BILLING_AGREEMENT: a reference-transaction billing agreement -> payment_source.token
 *   (token.type only accepts "BILLING_AGREEMENT").
 */
export interface VaultSource {
  type: "PAYPAL_VAULT_ID" | "BILLING_AGREEMENT";
  token: string;
}

export interface CreateOrderInput {
  /** Amount in integer USD cents. */
  amountCents: number;
  /** Human-readable description of the item being purchased (max 127 chars). */
  description: string;
  referenceId?: string;
  customId?: string;
  /** Idempotency key (PayPal-Request-Id); a random UUID is used when omitted. */
  requestId?: string;
  /** Fund with the vaulted source instead of sending a buyer to approve. */
  useVault?: boolean;
}

export interface CaptureDetails {
  captureId: string;
  status: CaptureStatus;
  amount: Money | null;
  statusReason: string | null;
}

export interface OrderSummary {
  orderId: string;
  status: OrderStatus;
  amount: Money | null;
  /** Link the buyer must visit to approve the order (rel "approve" or "payer-action"). */
  approvalUrl: string | null;
  captures: CaptureDetails[];
  vault: VaultResult | null;
}

export type CaptureResult =
  | { success: true; orderId: string; status: OrderStatus; captures: CaptureDetails[]; vault?: VaultResult | null }
  | { success: false; code: "ORDER_NOT_APPROVED"; message: string; orderId: string; approvalUrl: string | null };

export interface ExecutePaymentInput {
  amountCents: number;
  description: string;
  referenceId?: string;
  /** Idempotency key for the whole payment; the capture call derives its own from it. */
  requestId: string;
  /** Pay from the vaulted source (decided server-side by policy); otherwise send the buyer to approve. */
  useVault: boolean;
}

export type PaymentOutcome =
  | { status: "CAPTURED"; mode: ExecutionMode; orderId: string; captures: CaptureDetails[] }
  | { status: "PENDING_APPROVAL"; mode: ExecutionMode; orderId: string; approvalUrl: string; message: string };

/** The subset of the PayPal client the policy engine depends on (lets tests substitute it). */
export interface PaymentGateway {
  /** AUTONOMOUS when a vaulted source is configured; per-payment use is still decided by policy. */
  readonly executionMode: ExecutionMode;
  executePayment(input: ExecutePaymentInput): Promise<PaymentOutcome>;
  captureOrder(input: { orderId: string; requestId: string }): Promise<CaptureResult>;
  getOrder(orderId: string): Promise<OrderSummary>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PayPalApiError extends Error {
  override readonly name = "PayPalApiError";

  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly paypalErrorName: string | null,
    readonly debugId: string | null,
    readonly details: PayPalErrorDetail[],
  ) {
    // Deliberately no `cause`: the underlying AxiosError carries request headers,
    // including Basic/Bearer credentials, and must never reach a logger.
    super(message);
  }

  /** True when the outcome at PayPal is unknown or transient (network errors, timeouts, 429, 5xx). */
  get isRetryable(): boolean {
    return this.statusCode === null || this.statusCode === 429 || this.statusCode >= 500;
  }

  hasIssue(...issues: string[]): boolean {
    return this.details.some((detail) => issues.includes(detail.issue));
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      paypalErrorName: this.paypalErrorName,
      debugId: this.debugId,
      details: this.details,
    };
  }
}

function toPayPalApiError(operation: string, error: unknown): PayPalApiError {
  if (error instanceof PayPalApiError) return error;

  if (error instanceof AxiosError) {
    const status = error.response?.status ?? null;
    const body = (error.response?.data ?? {}) as PayPalErrorBody;
    const debugId =
      body.debug_id ?? (error.response?.headers?.["paypal-debug-id"] as string | undefined) ?? null;
    const details = Array.isArray(body.details)
      ? body.details.map((d) => ({
          issue: String(d.issue),
          ...(d.description ? { description: String(d.description) } : {}),
          ...(d.field ? { field: String(d.field) } : {}),
        }))
      : [];
    const paypalName = body.name ?? body.error ?? null;

    let summary: string;
    if (status === null) {
      summary = error.code === "ECONNABORTED" ? "request timed out" : `network error (${error.code ?? "unknown"})`;
    } else {
      summary = body.message ?? body.error_description ?? `HTTP ${status}`;
    }
    const detailText = details.map((d) => [d.issue, d.description].filter(Boolean).join(": ")).join("; ");

    return new PayPalApiError(
      `PayPal ${operation} failed: ${summary}${detailText ? ` (${detailText})` : ""}`,
      status,
      paypalName,
      debugId,
      details,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new PayPalApiError(`PayPal ${operation} failed: ${message}`, null, null, null, []);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * One sanitized record per PayPal API call, for diagnosing sandbox issues.
 * Never contains credentials, tokens, payer details or full URLs.
 */
export interface PayPalCallLog {
  operation: string;
  httpStatus: number | null;
  debugId: string | null;
  orderId?: string;
  orderStatus?: string;
  amount?: string;
  currency?: string;
  /** Host of the approval link only (e.g. www.sandbox.paypal.com). */
  approvalUrlHost?: string | null;
  errorName?: string | null;
  errorMessage?: string;
  issues?: string[];
}

export interface PayPalServiceOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  vault: VaultSource | null;
  /** Where PayPal sends the buyer after approving / cancelling an interactive order. */
  returnUrl: string;
  cancelUrl: string;
  timeoutMs?: number;
  /** Receives a sanitized record of every API call; null disables logging. Defaults to console.info. */
  logger?: ((entry: PayPalCallLog) => void) | null;
}

const defaultPayPalLogger = (entry: PayPalCallLog): void => console.info(`paypal ${JSON.stringify(entry)}`);

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class PayPalService implements PaymentGateway {
  private readonly http: AxiosInstance;
  private readonly basicAuth: string;
  private readonly vault: VaultSource | null;
  private readonly returnUrl: string;
  private readonly cancelUrl: string;
  private readonly logger: ((entry: PayPalCallLog) => void) | null;
  private cachedToken: CachedToken | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(options: PayPalServiceOptions) {
    this.basicAuth = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
    this.vault = options.vault;
    this.returnUrl = options.returnUrl;
    this.cancelUrl = options.cancelUrl;
    this.logger = options.logger === undefined ? defaultPayPalLogger : options.logger;
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      headers: { Accept: "application/json" },
      // Never follow redirects with credentials attached.
      maxRedirects: 0,
    });
  }

  get executionMode(): ExecutionMode {
    return this.vault ? "AUTONOMOUS" : "INTERACTIVE";
  }

  /**
   * Returns a valid OAuth2 access token, reusing the cached one until shortly
   * before it expires. Concurrent callers share a single in-flight request.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }
    if (this.pendingToken) return this.pendingToken;

    this.pendingToken = this.fetchAccessToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchAccessToken(): Promise<string> {
    try {
      const { data } = await this.http.post<AccessTokenResponse>(
        "/v1/oauth2/token",
        new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        {
          headers: {
            Authorization: `Basic ${this.basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      if (!data?.access_token || typeof data.expires_in !== "number") {
        throw new Error("token response is missing access_token or expires_in");
      }

      const lifetimeMs = data.expires_in * 1000;
      this.cachedToken = {
        value: data.access_token,
        expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_SKEW_MS, lifetimeMs / 2),
      };
      return data.access_token;
    } catch (error) {
      this.cachedToken = null;
      throw toPayPalApiError("access token request", error);
    }
  }

  /**
   * Runs a payment end to end using the configured execution mode:
   * - AUTONOMOUS: creates the order against the vaulted source; captures it unless PayPal already did.
   * - INTERACTIVE: creates the order and returns its approval link for a human buyer.
   * Either path falls back to PENDING_APPROVAL if PayPal still requires buyer action.
   */
  async executePayment(input: ExecutePaymentInput): Promise<PaymentOutcome> {
    if (input.useVault && !this.vault) {
      throw new PayPalApiError("Vault payment requested but no vaulted payment source is configured", 400, null, null, []);
    }
    const mode: ExecutionMode = input.useVault ? "AUTONOMOUS" : "INTERACTIVE";
    const order = await this.createOrder({
      amountCents: input.amountCents,
      description: input.description,
      ...(input.referenceId ? { referenceId: input.referenceId } : {}),
      requestId: input.requestId,
      useVault: input.useVault,
    });

    if (order.status === "COMPLETED") {
      return { status: "CAPTURED", mode, orderId: order.orderId, captures: order.captures };
    }

    if (mode === "AUTONOMOUS" && order.status !== "PAYER_ACTION_REQUIRED") {
      const capture = await this.captureOrder({ orderId: order.orderId, requestId: `${input.requestId}:capture` });
      if (capture.success) {
        return { status: "CAPTURED", mode, orderId: capture.orderId, captures: capture.captures };
      }
      return this.pendingApproval(mode, order.orderId, capture.approvalUrl ?? order.approvalUrl);
    }

    return this.pendingApproval(mode, order.orderId, order.approvalUrl);
  }

  private pendingApproval(mode: ExecutionMode, orderId: string, approvalUrl: string | null): PaymentOutcome {
    if (!approvalUrl) {
      throw new PayPalApiError(`PayPal order ${orderId} requires buyer approval but no approval link was returned`, 502, null, null, []);
    }
    return { status: "PENDING_APPROVAL", mode, orderId, approvalUrl, message: ORDER_NOT_APPROVED_MESSAGE };
  }

  /** Creates a CAPTURE-intent order in USD for a single item. */
  async createOrder(input: CreateOrderInput): Promise<OrderSummary> {
    const value = formatUsdCents(input.amountCents);
    const description = input.description.trim();
    if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new RangeError(`description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
    }

    const purchaseUnit: PayPalPurchaseUnit = { description, amount: { currency_code: "USD", value } };
    if (input.referenceId) purchaseUnit.reference_id = input.referenceId;
    if (input.customId) purchaseUnit.custom_id = input.customId;

    const body: Record<string, unknown> = {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit],
      payment_source: input.useVault ? this.vaultPaymentSource() : this.buyerApprovalPaymentSource(),
    };

    const order = await this.authorizedRequest<PayPalOrder>("create order", {
      method: "POST",
      url: "/v2/checkout/orders",
      data: body,
      requestId: input.requestId,
    });
    return summarizeOrder(order);
  }

  private vaultPaymentSource(): Record<string, unknown> {
    if (!this.vault) throw new Error("No vaulted payment source is configured");
    if (this.vault.type === "BILLING_AGREEMENT") {
      return { token: { id: this.vault.token, type: "BILLING_AGREEMENT" } };
    }
    // Agent purchases happen without the buyer present: a merchant-initiated
    // charge against a previously stored PayPal wallet.
    return {
      paypal: {
        vault_id: this.vault.token,
        stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT" },
      },
    };
  }

  private buyerApprovalPaymentSource(): Record<string, unknown> {
    return {
      paypal: {
        experience_context: {
          brand_name: "SentinelPay",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          return_url: this.returnUrl,
          cancel_url: this.cancelUrl,
        },
      },
    };
  }

  /** Fetches the current state of an order. */
  async getOrder(orderId: string): Promise<OrderSummary> {
    const order = await this.authorizedRequest<PayPalOrder>("get order", {
      method: "GET",
      url: `/v2/checkout/orders/${encodeURIComponent(validateOrderId(orderId))}`,
    });
    return summarizeOrder(order);
  }

  /**
   * Captures payment for an order. If the buyer has not approved it yet, resolves
   * to an ORDER_NOT_APPROVED result carrying the approval link instead of throwing.
   * Capturing an already-captured order resolves to its existing captures.
   */
  async captureOrder(input: { orderId: string; requestId: string }): Promise<CaptureResult> {
    const orderId = validateOrderId(input.orderId);

    let order: PayPalOrder;
    try {
      order = await this.authorizedRequest<PayPalOrder>("capture order", {
        method: "POST",
        url: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        data: {},
        requestId: input.requestId,
      });
    } catch (error) {
      if (!(error instanceof PayPalApiError) || error.statusCode !== 422) throw error;

      if (error.hasIssue(...NOT_APPROVED_ISSUES)) {
        const current = await this.getOrder(orderId);
        return { success: false, code: "ORDER_NOT_APPROVED", message: ORDER_NOT_APPROVED_MESSAGE, orderId, approvalUrl: current.approvalUrl };
      }
      if (error.hasIssue("ORDER_ALREADY_CAPTURED")) {
        const current = await this.getOrder(orderId);
        return { success: true, orderId, status: current.status, captures: current.captures };
      }
      throw error;
    }

    const summary = summarizeOrder(order);
    return { success: true, orderId: summary.orderId, status: summary.status, captures: summary.captures, vault: summary.vault };
  }

  /**
   * One-time buyer-consent order that saves the buyer's PayPal wallet in the vault
   * on successful capture (Orders v2: payment_source.paypal.attributes.vault with
   * store_in_vault ON_SUCCESS, usage_type MERCHANT). The buyer approves it on PayPal;
   * capturing it returns the vault id used for later merchant-initiated payments.
   */
  async createVaultSetupOrder(input: { amountCents: number; description: string; requestId: string }): Promise<OrderSummary> {
    const order = await this.authorizedRequest<PayPalOrder>("create vault setup order", {
      method: "POST",
      url: "/v2/checkout/orders",
      requestId: input.requestId,
      data: {
        intent: "CAPTURE",
        purchase_units: [{ description: input.description.trim(), amount: { currency_code: "USD", value: formatUsdCents(input.amountCents) } }],
        payment_source: {
          paypal: {
            attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } },
            experience_context: {
              brand_name: "SentinelPay",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: this.returnUrl,
              cancel_url: this.cancelUrl,
            },
          },
        },
      },
    });
    return summarizeOrder(order);
  }

  private async authorizedRequest<T>(
    operation: string,
    request: { method: "GET" | "POST"; url: string; data?: unknown; requestId?: string | undefined },
  ): Promise<T> {
    // Fixed up front so a retry after an auth failure stays idempotent.
    const requestId = request.method === "POST" ? (request.requestId ?? randomUUID()) : undefined;
    const send = async (): Promise<T> => {
      const token = await this.getAccessToken();
      const response = await this.http.request<T>({
        method: request.method,
        url: request.url,
        data: request.data,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
      });
      this.logSuccess(operation, response.status, response.headers["paypal-debug-id"], response.data);
      return response.data;
    };

    const fail = (error: unknown): PayPalApiError => {
      const apiError = toPayPalApiError(operation, error);
      this.logger?.({
        operation,
        httpStatus: apiError.statusCode,
        debugId: apiError.debugId,
        errorName: apiError.paypalErrorName,
        errorMessage: apiError.message,
        issues: apiError.details.map((d) => d.issue),
      });
      return apiError;
    };

    try {
      return await send();
    } catch (error) {
      // Token revoked or expired early: drop it and retry once with a fresh one.
      if (error instanceof AxiosError && error.response?.status === 401) {
        this.cachedToken = null;
        try {
          return await send();
        } catch (retryError) {
          throw fail(retryError);
        }
      }
      throw fail(error);
    }
  }

  private logSuccess(operation: string, httpStatus: number, debugId: unknown, data: unknown): void {
    if (!this.logger) return;
    const entry: PayPalCallLog = { operation, httpStatus, debugId: typeof debugId === "string" ? debugId : null };
    const order = data as Partial<PayPalOrder> | undefined;
    if (order && typeof order.id === "string") {
      const summary = summarizeOrder(order as PayPalOrder);
      entry.orderId = summary.orderId;
      entry.orderStatus = summary.status;
      if (summary.amount) {
        entry.amount = summary.amount.value;
        entry.currency = summary.amount.currency_code;
      }
      entry.approvalUrlHost = summary.approvalUrl ? safeHost(summary.approvalUrl) : null;
    }
    this.logger(entry);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function summarizeOrder(order: PayPalOrder): OrderSummary {
  const unit = order.purchase_units?.[0];
  const links = order.links ?? [];
  return {
    orderId: order.id,
    status: order.status,
    amount: unit?.amount ?? null,
    approvalUrl: links.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null,
    captures: (order.purchase_units ?? []).flatMap((pu) =>
      (pu.payments?.captures ?? []).map((capture) => ({
        captureId: capture.id,
        status: capture.status,
        amount: capture.amount ?? null,
        statusReason: capture.status_details?.reason ?? null,
      })),
    ),
    vault: order.payment_source?.paypal?.attributes?.vault?.id
      ? {
          id: order.payment_source.paypal.attributes.vault.id,
          status: order.payment_source.paypal.attributes.vault.status ?? null,
          customerId: order.payment_source.paypal.attributes.vault.customer?.id ?? null,
        }
      : null,
  };
}

function validateOrderId(orderId: string): string {
  const trimmed = orderId.trim();
  if (!/^[A-Z0-9]{1,36}$/i.test(trimmed)) {
    throw new RangeError("orderId must be an alphanumeric PayPal order id");
  }
  return trimmed;
}

function formatUsdCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new RangeError("amount must be a positive whole number of cents");
  }
  return (cents / 100).toFixed(2);
}
