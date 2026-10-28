# SentinelPay security findings (Phase 2 hardening)

Baseline evidence comes from repro scripts run against the pre-hardening build (in-memory
ledger, no auth) before any change. "Regression test" names the automated test that now
fails if the issue comes back. All tests run against a real PostgreSQL 17 database and a
local mock of the PayPal Orders v2 API; none run against the real PayPal sandbox.

| # | Severity | Finding (pre-fix file) | Baseline evidence | Fix | Regression test | Remaining risk |
|---|---|---|---|---|---|---|
| 1 | Critical | No authentication on payment, capture, listing (`src/routes/agent.ts`) | `POST /api/agent/transactions` with no credentials → 202 | Per-agent API keys (SHA-256 hashed at rest) for `/api/agent`, `ADMIN_API_KEY` (constant-time compare) for `/api/admin` | `api-security`: "rejects missing and forged agent keys" ×4, "rejects anonymous callers and agent keys" ×12 | Static bearer keys; no expiry, MFA or per-operator accounts |
| 2 | Critical | Agent identity taken from request body (`sentinelGuard.ts`) | Body `agentId:"finance-bot-prod"` recorded as that agent | Identity comes only from the API key; strict schema rejects `agentId` and any unknown field | "agentId and policy fields in the body are rejected", "records the transaction under the key's agent" | – |
| 3 | High | IDOR: any caller lists all agents' transactions and captures any order | Unauthenticated `GET /transactions` and capture reached PayPal | Agent routes scoped to the caller; other agents' objects return 404; listings admin-only | "cannot read or capture another agent's transaction (404, not 403)" | – |
| 4 | High | CORS `*` let any website drive the API from an operator's browser | `Origin: https://evil.example` → `Access-Control-Allow-Origin: *` | Exact-origin allowlist (`CORS_ALLOWED_ORIGINS`, wildcards rejected; default same-origin only) | "CORS: allowed origin gets the header, others get none", config "rejects CORS wildcards" | – |
| 5 | High | Daily budget reset on restart (in-memory ledger) | committed `83.00` before restart, `0.00` after | PostgreSQL ledger; budget = SUM of RESERVED+COMMITTED rows for the UTC day | `persistence`: "survives SIGKILL with balances and transactions intact", "daily cap still counts spend from before the restart" | – |
| 6 | High | Duplicate payment: same `requestId` after restart created a 2nd order | `MOCK000007` then `MOCK000008` for one requestId | `UNIQUE(agent_id, request_id)`; `PayPal-Request-Id` = transaction id; `requestId` now mandatory | "idempotent replay after restart", concurrency "20 parallel duplicates … exactly one PayPal order" | Relies on PayPal honouring `PayPal-Request-Id` for reconciliation retries (retention window not confirmed in docs) |
| 7 | High | Budget check only safe within one process | Mutation test without the lock: 29/40 $10 requests accepted on a $100 cap ($290) | Reservation (idempotency check, freeze check, spend sums, insert) inside one DB transaction under `pg_advisory_xact_lock` | concurrency "40 parallel $10 requests … reserve exactly $100" across 2 instances, global-cap race, freeze race | The global lock serializes all reservations (throughput bound) |
| 8 | High | Live PayPal endpoint accepted (`config/env.ts`) | `PAYPAL_BASE_URL=https://api-m.paypal.com` accepted | Only `https://api-m.sandbox.paypal.com` (plus loopback mocks outside production) | config "refuses the live PayPal endpoint and arbitrary hosts" | – |
| 9 | High | Vault request used `token.type: PAYMENT_METHOD_TOKEN`, which Orders v2 (spec 2.36) does not allow | Spec enum for `payment_source.token.type` is `["BILLING_AGREEMENT"]` | `PAYPAL_VAULT_ID` → `payment_source.paypal.vault_id`; `BILLING_AGREEMENT` → `token`; explicit `PAYPAL_VAULT_TOKEN_TYPE` | `paypal` unit tests for both shapes (the mock rejects any other token type) | **Not verified on the real sandbox** |
| 10 | Medium | PayPal errors kept the AxiosError (with `Authorization: Basic …`) as `cause` | `inspect(error)` contained the Basic credentials: `true` | No `cause`; details are copied field by field | "errors never carry credentials", persistence "never writes secrets … to the process logs" | – |
| 11 | Medium | Reusing an idempotency key for a different purchase silently returned the old result | Replay with amount 20 → 202, amount `3.00` | Request fingerprint; a mismatch → 409 `IDEMPOTENCY_KEY_REUSED` | "rejects reuse of a requestId for a different purchase" | – |
| 12 | Medium | No rate limiting | 200/200 rapid requests succeeded | Per-IP limit on all routes plus a per-agent payment limit | "limits payment requests per agent", "limits requests per IP" | In-memory per process; use a shared store when scaling out |
| 13 | Medium | `trust proxy` hard-coded to 1 (spoofable `X-Forwarded-For`) | Hard-coded in `server.ts` | `TRUST_PROXY_HOPS`, default 0 | "ignores spoofed X-Forwarded-For" | Must be set correctly behind a proxy |
| 14 | Medium | Unknown PayPal outcome (timeout/5xx) marked FAILED, releasing budget that may have been spent | Code path: any error → FAILED | Unknown outcome → `RECONCILE_REQUIRED` (budget stays reserved) with admin reconcile/cancel; crashed in-flight work is flagged by the sweeper | "a PayPal timeout keeps the budget reserved", persistence "a crash during the PayPal call …" | Needs a human to reconcile |
| 15 | Medium | No frozen-agent, merchant or category controls | Not implemented | Server-side freeze (blocks new payments and captures), merchant/category allowlists, global ceilings on agent caps | spending "frozen agents …", "merchant and category allowlists", api "admins cannot raise an agent above the global ceilings" | A reservation that passed just before a freeze commits still completes |
| 16 | Low | Request log recorded query strings (PayPal `PayerID`) | 1 log line containing `PayerID=PAYER123` | Logs the path only | Manual check (log shows `GET /api/admin/agents 401` for `?x=secret`); no automated test | – |
| 17 | Low | Captured amount was never compared with the approved amount | Not checked | Mismatch → `RECONCILE_REQUIRED` | "a capture amount that differs from the approved amount is flagged" | – |
| 18 | Low | Deprecated `application_context` | Spec marks its fields DEPRECATED | `payment_source.paypal.experience_context` | paypal "interactive mode sends experience_context" | – |
| 19 | Low | `/health` disclosed PayPal URL and mode | Response fields | Status, DB state and uptime only | "health exposes no configuration or secrets" | – |
| 20 | Low | Dashboard loaded third-party CDN scripts; no CSP | `index.html` | AG Grid served locally; Helmet CSP `script-src 'self'`, `frame-ancestors 'none'` | "sets security headers and a strict CSP", "serves AG Grid locally" | `style-src 'unsafe-inline'` kept for AG Grid |
| 21 | Info | Prompt-injection defense was regex-only and treated as a control | – | Regex filter kept as defense in depth (plus homoglyph/mixed-script rule); authorization reads only structured fields | `injection` suite (10 attacks blocked with zero PayPal calls; known misses bounded by caps/allowlists) | Paraphrased attacks evade the filter (documented in tests) |

