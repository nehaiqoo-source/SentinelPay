# PayPal Sandbox verification procedure

Status at the time of writing: **BLOCKED**. No sandbox credentials are configured, so no
real PayPal transaction has been executed. Every automated test uses a local mock of the
Orders v2 API; passing them is not evidence about the real sandbox.

## Safety rails (enforced in code)

- `PAYPAL_BASE_URL` must be exactly `https://api-m.sandbox.paypal.com`. Live
  (`api-m.paypal.com`) and any other host are refused at startup (`src/config/env.ts`) and
  by `scripts/sandbox-check.ts`. Loopback mocks are only allowed when `NODE_ENV` is not `production`.
- Sandbox and live credentials are separate PayPal apps. Only put **sandbox** app
  credentials in `.env`; there is no setting that enables live mode.

## 1. Create sandbox credentials

1. Sign in at https://developer.paypal.com and open **Apps & Credentials → Sandbox**.
2. Create (or open) a REST app. Copy its **Client ID** and **Secret** into `.env`:
   `PAYPAL_CLIENT_ID=…`, `PAYPAL_CLIENT_SECRET=…`.
3. Under **Testing tools → Sandbox accounts**, note a **Personal** (buyer) account's
   email and password. You will log in as this buyer to approve orders.

## 2. PayPal-only check (no database needed)

```bash
npm run sandbox:check
```

The script obtains an OAuth token, creates a **$1.00** order, and:

- interactive mode (no vault token): prints the approval URL. Open it, log in as the
  sandbox **buyer**, approve; the script polls the order, captures it, replays the capture
  with the same `PayPal-Request-Id`, and prints the order id, capture id, capture status
  and final order status.
- vault mode: captures immediately and prints the same evidence.

Expected evidence for PASS: a real order id, a capture id, capture status `COMPLETED`,
final order status `COMPLETED`, and the replayed capture returning the same capture id.

## 3. Full gateway check (policy engine + ledger + PayPal sandbox)

```bash
npm run db:up && npm run migrate
npm run dev
```

In another terminal, with an ADMIN operator key (`ADMIN=$(cat .secrets/<you>.key)`):

```bash
# 1. create an agent (the response contains its API key once)
curl -s -X POST localhost:5000/api/admin/agents -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"agentId":"sandbox-agent","displayName":"Sandbox agent","perTransactionCap":"5.00","dailyCap":"10.00","allowedMerchants":["acme-store"],"allowedCategories":["electronics"]}'

# 2. submit a purchase as the agent
curl -s -X POST localhost:5000/api/agent/transactions -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"requestId":"sbx-001","amount":"1.00","merchantId":"acme-store","category":"electronics","description":"Sandbox test item"}'
```

Open the dashboard at http://localhost:5000, sign in with your operator key, click **Approve
Sandbox Order**, approve as the sandbox buyer, return to the dashboard and click **Capture**
(or **Capture now** on the return banner). Record the order id, capture id and final
status shown, and confirm the same ids in the sandbox **Activity** for the merchant account.

## 4. Live security checks against the sandbox

With the gateway running and its stdout written to a file:

```bash
npx tsx src/server.ts > gateway.log 2>&1 &
OPERATOR_KEY_FILE=.secrets/<you>.key GATEWAY_LOG=gateway.log CAPTURED_ORDER_ID=<an approved+captured order> npm run sandbox:e2e
```

The script creates throwaway agents with $1–$3 caps and checks:

- **Spending limits:** a purchase within budget, over the per-transaction cap, over the
  remaining daily budget, and 12 concurrent requests against a $3 daily cap.
- **Injection screening:** attack descriptions blocked, harmless look-alikes allowed,
  and filter misses still bounded by caps and allowlists.
- **Capture security:** capture before approval, an unknown order, an order created
  outside SentinelPay, another agent's order, and 5 parallel retries of a completed capture.
