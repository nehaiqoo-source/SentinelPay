# SentinelPay

A policy gateway between AI agents and PayPal. Agents submit structured purchase requests.
SentinelPay authenticates the agent, screens free text for prompt injection, atomically
reserves budget in PostgreSQL against per-agent and global caps, merchant/category
allowlists and freeze state, and only then calls the PayPal Orders v2 API (**sandbox only**).

## Prerequisites

- Node.js 20+ and npm
- Docker (for the local PostgreSQL 17 container)
- A PayPal developer account (free) for **sandbox** credentials
- A Google Gemini API key, needed only for the AI agent demo

## PayPal sandbox setup

1. Sign in at https://developer.paypal.com. Under **Testing tools → Sandbox accounts**,
   create a **Business** account (seller) and a **Personal** account (buyer), both with
   country **United States**. A seller in another country can make checkout fail with
   `UNSUPPORTED_PAYEE_CURRENCY`; see `docs/PAYPAL_INTEGRATION.md`.
2. Under **Apps & Credentials → Sandbox**, create a REST app linked to that Business
   account. Copy its Client ID and Secret into `.env`.
3. In the app's settings, enable **Save payment methods** (Vault). This is needed only
   for autonomous (no-approval) payments.
4. Approve sandbox orders by signing in as the **Personal** buyer, in a private window.

## Quick start

```bash
npm install
npm run db:up                         # PostgreSQL 17 in Docker on 127.0.0.1:5433 (needs Docker running)
cp .env.example .env                  # set MIGRATION_DATABASE_URL (owner) and sandbox PayPal credentials
npm run migrate                       # schema, as the owner
npm run db:app-role -- --write-env    # least-privilege runtime role; sets DATABASE_URL in .env
npm run audit:keygen -- --out .secrets/audit-signing   # then set AUDIT_SIGNING_KEY_FILE / AUDIT_CHECKPOINT_FILE
npm run operator -- create --id <you> --name "<Your Name>" --role ADMIN --out .secrets/<you>.key
npm run dev                           # http://localhost:5000, sign in with your operator key
```

Copy your key for the dashboard with `tr -d '\n' < .secrets/<you>.key | pbcopy`. Keys are
never printed. `.secrets/` is git-ignored.

The server refuses to start if the database is unreachable, migrations are pending,
or configuration is invalid (including any PayPal host other than the sandbox).

## AI purchasing assistant (in the dashboard)

Start the gateway with `GEMINI_API_KEY` set (server-side only), sign in as an OPERATOR or
ADMIN, and use **Ask the purchasing agent**:
1. Pick an agent and type a request in plain language.
2. Gemini checks the agent's policy, asks a clarifying question if the item, price or
   merchant is missing, and submits a structured purchase intent.
3. SentinelPay decides with the same code path as the agent API. The panel shows the
   model's intent, SentinelPay's decision and violations, and any real PayPal order and
   capture ids.

Conversations are kept on the server, bound to the operator and the agent, and each
message is audited. The model never sees any credential. If Gemini is unavailable or out
of quota, the reply says so and states exactly what was (or wasn't) paid.

## Run the demo (Gemini agent + PayPal sandbox)

```bash
npm run vault:setup -- --write-env    # once: buyer consent creates a PayPal vault token (approve as sandbox buyer)
npm run dev                           # restart so the gateway picks up the vault
OPERATOR_KEY_FILE=.secrets/<you>.key npm run demo:setup   # creates the "demo-shopper" agent
GEMINI_API_KEY=<key> npm run demo:agent                    # four scenarios: allowed, overspend, injection, hijacked agent
```

Open the console at http://localhost:5000 to watch the transactions, blocked attempts
and audit trail. The full script with expected outcomes is in
`docs/SUBMISSION.md` → Demo plan.

## Testing

```bash
npm run typecheck        # strict TypeScript (src, tests, scripts)
npm test                 # unit + integration tests against the Docker database and a local PayPal mock
npm run check:secrets    # run before pushing: no keys or secrets in committable files
```

Live checks against the real PayPal sandbox (the gateway must be running) are documented in
`docs/SANDBOX_TESTING.md`: `npm run sandbox:check`, `npm run sandbox:e2e`, `npm run vault:setup`.

## Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | Strict TypeScript check of `src/`, `test/` and `scripts/` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run migrate` | Apply SQL migrations in `migrations/` (as the owner) and refresh runtime-role grants |
| `npm run db:app-role -- --write-env` | Create the least-privilege runtime role and point `DATABASE_URL` at it |
| `npm run operator -- create\|list\|rotate\|revoke` | Manage named operator keys (written to 0600 files, never printed) |
| `npm run audit:keygen -- --out <prefix>` | Generate the Ed25519 audit checkpoint key pair |
| `npm run audit:verify -- --public-key <pub> --checkpoints <file>` | Independent audit verification (public key only) |
| `npm run vault:setup -- [--write-env]` | Sandbox buyer-consent flow that creates a PayPal vault id |
| `npm test` | All unit and integration tests (needs the Docker database) |
| `npm run test:unit` | Unit tests only (no database) |
| `npm run sandbox:check` | Real PayPal sandbox end-to-end check (needs sandbox credentials) |
| `npm run sandbox:e2e` | Live security checks against a running gateway on the sandbox (see `docs/SANDBOX_TESTING.md`) |
| `npm run demo:setup` / `npm run demo:agent` | Create the demo agent / run the Gemini agent scenarios |

## API overview

Agents (`Authorization: Bearer sp_agent_…`):

- `POST /api/agent/transactions`: `{ requestId, amount, merchantId, category, description, merchantName? }`
- `GET /api/agent/transactions/:id`, `POST /api/agent/orders/:orderId/capture`, `GET /api/agent/policy`

Operators (`Authorization: Bearer sp_op_…`, a named key with a role), under `/api/admin`:

- **Agents:** create (the response includes the agent's API key once), update policy, freeze, unfreeze, rotate key.
- **Transactions:** list, capture, cancel, reconcile.
- **Other:** summary, `me`, audit log, audit verification, signed checkpoints, operator management.

Permissions by role are listed in `docs/SECURITY.md`.

## AI usage and disclosure

- **Runtime AI:** the purchasing agent uses Google Gemini (function calling) to turn
  requests into structured payment intents or clarifying questions. It runs in the
  gateway's in-app assistant (`POST /api/admin/assistant/messages`) and in the
  `npm run demo:agent` CLI.
- **Not decided by the model:** whether a payment is allowed. That is always
  deterministic server-side policy, which the model can't change.
- **Development:** this codebase was written with the help of an AI coding assistant
  (Claude Code).

## License

MIT. See `LICENSE`.

## Documentation

- `docs/SECURITY.md`: findings, fixes, regression tests, remaining risks.
- `docs/SANDBOX_TESTING.md`: reproducible PayPal sandbox procedure and vault configuration.
- `docs/PAYPAL_INTEGRATION.md`: exact PayPal flows, observed error handling, and unimplemented features (webhooks, refunds).
- `docs/HACKATHON_CHECKLIST.md`: rules compliance checklist.
- `docs/SUBMISSION.md`: Devpost description and the timed demo plan.