## Prompt-injection limitations

- The filter matches patterns. It cannot tell intent, and paraphrases get through. Two are
  kept as explicit "known miss" unit tests.
- What actually limits spend is structured policy: agent identity from the key, integer
  cents, merchant and category ids checked against allowlists, per-transaction, daily and
  global caps, and the freeze flag. Free text never feeds into those decisions.
- Within policy, an undetected injection can still make the agent buy something allowed
  that the owner didn't want. Caps and allowlists bound that loss; they don't prevent it.

## Audit log

- Each event stores `hash = sha256(prev_hash + canonical event JSON)`. Verification
  recomputes the chain and reports the first bad event.
- A trigger blocks UPDATE, DELETE and TRUNCATE. The table owner can disable it. Tests
  show the chain still detects edits and deletions made that way.
- It is tamper-evident, not immutable. Someone with database write access can rewrite
  every event after an edit and produce a new chain that checks out. To detect that,
  regularly copy the head hash from `GET /api/admin/audit/verify` somewhere outside the
  database. That isn't automated yet.
- Recommended for production: run the app as a non-owner role with only `INSERT, SELECT`
  on `audit_events`. *(Done in Phase 4: `sentinelpay_app` runtime role.)*

## Not covered or not tested

- Real PayPal sandbox transactions: **BLOCKED** (no credentials). See `docs/SANDBOX_TESTING.md`.
- Refunds and disputes: the `REFUNDED` status and accounting rule exist, but no PayPal
  webhook is processed. NOT TESTED.
