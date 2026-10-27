# PayPal integration audit

Everything below is checked against PayPal's Orders v2 OpenAPI spec (v2.36, from
developer.paypal.com) and the webhook event reference
(https://developer.paypal.com/api/rest/webhooks/event-names/). All runs are **sandbox
only**: the server refuses any host other than `api-m.sandbox.paypal.com`.

## Flows used by the demo

| Flow | Calls | Request fields | Real sandbox evidence |
|---|---|---|---|
| **OAuth** | `POST /v1/oauth2/token` (client credentials) | none | Token obtained for both sandbox apps; cached until 60s before expiry |
| **Interactive (buyer approves each order)** | `POST /v2/checkout/orders`, then the buyer visits the `payer-action` link, then `POST /v2/checkout/orders/{id}/capture` | `intent: CAPTURE`; `purchase_units[0].amount {currency_code: USD, value}`; `payment_source.paypal.experience_context {return_url, cancel_url, user_action: PAY_NOW, shipping_preference: NO_SHIPPING, payment_method_preference: IMMEDIATE_PAYMENT_REQUIRED}` | Order `2KD1942098605523R` became capture `0RS90965NW179300S` (COMPLETED, USD 1.00) |
| **Vault setup (buyer consent)** | Create order with `payment_source.paypal.attributes.vault {store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER}`, then buyer approval, then capture | as left | Order `5MT10807G13413528` became capture `5MG58512E5460293P`, with vault token status `VAULTED` |
| **Autonomous (merchant-initiated, vaulted wallet)** | `POST /v2/checkout/orders` with `payment_source.paypal {vault_id, stored_credential: {payment_initiator: MERCHANT, usage: SUBSEQUENT}}`. The order completes on creation, so there is no separate capture call. | as left | Order `5FK118373W219345Y` became capture `2NK85168TH412615K` (COMPLETED, USD 1.00) |
| **Idempotency** | `PayPal-Request-Id` = SentinelPay transaction id (create); `<id>:capture` (capture) | header | Replays returned the stored result with 0 new PayPal calls (live e2e) |

Authorization-then-capture (`intent: AUTHORIZE`) is **not used**. Every order is `intent: CAPTURE`.

## Error handling, as observed in the real sandbox

| Situation | PayPal response | SentinelPay outcome |
|---|---|---|
| Capture before buyer approval | 422 `ORDER_NOT_APPROVED` | 409 structured response; stays `PENDING_APPROVAL` (budget reserved) |
| Seller account can't receive the buyer's currency | Checkout error page `code=UNSUPPORTED_PAYEE_CURRENCY` (order creation succeeds) | Order stays `PENDING_APPROVAL` until it expires; fixed by using a US seller account |
| Unknown or invalid `vault_id` | 403 `NOT_AUTHORIZED` / `PERMISSION_DENIED` (`debug_id f734049b5a936`) | `FAILED`, budget `RELEASED`, never `COMPLETED`; replay makes no new call |
| Unknown billing agreement | 422 `BILLING_AGREEMENT_NOT_FOUND` | `FAILED` (same branch) |
| Order created by a different REST app | 404 `RESOURCE_NOT_FOUND` / `INVALID_RESOURCE_ID` | Capture refused; `FAILED`, released |
| Timeout or 5xx (mock only) | none | `RECONCILE_REQUIRED`, budget stays reserved; operator reconciles with the same `PayPal-Request-Id` |
| Revoked vault token | **Not tested in the sandbox.** Revoking deletes the demo's only token, and re-creating it needs a new buyer approval. | Mocked as the observed 403 `PERMISSION_DENIED`: `FAILED`, released |

## Not implemented (honest gaps)

**Webhooks:** none are consumed. Consequences:

| Event | Effect of not consuming it |
|---|---|
| `PAYMENT.CAPTURE.PENDING`, then `.COMPLETED` / `.DECLINED` | A `CAPTURE_PENDING` transaction stays `CAPTURE_PENDING`. The budget is still counted as committed (conservative). |
| `PAYMENT.CAPTURE.REFUNDED` / `.REVERSED` | Refunds and reversals made in PayPal aren't reflected. The ledger keeps `COMPLETED`. |
| `CHECKOUT.ORDER.APPROVED` | Approval is detected only when someone captures (or by the return-URL banner). |
| `CHECKOUT.PAYMENT-APPROVAL.REVERSED` | Not handled; the capture would fail and be recorded as `FAILED`. |
| `VAULT.PAYMENT-TOKEN.DELETED` | A buyer removing the saved wallet is only discovered when the next autonomous payment fails (403, then `FAILED`). |

**Other gaps:**
- **Refunds:** not implemented (no `POST /v2/payments/captures/{id}/refund`).
- **Currencies:** USD only, by design. The ledger and caps assume USD.
- **Live mode:** deliberately impossible to configure.

Webhooks and refunds aren't required by the hackathon rules or by this demo, so they
weren't added. They are the first things to build for a real deployment.
