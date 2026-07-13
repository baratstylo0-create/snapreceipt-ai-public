# STATUS — Receipt Analyser SaaS
> 2026-07-13 Codex: C4-UI automation-impact band is implemented on `codex/c4-ui-metrics`; full suite 1979/1979. PR push/review pending; no merge by Codex.
> 2026-07-13 Codex: C6 admin Activity clarity is implemented on `codex/c6-admin-activity`; full suite 1980/1980. PR push/review pending; no merge by Codex.
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**
> _Last refreshed 2026-07-08 (Claude, for Barat) — reconciled against `git log` / `gh pr list` / WORKLOG, not the previous stale copy. When in doubt, trust `gh pr list`/WORKLOG over this file._

> 2026-07-11 Claude (Opus, for Jeevan) update (receipts/export batch, all merged + deployed to the Premala VPS): **#198** — Telegram **album & PDF** captures now store the receipt image durably (previously only single-photo + dashboard-upload did), so bot-captured receipts finally show a dashboard thumbnail AND ride into PDF exports; **#194** — Petty Cash Statement PDF gained a receipt appendix; **#199** — Manage now opens on the Data-editor spreadsheet by default for admin & clerk. Follow-up IN PROGRESS (own PR, not yet merged): `feature/jeevan-statement-receipt-compilation` redesigns that statement appendix to match a client's real sample — one big full-width receipt image per page + a compact one-line annotation strip, and a single "expenses without a receipt" summary page instead of per-expense placeholder pages (reverses #194's caption-block/placeholder first cut per Owner feedback; summary/excel page left as-is). Full suite 1864/1864. The receipt-photo pipeline (bot→storage→dashboard→PDF) is the client-facing selling point; #198 closed the capture gap, this PR nails the export presentation. Unrelated to the M2 launch-blocker list below.

> 2026-07-11 Claude (Opus, for Jeevan) update: PR #190 merged + deployed — Falc (the dashboard/Telegram chat assistant, `lib/agent.js`) now answers general "how do I use this" product-usage questions (dashboard nav, admin-vs-clerk scoping, Telegram bot commands) via a new additive `PRODUCT_GUIDE` prompt block, not only questions about the account's own expense data. Bot-usage text is reused verbatim from `lib/bot.js` (single source of truth, drift-guarded by test) and deliberately excludes internal/dev docs since it's user-facing. Full suite 1825/1825; CI + Deploy (Premala VPS) both green; live `/health`+`/ready` reconfirmed post-deploy. No schema/route/dependency change, unrelated to the M2/Premala launch-blocker list below — see WORKLOG for detail.

> 2026-07-10 Codex update: Track 1 review of PRs #160/#161/#165/#167/#169 plus doc #163 is complete (fix commits pushed where needed; no merges). Issue #153 dashboard bulk-upload parity is implemented on `qa/upload-staff-assign-153`: staff assignment grid + branch-scoped bulk `PATCH /api/expenses`, upload saved-row branch/staff payload, duplicate flagged-row View/Discard presentation. Full suite 1657/1657; PR pending Claude-J review/merge.

> 2026-07-13 Codex: C5 submit-signal is implemented on `codex/c5-submit-signal`; full suite 1990/1990. PR push/review pending; no merge by Codex.
> 2026-07-13 Codex: C7 admin Overview + Reports branch filters and visibility-aware 25s live refresh are implemented on `codex/c7-overview-reports`; full suite 1985/1985. PR push/review pending; no merge by Codex.