- TLS: terminate HTTPS at a reverse proxy; the app speaks plain HTTP.
- Operator accounts, roles and MFA: a single shared admin key. *(Superseded in Phase 4: named operator keys with roles; MFA/SSO still not implemented.)*

---

# Phase 4 hardening

Evidence comes from the live repository and running gateway, not from earlier reports.
"Regression test" names the automated test that fails if the issue returns. Mutation
checks: each key control was temporarily broken to confirm its tests then fail.

| # | Severity | Finding | Evidence | Fix | Regression test | Remaining risk |
|---|---|---|---|---|---|---|
| P4-1 | High | App connected to Postgres as a **superuser** that owns `audit_events`, so it could disable the append-only trigger and rewrite history | `pg_roles`: `sentinelpay` `rolsuper = t`, owner of `audit_events` | Least-privilege runtime role `sentinelpay_app` (`npm run db:app-role`): SELECT/INSERT/UPDATE on ledger tables, SELECT/INSERT only on audit tables, no DELETE anywhere, not owner. The owner is used only by `npm run migrate`. In production the server refuses to start as a superuser or as the audit-table owner. | `audit-integrity`: "cannot modify, delete, truncate or disable triggers…", "is not a superuser…" | Whoever holds the owner credentials can still rewrite data (signed checkpoints detect it) |
| P4-2 | High | One shared `ADMIN_API_KEY` for all 15 privileged routes; no per-person identity, roles, revocation or expiry; audit actor always `admin` | `src/auth/auth.ts` (pre-change) compared one env secret | Named operators (`operators` table, SHA-256 hashed keys `sp_op_…`), roles VIEWER/AUDITOR/OPERATOR/ADMIN, per-route permissions, revocation, optional expiry, self/admin key rotation, last-ADMIN protection, CLI bootstrap. `ADMIN_API_KEY` is now refused at startup. | `operators` (20 tests: missing/malformed/unknown/revoked/expired keys, role matrix, rotation, last admin); mutation: letting OPERATOR unfreeze fails 2 tests | Bearer keys, no MFA/SSO; key theft = that role until revoked |
| P4-3 | Medium | **Found in the live run:** the failed-auth limiter returned 429 to *every* request from an IP once failures exceeded the limit, so anyone sharing an IP could lock out valid operators | Live e2e: 10× 401 (stale dashboard plus deliberate tests) → valid operator requests 429; 4 checks failed | Authenticate first; throttle only requests that failed authentication; authenticated operators skip the limiter. Throttled attempts aren't audited (bounded audit growth). | `operators`: "REGRESSION: … SAME IP cannot lock out a valid operator"; mutation (remove skip) fails 2 tests | In-memory limiter per process |
| P4-4 | Medium | Configuring a vault made **every** agent pay without buyer approval | `executePayment` used vault whenever configured | Per-agent `autonomousLimit` (default $0 = always require approval), decided under the reservation lock from the DB policy and stored on the transaction; ≤ per-transaction cap; ADMIN-only to change | `autonomy` (10 tests); mutation (ignore the limit) fails 3 tests | An ADMIN can still raise the limit (audited) |
| P4-5 | Medium | No buyer-consent flow existed to obtain a vault id | No code path created `store_in_vault` | `createVaultSetupOrder` + `npm run vault:setup`, per Orders v2 spec 2.36 (`payment_source.paypal.attributes.vault` with `store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`) | `autonomy`: "vault setup (buyer consent) flow" (mock); real sandbox run below | Verified in the sandbox; live mode not tested |
| P4-6 | Medium | A hash chain alone cannot detect a consistent rewrite of history by someone with DB write access | Phase 3 docs | Ed25519-signed checkpoints stored in the DB **and** appended to an external file; verification needs only the public key (`npm run audit:verify`) | `audit-integrity`: consistent rewrite, tail truncation, reordering, forged DB checkpoint, deleted DB checkpoints, doctored external file | See "What the audit design does not prevent" |
| P4-7 | Low | `.env.example` placeholders (`<sandbox-client-id>`) passed the placeholder check, so an unedited copy was accepted as real credentials | Regex lacked an `<…>` pattern | Placeholder check rejects `<…>` values | `config`: "rejects placeholder PayPal credentials" | – |
| P4-8 | Info | Authorization already depended only on structured fields; filter is defense in depth | Code trace: `evaluatePolicy` and `requiresBuyerApproval` read only key-derived identity, integer cents, merchant/category ids, freeze flag, DB policy | Kept; added adversarial tests | `injection` (22 tests incl. look-alike Unicode merchant ids → 400, misleading merchant names, reworded attacks bounded by caps, all with zero PayPal calls) | Within policy, a successful injection can still buy something allowed |