- **Freeze control:** freezing and unfreezing require admin auth, and a frozen agent
  can't pay or capture.

It counts the gateway's sanitized `paypal {…}` log lines to prove rejected requests never
reached PayPal, then cancels the unapproved sandbox orders it created.

## Known issue: "This seller doesn't accept payments in your currency"

Observed with seller (payee) sandbox Business account merchant id `7BB2RZ95HVDF8`.

- Order creation **succeeds**: `POST /v2/checkout/orders` returns 200 with a `USD 1.00`
  order (`purchase_units[0].amount.currency_code = "USD"`, no breakdown or items) and a
  `payer-action` link on `www.sandbox.paypal.com`.
- Opening that link redirects to `/checkoutweb/genericError?code=…`. The `code` parameter
  base64-decodes to **`UNSUPPORTED_PAYEE_CURRENCY`**.
- PayPal's reference for that code says the **payee** account doesn't support the
  currency. Possible reasons: the account restricts currencies, the currency isn't enabled
  in its settings, or its region doesn't offer it
  (https://developer.paypal.com/api/rest/troubleshooting/rest_unsupported_payee_currency/).

The fix is on the account side, not in the order payload. Either:

1. **Recommended:** create a **United States** Business sandbox account, create a
   sandbox REST app linked to it, put that app's client id and secret in `.env`, and
   approve with a United States Personal sandbox account; or
2. sign in to sandbox.paypal.com as the existing Business account and enable USD, or
   set its payment receiving preferences to accept and convert payments in currencies
   it doesn't hold.

The gateway logs one sanitized `paypal {…}` line per API call: status, `debug_id`, order
id, amount, currency and the approval link's host. Use these lines to confirm the order
side is correct before changing account settings.

## 5. Vault setup and autonomous payments (buyer consent)

1. In the developer dashboard, open the sandbox REST app and enable **Save payment methods** (Vault).
2. Run:
   ```bash
   npm run vault:setup -- --write-env
   ```
   Open the printed approval link and approve it as a sandbox **Personal** buyer; that
   approval is the buyer's consent to save the wallet. The script then:
   - captures the $1.00 setup order;
   - reads `payment_source.paypal.attributes.vault.id`;
   - saves it to `.secrets/paypal-vault-id`;
   - sets `PAYPAL_VAULT_PAYMENT_TOKEN` and `PAYPAL_VAULT_TOKEN_TYPE=PAYPAL_VAULT_ID` in `.env`.
3. Restart the gateway. Having the vault configured doesn't make any agent autonomous on
   its own: give an agent an `autonomousLimit` (ADMIN only), e.g. `"1.00"`. Payments up to
   that amount are then charged to the vault without buyer approval; larger ones still
   need approval.
4. Submit a $1.00 purchase as that agent. Expect `201 COMPLETED` with `mode: AUTONOMOUS`
   and a real capture id. Resend the same `requestId` and expect the same capture id, with
   no new PayPal call.

## Vault (autonomous) mode

Orders v2 (spec 2.36) accepts two vaulted sources; `payment_source.token.type` only allows
`BILLING_AGREEMENT`. The earlier `PAYMENT_METHOD_TOKEN` value is not in the spec and was removed.

| `PAYPAL_VAULT_TOKEN_TYPE` | Request field | Token source |
|---|---|---|
| `PAYPAL_VAULT_ID` | `payment_source.paypal.vault_id` (+ `stored_credential.payment_initiator: MERCHANT`) | Vault v3 payment token for a PayPal wallet, created after a buyer saves PayPal (requires the vault feature on the sandbox app) |
| `BILLING_AGREEMENT` | `payment_source.token { id, type: "BILLING_AGREEMENT" }` | Reference-transaction billing agreement id (`B-…`); requires reference transactions enabled on the account |

Verified against the real sandbox (see docs/SECURITY.md, "Vault mode (Task 4) status"):
PayPal accepts `vault_id` with `stored_credential`, and the order completes on creation.