## Current phase
**M1 personal = feature-complete, live-E2E-verified, and stable on `main` (unchanged by M2).**
**M2 business/multi-tenant layer = BUILT through Phases 1–10 and merged to `main`** (PRs #105–#138), with the **first real client instance ("Premala", `xurnpvesgcybrnilxszf`) provisioned end-to-end** (M2 schema applied + first admin + capability profile — PRs #130/#135). The product is now in **pre-live hardening** for that first business client, not in M1 build.

`npm test` on `main` ≈ **1500+ passing** (grew from 775 during M2; exact per-branch counts are in WORKLOG — e.g. observability landed at 1501, the in-review bot branch is 1528). `.env`-aside discipline still applies (see GOTCHAs).

## Track
Vertical AI Solution. **M1** = personal (done). **M2** = business/multi-branch/multi-staff (built, first client provisioned, pre-live). Flag-gated behind `capabilities.multiUser` — OFF = the personal product byte-for-byte.

## Sprint goal (current) — get Premala live, safely
1. **Merge the last in-review PR:** #139 (business Today's Bills — staff-name lines + "Delete a bill → type number"); approved + CI green, awaiting a non-self merge.
2. **Pre-live OPS on Premala (not code):** rotate all secrets (LAUNCH GATE, ADR-015), enable **Groq Zero-Data-Retention** (remaining slice of #107), deploy to an always-on HTTPS host (artifacts ready — Render default / Fly+Docker portable, PR #137 + runbook), point an uptime monitor at `/health` (+ optional `/ready`, #138).
3. **Owner ops on the instance:** admin logs in + rotates the provisioned password, creates real companies/branches, sets petty-cash floats.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Barat | this Claude | M2 scope-bouncer + business Telegram bot. Merged: #119 (supabase scope hook), #121 (business bot binding/staff/branch flows), #123 (FieldSpec categories + OCR-provider/ZDR knob), #134 (company_id in scope + write-path, closed #133). **In review: #139** (Today's Bills staff+delete). Remaining #107 slice = **Groq ZDR** (ops). **2026-07-10: assigned issue #162** — QA round PR-D/PR-K, Telegram bot fixes D10 (reject blurry photos via `lib/confidence.js`), D11 (always ask staff name), D12 (chat/menu button on PC/web), D13 (duplicate-receipt handling) — `lib/bot.js`/`lib/ocr.js`/`routes/webhook.js` is his lane, not built by Claude-J. **Also assigned issue #164** — QA round PR-C/PR-J, C2 multi-branch clerk filter, starting with the data-model check (does `scopeForUser` support one clerk → 2+ branches today?) — his scope-bouncer/isolation domain. | active |
| Jeevan | J | Route-level isolation wiring #131/#132 (merged) + ops: Premala provisioning (#130/#135), deploy artifacts (#137), observability Phase 1 — structured logs + `/ready` (#138). Owns `lib/massupload.js` (#31), the render-side of #17, and merges. | active |
| Mugi | M | Production frontend — design/concept → Jeevan's team adapts the reference frontend in `public/`, following the frozen `/api/*` contract. | ongoing |

## Feature status (M2, on `main`)
- ✅ Phase 1 — identity foundation (users/sessions/scrypt auth + `scopeForUser`) (#108)
- ✅ Phase 2 — provisioning (bootstrap-admin CLI + branch/staff routes) (#112)
- ✅ Phase 3 — branch/staff master-view, clerk scope, Excel Branch/Staff columns + receipt-image embed (#113/#114/#116)
- ✅ Phase 4 — staff-first anomaly valve + payments + chunked bulk mark-paid (#117)
- ✅ Phase 5 — business Telegram bot (binding, staff-tag picker, branch-scoped flows) + FieldSpec categories/ZDR knob (#121/#123)
- ✅ Phase 6 — business login + role-aware shell + payment tabs / excel-lite grid (#118/#120)
- ✅ Phase 7 — capability profiles + Send-to-Admin branch submission (ADR-022) (#122)
- ✅ Phase 8 — company dimension (Group→Company→Branch→Staff) (#125)
- ✅ Phase 9 — petty-cash floats + claim engine (#126)
- ✅ Phase 10 — Petty Cash Monthly Statement, dual xlsx/pdf export (#127)
- ✅ DB-layer isolation: `scopeEq` company_id **null-tolerant** filter + write-path stamping (#134, closed #133); route `req.scope` wiring (#132)
- 🔄 Business Today's Bills: staff-name lines + single-Delete-by-number (#139, in review)
- ⏳ Groq ZDR enablement (ops, remaining #107 slice)

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| **LAUNCH GATE (ADR-015):** no real (non-Owner) user onboarded until every secret is rotated post-dev-exposure AND an independent Supabase backup exists outside Barat's account. `DASHBOARD_TOKEN` rotated; **Groq/Supabase keys still owe rotation** before real customers. | Owner/Barat | blocks real-user launch |
| **Groq Zero-Data-Retention** not yet enabled on the business/Premala Groq account (regulated-client requirement; the OCR-provider knob to swap to Azure/Bedrock/Vertex is already in code, #123). | Owner/Barat | pre-live ops |
| **First validated deploy** of Premala to an always-on HTTPS host — artifacts + runbook ready (#137), but no deploy has been run/verified end-to-end yet. | Barat/Jeevan | pre-live ops |
| **Legacy `company_id` backfill:** rows created before Phase 8 have `company_id = null`; #134's filter is null-tolerant so they stay visible, but a future **company-scoped-only role** needs the backfill first (see #134 / closed #133). | Barat/Jeevan | tracked, not yet needed |
| **Data question: `M/S Cash` row** (from M1, 2026-07-03) — a live `status=saved` row vs a WORKLOG soft-delete claim. Financial data, untouched. **Carry-forward — verify still relevant.** | Owner | needs confirmation |
| Non-blocking hardening: categorizer (#14), `/api/templates` label sanitize-at-render (#17), per-image Telegram links (#31, Jeevan lane) | Jeevan | tracked, non-blocking |
| **Real TLS cert (Let's Encrypt) for the Premala VPS (31.97.70.50)** — currently self-signed, so every check needs `-k`, dashboard shows a browser trust warning, and Telegram needs the manual `WEBHOOK_CERT_PATH` upload workaround instead of a normal trusted webhook. Needs Owner to pick a subdomain on a domain he owns (any name — doesn't need to be Premala-branded) and add an A record → `31.97.70.50`, then Certbot + nginx + drop `WEBHOOK_CERT_PATH`. **Deferred — do later.** | Owner/Jeevan | deferred, not urgent |
| **VPS security hardening batch** (from 2026-07-10 Opus-reviewed checklist): `PermitRootLogin yes` + no fail2ban on the shared VPS; UFW port 22 open to any IP with no allowlist; `npm audit` in CI is informational-only (doesn't fail the build); no Dependabot; Supabase backup/PITR tier not yet confirmed. | Owner/Jeevan | deferred, not urgent |

## GOTCHAs (carry forward — all still valid)
- **`.env` in the repo root holds LIVE Supabase/Groq secrets** — always `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail (pure env contamination).
- **`npm install` before diagnosing "post-merge" test failures** — a dep added to `main` after your branch forked (e.g. `pdfkit` for #127) leaves `node_modules` stale.
- **Never self-merge** — auto-mode classifier blocks self-authored PR merges; Tier-2 (auth/isolation) code needs an independent reviewer regardless. Owner/Jeevan direct each merge.
- Correct Supabase project for THIS app = the per-client instance (e.g. Premala `xurnpvesgcybrnilxszf`). The FrictionAI parent `fziaxuhonvrhqjulhcyu` is a DIFFERENT db — don't confuse them.
- **Personal vs business must never clash** — business behaviour is gated behind BOTH `capabilities.multiUser` and a resolved `binding`; keep the personal-mode regression tests green.

## Not doing yet
Billing/subscriptions, multi-instance fleet management, AI eval gate (P8), Sentry/APM (observability Phase 2, deferred behind an ADR). M2 itself is no longer "deferred" — it is built and in pre-live for the first client.
**2026-07-09 QA round:** PR-A (`qa/pr-a-export`) is merged. Codex is handling round 2 PR-E on `qa/pr-e-payments-fix` (Payments staff labels, all-branches statement guidance, statement-PDF image regression), then must stop after opening the PR for Claude-J review/merge. PR-F (`qa/pr-f-ia`) starts only after that review/merge.
