# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**M1 personal = FEATURE-COMPLETE and END-TO-END VERIFIED.** All 12 backend features + #1 PDF (both surfaces) + the reference frontend + P6 security hardening are **merged to `main`**. `npm test` on `main` = **775 passing**. On 2026-07-03 the Owner + J1 ran a full live E2E walkthrough against the real Supabase (`xurnpvesgcybrnilxszf`) + Groq: dashboard upload → OCR → save → list/filter → edit → 18-category auto-categorization → MYR currency → Excel export → AI agent chat (native tool-calling) → reports → review-queue approve — **all working**. Two real bugs found + fixed during that walkthrough (edit-expense amount `step`, agent currency-symbol) — PR #75.

**Now starting: M-Frontend (Mugi).** Owner has assigned Mugi the production frontend. Workflow: **Mugi delivers a design/concept; Jeevan's team extracts the source and adapts our existing frontend to it, following the frozen `/api/*` contract.** Mugi is UNBLOCKED — the reference frontend in `public/` is his starting point (see `docs/roles/MUGI.md`).

**M2 (business/multi-tenant) remains DEFERRED** until the Owner signs off that personal is solid.

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
1. **Onboard Mugi onto the frontend** (design/concept → team adapts). Everything he needs is in the repo.
2. **Apply the voucher/reference-number DB migration** (`db/2026-07-03-voucher-reference-number.sql`, ADR-017) to the live Supabase project — merged to `schema.sql` (PR #72) but NOT yet run against `xurnpvesgcybrnilxszf`. Until applied, `voucher_no` is simply never shown (fully backward-compatible). Needs someone with SQL Editor access.
3. **Receipt-image display** (long-open): dashboard uploads store no image and `/receipt/:fileId` needs `BOT_TOKEN`. Owner chose the proper fix — Supabase Storage → real URL in the `receipt_url` column. Spec still to be written; now unblocked (no longer racing Barat's voucher edits, which landed).

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J1 | Merges (voucher #72, spec #70, handoff #71 all merged); ran live E2E; owns receipt-image storage spec next | active |
| Barat | B1 | Voucher schema/insert-path (PR #72) merged. **Must restart his live ingest pipeline** to pick up MYR (still emitting USD — a stale-`process.env` issue, not a code bug). Onboarding/chat-id spec (PR #73) is M2 — spec only, build ON HOLD | available |
| Mugi | M1 | **STARTING: production frontend** — design/concept from the existing reference frontend, following the API contract | starting |

## Feature status (personal M1)
- ✅ All 12 backend features + #1 PDF (both surfaces) merged to `main`.
- ✅ Reference frontend (every feature surfaced) + P6 security hardening merged.
- ✅ Voucher/reference number `RC-YYYY-NNNN` — app code merged (PR #72). ⚠️ DB migration not yet applied live.
- ✅ Live E2E verified end-to-end (2026-07-03).
- 🔄 Mugi: production frontend (design → adapt).
- ⏳ Receipt-image storage (Supabase Storage) — spec pending.

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| **Voucher DB migration not applied live.** `db/2026-07-03-voucher-reference-number.sql` merged into `schema.sql` but not yet run on `xurnpvesgcybrnilxszf`. J1's Supabase MCP only reaches the FrictionAI parent (`fziaxuhonvrhqjulhcyu`), not this project — needs someone with SQL Editor access. Idempotent, safe to re-run. | Barat/Jeevan | pending manual SQL run |
| **Data question: `M/S Cash` row.** A `M/S Cash` row (created 2026-07-03T14:53) is live with `status=saved`, `deleted_at=null`, but a prior WORKLOG entry claims an `M/S Cash` junk row was soft-deleted. Either a second row exists or the soft-delete didn't take. Not touched — financial data, needs Owner confirmation. | Owner | needs confirmation |
| **LAUNCH GATE (ADR-015):** no real (non-Owner) user onboarded until every secret is rotated post-dev-exposure AND Jeevan holds an independent Supabase backup outside Barat's account. `DASHBOARD_TOKEN` rotated 2026-07-03; Groq/Supabase keys still owe rotation before real customers. | Owner/Barat | tracked, blocks real-user launch |
| Non-blocking hardening: categorizer (#14), `/api/templates` label sanitization (#17), exceljs `uuid` bump (#20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username (to add as collaborator) | Jeevan | needed when Mugi starts pushing |

## GOTCHAs (carry forward)
- **`.env` in the repo root holds LIVE Supabase/Groq secrets** — always `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail (pure env contamination).
- **`npm install` before diagnosing "post-merge" test failures** — a dep added to `main` after your branch forked leaves `node_modules` stale.
- Auto-mode classifier **blocks self-authored PR merges** — Owner must direct each one, or do a full read-diff+test review first.
- Correct Supabase project for THIS app = `xurnpvesgcybrnilxszf`. The FrictionAI parent `fziaxuhonvrhqjulhcyu` is a DIFFERENT db (different schema) — don't confuse them.

## Not doing yet
Business-account / multi-tenant layer (M2 — deferred until Owner signs off personal), billing, hosting/deploy, observability (P7), AI eval gate (P8).