## Payment execution paths (traced)

| Path | Who | Enforced before PayPal |
|---|---|---|
| `POST /api/agent/transactions` | agent key | strict schema; injection screen; under DB lock: freeze, merchant/category allowlists, agent and global caps, agent and global daily budget, idempotency, approval requirement (vault only within the agent's `autonomousLimit`) |
| `POST /api/agent/orders/:id/capture` | agent key, own orders only | order must be SentinelPay's and `PENDING_APPROVAL`; agent not frozen; single-winner claim |
| `POST /api/admin/orders/:id/capture` | operator with `payments:operate` | same as above |
| `POST /api/admin/transactions/:id/reconcile` | operator with `payments:operate` | only `RECONCILE_REQUIRED`; reuses the recorded mode and PayPal-Request-Id |
| `npm run vault:setup` (CLI on the server host) | whoever holds the PayPal app credentials | buyer must approve on PayPal (consent); sandbox only |

## Operator roles

| Permission | VIEWER | AUDITOR | OPERATOR | ADMIN |
|---|---|---|---|---|
| Read dashboard (summary, agents, transactions) | ✓ | ✓ | ✓ | ✓ |
| Capture, cancel, reconcile | | | ✓ | ✓ |
| Freeze an agent | | | ✓ | ✓ |
| Unfreeze an agent | | | | ✓ |
| Create agents, change policy, rotate agent keys | | | | ✓ |
| Read and verify the audit log; sign checkpoints | | ✓ | | ✓ |
| Manage operators | | | | ✓ |
| Use the AI assistant (`assistant:use`) | | | ✓ | ✓ |

Every denied credential (`AUTH_FAILED`, with reason and key prefix) and every denied
permission (`PERMISSION_DENIED`) is written to the audit log. Privileged actions are
attributed to the named operator.

## What the audit design protects against, and what it doesn't

The audit log is **tamper-evident, not immutable**. Nothing here makes data impossible to change.

| Attacker capability | Outcome |
|---|---|
| Application runtime credentials (SQL injection, stolen `DATABASE_URL`) | Cannot UPDATE, DELETE, TRUNCATE or disable triggers on audit tables (permission denied) |
| DB owner or superuser edits or deletes an event | Hash chain breaks at that event |
| DB owner rewrites the whole chain consistently | Detected: signed checkpoints no longer match (needs the public key and the external file) |
| DB owner truncates recent events | Detected only up to the newest checkpoint. Events after it can be removed without detection. The window equals the sweep interval (30s by default). |
| DB owner forges checkpoint rows | Detected: the signature doesn't verify with the public key |
| Holder of the signing key **and** write access to the external checkpoint file **and** DB owner | **Not detected**. They can rewrite and re-sign everything. |

**Locally**, the signing key and the checkpoint file are under `.secrets/` on the same
machine and account as the database. That demonstrates the mechanism but gives **no
real separation**.

**For production:**
- sign with a KMS/HSM key the app can only *use*;
- write checkpoints to WORM storage, such as object storage with a retention lock;
- run `npm run audit:verify` from a separate account that has the public key only.

## Vault mode (Task 4) status: PASS (real sandbox)

- **Buyer consent:** `npm run vault:setup -- --write-env` created setup order `5MT10807G13413528`.
  A sandbox buyer approved it; it was captured as `5MG58512E5460293P` (COMPLETED, USD 1.00).
  PayPal returned a vault token with status `VAULTED` (stored in `.secrets/paypal-vault-id`, never printed).
- **Autonomous payment** through the gateway (agent `autonomousLimit` $1.00):
  - order `5FK118373W219345Y` was created already `COMPLETED` (HTTP 201, `debug_id f686456267cef`);
  - capture `2NK85168TH412615K`, COMPLETED, USD 1.00, confirmed via `GET /v2/checkout/orders`;
  - resending the same `requestId` returned the same capture with zero new PayPal calls;
  - $1.50 (over the autonomous limit) went to `PENDING_APPROVAL` instead of the vault;
  - $5.00 was blocked before PayPal.
- **Settled questions:** PayPal accepted `vault_id` with `stored_credential.payment_initiator: MERCHANT`, and the order completes on creation.

Implementation notes:

- **Code:** implemented and unit-tested against the mock.
  - The setup order sends `payment_source.paypal.attributes.vault { store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER }`, per the Orders v2 spec.
  - After capture, the vault id is read from `payment_source.paypal.attributes.vault.id`.
  - Merchant-initiated payments send `payment_source.paypal.vault_id` with `stored_credential.payment_initiator: MERCHANT`.
- **Not verified:** a declined or revoked vault token against the real sandbox. The mock
  covers the failure path (`FAILED`, budget released), but the real PayPal error codes
  weren't observed.


---

# Phase 5: release boundary

## Vault failure handling (real sandbox)

| Case | PayPal (real sandbox) | Gateway outcome | Evidence |
|---|---|---|---|
| Nonexistent `vault_id` | 403 `PERMISSION_DENIED` (`debug_id f734049b5a936`) | `FAILED`, budget `RELEASED`, never `COMPLETED`; a same-`requestId` retry makes 0 PayPal calls; a fresh request fails the same way; audit `BUDGET_RESERVED` then `PAYMENT_FAILED` with the debug id; token value absent from logs | Live run, 7/7 checks |
| Nonexistent billing agreement | 422 `BILLING_AGREEMENT_NOT_FOUND` | Same non-retryable branch | Direct probe |
| Revoked token | **Not tested in the sandbox.** Revoking deletes the demo's only vault token. | Mocked as the observed 403: `FAILED`, released, no retry | `autonomy` test |
| Vault payment needs buyer action again | Not reproducible on demand | `PENDING_APPROVAL`, never `COMPLETED` | `autonomy` test (mock) |
| `COMPLETED` order with a `DECLINED` capture | Not reproducible on demand | `DECLINED`, budget released | `autonomy` test (mock) |

## Production boundary controls

- **Refuses to start in production** unless:
  - `APP_BASE_URL` is https;
  - `TRUST_PROXY_HOPS >= 1` (TLS terminated at a known proxy);
  - all CORS origins are https;
  - signed audit checkpoints are configured;
  - the database role is neither a superuser nor the audit-table owner.

  Tests: `config`, "production refuses to start…".
- **Runtime:** in production every request that didn't arrive over HTTPS gets
  403 `HTTPS_REQUIRED`, except `/health`. `X-Forwarded-Proto` is honoured only from trusted
  proxy hops, and HSTS is sent. Test: `api-security`, "production transport enforcement".
- **Privileged endpoints** require a named operator key with the right role. Freeze needs
  OPERATOR or ADMIN; unfreeze, policy changes, agent creation and key rotation need ADMIN.
  Tests: `operators` role matrix; live `sandbox:e2e` freeze checks.

## Limitations (not implemented, don't claim them)

- **No MFA or SSO.** Operator keys are bearer tokens. Mitigations: hashed at rest,
  revocable, optional expiry, rotation, audited denials. For production, put an SSO/MFA
  proxy in front of `/api/admin`.
- **Rate limiting is per process (in memory).** With N instances, the effective limit is
  N times the configured value, and counters reset on restart. For production, use a
  shared store (e.g. Redis) or rate-limit at the proxy/WAF.
- **Audit log is tamper-evident, not immutable** (see Phase 4).
- **No webhooks or refunds** (see `docs/PAYPAL_INTEGRATION.md`).
- **TLS is terminated by a reverse proxy**; the app itself serves plain HTTP behind it.


---

# Phase 7: in-app AI assistant

- **Endpoint:** `POST /api/admin/assistant/messages`. It needs an operator key with
  `assistant:use` (OPERATOR or ADMIN) and has its own per-operator rate limit.
- **Model:** runs server-side (Gemini key from the server environment). The browser gets
  only an opaque conversation id.
- **Same code path as the agent API:** intents go through `transactionRequestSchema` and
  `SentinelGuard.submit`, so caps, allowlists, freeze state, injection screening,
  idempotency (a server-chosen `assistant-<uuid>` request id) and the buyer-approval
  requirement apply unchanged.
- **No credentials for the model:** it never holds an agent, operator or PayPal key.
- **Bounded per message:** at most 2 purchase submissions and 6 model turns. A
  conversation is capped at 12 messages and expires after 30 minutes of inactivity.
- **Bound to its owner:** a conversation belongs to the operator and agent that started
  it; anyone else gets 404.
- **Audited:** every message records an `ASSISTANT_MESSAGE` event with the operator,
  agent, status and resulting transaction ids. The request text isn't stored.
- **Failures are reported honestly:** if the model is unavailable, over quota or returns
  nothing, the reply is `MODEL_ERROR` and still lists any purchase already submitted in
  that message. Short per-minute limits (up to 60s) are waited out; daily quotas fail fast.

Tests: `test/integration/assistant.test.ts` (19), with a scripted Gemini stub and the
PayPal mock. Mutation check: removing the permission check fails tests in two suites.

**Live evidence (2026-10-28, real Gemini `gemini-3.5-flash` and real PayPal sandbox):**

| Request | Outcome | PayPal create calls |
|---|---|---|
| Allowed | Order `1S150670PA619145R`, capture `2YL76273R2894791V`, USD 12.99 | 1 |
| Overspend | `BLOCKED` | 0 |
| Injected listing | Model ignored the gift-card instruction and bought the $9.50 mouse: `063711906B627191V` | 1 |
| Vague request | Clarifying question | 0 |
| Answer to the question | `0CJ82893CE0739207`, USD 4.50 | 1 |

All three orders were confirmed via PayPal's Orders API, and the ledger matches.

**Limitation:** conversation state is in process memory. A restart ends open
conversations (transactions and audit are persisted), and with several instances a
conversation is pinned to the one that started it.
