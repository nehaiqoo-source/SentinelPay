# PayPal AI Hackathon: submission checklist

Rules source: official rules at https://paypalaihackathon.devpost.com/rules (re-read 2026-10-27 16:21 UTC; unchanged).
Each line is checked against a real artifact in this repository or a recorded run.
**ACTION** marks something only the entrant can do.

**Deadline: Thursday, Nov 12, 2026, 12:00 pm Pacific Time.** After that, the Devpost
submission can't be edited.

## Project requirements

| Requirement (rules §4) | Status | Evidence |
|---|---|---|
| Integrates the PayPal developer platform using the free **sandbox** | PASS | Orders v2 + vault on `api-m.sandbox.paypal.com`; real captures, e.g. `0RS90965NW179300S`, `2NK85168TH412615K`, `03Y1779844336000C` (see `docs/PAYPAL_INTEGRATION.md`). Live mode can't be configured. |
| Uses an AI tool, model or platform, with PayPal central | PASS | Gemini agent (`src/agent/geminiShoppingAgent.ts`, `npm run demo:agent`) turns natural language into structured payment intents; SentinelPay enforces policy and executes them on PayPal. Run on `gemini-3.5-flash` 2026-10-27. A later run the same day was **BLOCKED** by the Gemini free-tier daily quota (20 requests/day); the harness now fails fast on quota errors. |
| Newly created or significantly updated during the period (Oct 1 to Nov 12, 2026) | PASS (claim) | Built during the period. **ACTION:** there is no git history yet. Commit and push before the deadline so the timeline is visible. |
| Installs and runs consistently, as shown in the video | PASS (local) | `npm test` 214/214 (2026-10-27 Phase 6 run); setup steps in README. Not verified on a clean machine by someone else. |
| Third-party SDK/API use is authorized and licensed | PASS | PayPal sandbox (developer terms), Gemini API (the entrant's own key), AG Grid Community (MIT), other npm deps per their licenses |

## Submission requirements

| Requirement | Status | Evidence / action |
|---|---|---|
| Text description of features and functionality | DRAFTED | `docs/SUBMISSION.md`. **ACTION:** paste into Devpost. |
| Access to a functional demo (setup instructions in repo, or hosted URL) | PASS (instructions) | README "Quick start" + "Run the demo". Judges need their own PayPal sandbox app and Gemini key, or credentials you provide (next row). |
| Test credentials or sandbox details needed to run it | **ACTION** | The rules ask entrants to include "any test account credentials, API keys, or sandbox login details necessary". Don't commit them to the public repo; put sandbox-only credentials in Devpost's testing instructions, or state that judges must create their own (steps in `docs/SANDBOX_TESTING.md`). |
| **Public** repo on GitHub, Bitbucket or GitLab | **IN PROGRESS** | Public repo exists (https://github.com/nehaiqoo-source/SentinelPay, currently only `LICENSE`); the local first commit is prepared on top of it. **ACTION:** push. `.gitignore` excludes `.env`, `.secrets/`, `dist/`, `node_modules/`; the secret scan passed (release report). |
| Open-source license detectable on the repo page | PASS (file) | `LICENSE` (MIT, holder "neha"), already the initial commit of https://github.com/nehaiqoo-source/SentinelPay. GitHub shows it in the About box once the code is pushed. |
| Demo video under 3 minutes, public on YouTube, showing the project working | **MISSING** | **ACTION:** record and upload. Script: `docs/SUBMISSION.md` → Demo plan. |
| Video uses no third-party trademarks, copyrighted music or material without permission | **ACTION** | Avoid background music you don't own; the sandbox checkout page shows PayPal branding (PayPal is the sponsor, but keep it to what the demo needs). |
| Materials in English | PASS | All docs are in English |
| Original work, owned by the entrant | **ACTION / disclosure** | Code was written with an AI coding assistant (Claude Code). The rules allow third-party technical assistance if the entrant owns the result; disclosing it in the README/Devpost is recommended (`docs/SUBMISSION.md` includes a disclosure line). |
| Eligibility (age of majority; not resident in excluded jurisdictions; not a sponsor/Devpost employee) | **ACTION** | Only you can confirm this |
| Project free for judges to test until judging ends (Dec 15, 2026) | **ACTION** | Keep the repo public, and keep sandbox credentials valid if you provide them |

## Prizes

| Prize | Eligibility | Status |
|---|---|---|
| Grand prizes / honorable mentions (incl. "Best Use of PayPal + AI", "Best Use of Agentic Commerce") | All eligible submissions | Eligible once the submission is complete |
| **Best Use of AG Grid** | "All Eligible Submissions that use any AG Grid tools" (re-confirmed 2026-10-27) | PASS (eligibility): AG Grid Community 32.3.3 runs three live grids in the operator console. Verified in the browser: the transaction grid's column filter (Status = BLOCKED → 61 blocked rows, 0 others), default sort newest-first, custom status/action cell renderers, and a 200-row audit grid. How well it scores is up to the judges. |

## Judging criteria (equal weight)

| Criterion | What this project shows |
|---|---|
| Technological implementation | Real PayPal Orders v2 + vault (buyer consent, merchant-initiated payments), idempotency, Postgres ledger with atomic reservations, signed audit checkpoints, 214 tests, mutation-checked controls |
| Design | Operator console (AG Grid) with role-aware controls, live transactions, violations and audit verification |
| Potential impact | Lets companies hand AI agents a PayPal wallet with hard, server-enforced limits |
| Innovation | A policy firewall between LLM agents and payments: the model proposes, SentinelPay decides |
| Presentation | **ACTION:** the video |
