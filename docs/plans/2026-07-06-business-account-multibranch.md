# Business-Account (Multi-Branch / Multi-Staff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) tracking.
> **This is an epic** — build it phase-by-phase, each phase is its own branch + PR + Tier-2 review.

**Goal:** Add a per-client, flag-gated **business-account layer** (HQ admin + branches + branch clerks +
staff attribution) on the existing single-account system, delivered as an isolated instance per client
company. See the full design in `docs/specs/2026-07-06-business-account-multibranch-design.md` (ADR-021).

**Architecture:** One `account_id` = one client business; `branches` + `users` tables and
`branch_id`/`staff_user_id` on `expenses`. Identity via `crypto.scrypt` + opaque sessions reusing the
existing `checkDash` bearer path; a single `scopeForUser` "bouncer" funnelled through `lib/supabase.js`
filters every query by role/branch. Master view = live `GROUP BY` (no stored workbooks). Bot = clerk
tool with `/start <token>` binding. Anomaly = staff-first + admin N-day valve. Payments = admin-edit /
clerk-view + chunked bulk mark-paid.

**Tech Stack:** Node 22, Express, vanilla JS frontend (no framework), Supabase Postgres via REST,
`node:test`. **No new npm dependencies** (`scrypt` is Node core).

**Spec:** `docs/specs/2026-07-06-business-account-multibranch-design.md` · **ADR:** ADR-021 (+ ADR-010
one-codebase flags, ADR-015 custody, ADR-020 delivery model).

---

## ⛔ HARD CONSTRAINTS (apply to every task)

1. **Flag-gated (ADR-010).** The entire business layer lives behind `capabilities.multiUser` (from
   `getCapabilities()`). **Flag OFF = today's product, byte-for-byte** — no login roles, no branches, no
   staff tagging, personal bot. **All existing ~1104 tests must stay green after every task.** New
   behaviour is covered by new tests that run with the flag ON.
2. **One codebase, N deployments.** No per-client code forks, ever. Client differences = config/data
   (template, categories, branding, flags, secrets). No `if (client === 'X')`.
3. **Isolation via the ONE bouncer.** Every company/branch-scoped query goes through `scopeForUser` →
   `lib/supabase.js`. No route hand-rolls its own scope filter. Isolation tests are mandatory.
4. **Tier-2 discipline** (auth + DB schema + isolation): TDD, independent cross-review before merge,
   secrets never logged, `.env` moved aside for the suite (standing convention below).
5. **🔒 SECURITY GATE (ADR-025, `docs/specs/2026-07-07-security-hardening-audit.md`).** Every phase carries
   its slice of the SEC-1…SEC-10 backlog and **no paying-client instance goes live until the ⚠️/yes items
   close.** Non-negotiables baked into each task: **RLS `enable`d on every new table** (SEC-8); every
   business route funnels through `scopeForUser` **server-side** + an **isolation test** (SEC-2); all M2
   writes **server-validated** incl. `payment_status` admin-only (SEC-5); every M2 route has a **rate
   limiter** (generous env default, SEC-7); **file uploads magic-byte-validated + stored to the private
   bucket, never a DB blob** (SEC-3, ADR-018); no PII/images in logs (ADR-002). Password policy (SEC-1),
   business offline-cache handling (SEC-4), security-event logging (SEC-6), CI `npm audit` (SEC-9), and
   JWT-scoped RLS (SEC-10) tracked in the audit.

**Standing project convention — run before/after `npm test`:**
```bash
mv .env .env.local.bak   # repo-root .env has LIVE creds
npm test
mv .env.local.bak .env
```

---

## Task split (Owner-directed 2026-07-06 — overrides the default ownership map for this epic)

| Area | Owner |
|---|---|
| **Supabase schema + migrations, identity/auth, provisioning, reports/master, payments, frontend implementation** | **Jeevan** |
| **`lib/supabase.js` scope-helper (central bouncer), the business Telegram bot (`lib/bot.js` + `routes/webhook.js`), Groq ZDR + OCR-provider config knob (`lib/groq.js`), FieldSpec business-category/shape plumbing (`lib/templates.js`/`lib/ocr.js`)** | **Barat** |
| **Frontend** | **Jeevan implements**, following **Mugi's design in `concept-fresh.html`** (Owner 2026-07-07: this is NOT an ownership transfer — Mugi retains frontend design authority (#3); we build the M2 dashboard to his design + customise as needed). |

Coordination: `scopeForUser` is a **frozen contract** (below) — Jeevan produces the scope object from a
session; Barat enforces it in `lib/supabase.js`. Announce shared-file touches in WORKLOG (SOP §4.6).
Branch per phase: `feature/<owner>-m2-<phase>` off `main`.

**Frozen contract — `scopeForUser(user)` → `{ account_id, branch_id?, role }`:**
- `role='admin'` → `{ account_id }` (no branch filter → sees all branches).
- `role='clerk'` → `{ account_id, branch_id }` (hard-filtered to that branch).
- `lib/supabase.js` helpers accept an optional `scope` and apply `branch_id` when present.

---

## Phase 1 — Identity foundation  (Jeevan; Barat owns the `lib/supabase.js` scope hook)

**Files:** `schema.sql` (new tables) · `lib/auth.js` (new) · `routes/auth.js` (new) · `routes/expenses.js`
(`checkDash` → session lookup) · `lib/supabase.js` (scope param — Barat) · `lib/account.js`
(`getCapabilities` reads `multiUser`) · tests.

- [ ] **Schema:** add `users`, `sessions`, `branches`, `bot_bindings` (DDL sketch in spec §5). Keep
  `expenses` additive: `branch_id`, `staff_user_id` nullable (personal rows leave them null). RLS stays
  service-role-mediated (comment the future JWT-RLS policy, don't enable).
- [ ] **`lib/auth.js`** (TDD): `hashPassword`/`verifyPassword` (scrypt, constant-time), `mintSession`/
  `lookupSession`/`revokeSessionsForUser`, `scopeForUser`. Tests: round-trip, wrong password, tampered/
  expired session, scope shape per role.
- [ ] **`checkDash` swap:** when `multiUser` ON, resolve the bearer token via `lookupSession` →
  `{account_id, branch_id, role}` on `req`; when OFF, current static-token behaviour is unchanged.
  Tests: personal path identical (flag off); business path resolves a session.
- [ ] **`lib/supabase.js` scope hook (Barat):** helpers accept optional `scope`; apply `branch_id`
  filter when present. Tests: admin scope returns all; clerk scope filtered.
- [ ] **`POST /api/login` / `POST /api/logout`** in `routes/auth.js`. Tests: valid login → session token;
  bad creds → 401; logout revokes.
- [ ] **Isolation test (critical):** seed two branches; a clerk session for branch A cannot read branch
  B rows through `sbSelect`. Full suite green (personal tests unchanged).
- [ ] Commit(s): `feat(m2): identity foundation — users/sessions/scrypt auth + scopeForUser bouncer`.

## Phase 2 — Provisioning & revocation  (Jeevan)

**Files:** `lib/branches.js` (new) · `routes/branches.js` (new) · `account_settings` (`max_branches`).

- [ ] **`lib/branches.js`** (TDD): `createBranch` (→ branch row + clerk user + one-time `bot_bindings`
  token; returns username+password ONCE), `listBranches`, `softDeleteBranch` (active=false + revoke
  sessions + refuse binding), `addStaff`/`listStaff`/`removeStaff` (name-only).
- [ ] **On account setup, auto-create a "Head Office" branch and bind the HQ admin to it** (admin is also
  a capturer — HQ petty cash). Admin gets a `/start` binding scoped to Head Office + dashboard upload;
  admin reads still see ALL branches (scope has no branch filter), but admin *captures* tag to Head Office.
  Tests: Head Office exists after setup; admin binding scoped to it; admin upload tags Head Office.
- [ ] **`routes/branches.js`**: admin-scoped CRUD; clerk may manage only their own branch's staff.
  Enforce `max_branches`. All writes role-guarded via `scopeForUser`.
- [ ] Tests: cap enforced; created creds shown once then only hash stored; soft-delete flips active +
  kills sessions; clerk cannot create/delete branches; clerk manages only own-branch staff.
- [ ] Commit: `feat(m2): branch/staff provisioning + soft-revoke`.

## Phase 3 — Data dimensions: master view, reports, export  (Jeevan)

**Files:** `routes/webhook.js`/`routes/upload.js` write paths (tag `branch_id`/`staff_user_id`) ·
`lib/reports.js` + `routes/reports.js` (grouping dims) · `lib/excel.js` + export glue (Branch/Staff cols).

- [ ] Writes stamp `branch_id`/`staff_user_id` (from session for dashboard, from binding for bot).
- [ ] `buildReport` gains `branch`/`staff` grouping dims; `routes/reports.js` drill-down params
  (branch→staff→receipt); clerk report pre-filtered by scope.
- [ ] Export: `buildWorkbook` filtered by selection; add **Branch** + **Staff** columns (v1 single sheet).
- [ ] **Durable receipt-image storage (ADR-018) is a prerequisite for business** — land/enable it first:
  images stored to the private `receipts` bucket at ingestion from BOTH paths (Telegram + dashboard),
  `receipt_url` set (Barat ingestion hook + Jeevan `lib/storage.js`, per `2026-07-04-receipt-image-storage-design.md`).
- [ ] **Embed the receipt image in the export (`lib/excel.js`, Jeevan):** a "Receipt" column embedding a
  display-scaled thumbnail per row (exceljs `workbook.addImage`/`worksheet.addImage`, row height bumped) +
  a hyperlink to full-res; fetch bytes from storage at export time; blank cell when no image. Default =
  embed; **"links-only" mode** for very large exports (no resize dep — `sharp` rejected, ADR-014).
- [ ] Tests: master aggregate == sum of branch rows; clerk sees only own branch; export carries the two
  columns + an embedded image for rows with `receipt_url`, blank when absent; links-only mode emits
  hyperlinks not bytes; **the Receipt embed also appears in a PERSONAL export (NOT flag-gated)** — only
  Branch/Staff columns are business-only (flag off → no Branch/Staff, but Receipt column present).
- [ ] **Note:** the Receipt-image embed is a general `lib/excel.js` enhancement (applies to personal +
  business) and may be split out to ship on the personal product independently of this epic.
- [ ] Commit: `feat(m2): branch/staff dimensions + embedded receipt image in export`.

## Phase 4 — Anomaly (staff-first) + payments + bulk pay  (Jeevan)

**Files:** `routes/review.js` (branch scope + clerk-first + N-day valve, `decided_by_role`) ·
`routes/expenses.js` (`payment_status` admin-only write, chunked bulk mark-paid, optimistic `updated_at`).

- [ ] Review queue branch-scoped; clerk decides first (`decided_by_role='clerk'`); admin can override an
  existing decision but not originate until `ANOMALY_VALVE_DAYS` elapsed (then force-decide allowed).
- [ ] `payment_status` (default 'pending') + `paid_at`/`paid_note`; admin-only write (clerk 403 on write,
  200 on read). Bulk `PATCH` over an id list, chunked (`BULK_PAY_CHUNK`), reversible.
- [ ] Optimistic concurrency: `updated_at` mismatch → 409 refresh.
- [ ] Tests: clerk-first gate, valve fires after N days, clerk cannot write payment_status, bulk chunking,
  stale-edit 409.
- [ ] Commit: `feat(m2): staff-first anomaly valve + payment tabs + chunked bulk mark-paid`.

## Phase 5 — Business Telegram bot  (Barat)

**Files:** `lib/bot.js` (business paths, flag-gated) · `routes/webhook.js` (`/start <token>` binding) ·
`lib/groq.js` (ZDR note + OCR-provider config knob) · `lib/templates.js`/`lib/ocr.js` (categories from
FieldSpec).

- [ ] `/start <token>` validates the one-time link → binds `chat_id → user/branch/role` (locked) for
  **both clerk and admin** (admin bound to Head Office; staff never bound); unbound chats refused. Enable
  **Groq ZDR** on the account (ops step) + document the OCR-provider knob.
- [ ] Upload → "which staff?" inline buttons (remember-last default) → tag `staff_user_id`; `branch_id`
  from binding. Personal-expense approve gate (existing detector). Categories from FieldSpec.
- [ ] Simplified today's-bills: list today's receipts + single Delete → "enter number" → "Bill deleted."
  **Branch-scoped.** Weekly = Sun–Sat.
- [ ] Tests: unbound refusal, binding lock, branch scope on today's-bills/delete, staff-tag step,
  personal-gate; personal bot path unchanged (flag off).
- [ ] Commit: `feat(m2): business Telegram bot — binding, staff-tag, branch-scoped flows`.

## Phase 6 — Frontend  (Jeevan)

**Files:** `public/index.html` + `public/js/*` (login, role-aware shell, team view, master overview,
payment tabs, excel-lite grid).

- [ ] Login screen (replaces bare token gate); role-aware shell: admin cockpit vs clerk branch view.
- [ ] Team/hierarchy view (branches, staff, generated creds display-once, binding-link icon) — mirror
  `concept-fresh.html`.
- [ ] Master overview with branch/staff drill-down; Payment Pending/Paid tabs with month+branch+staff
  filters, multi-select, sticky "N selected · total", bulk mark-paid; excel-lite grid (inline cell edit
  + autosave via per-field PATCH, values only, optimistic `updated_at`).
- [ ] Verify via preview tools (role-aware render, isolation, bulk-pay, cell edit). Personal dashboard
  unchanged when flag off.
- [ ] Commit: `feat(m2): role-aware dashboard, team view, payment tabs, excel-lite grid`.

---

## Phase 7 — Per-client profiles + "Send to Admin" branch submission  (Jeevan; ADR-022)
> Added 2026-07-06 for **Premala** (first client). A per-client **flag profile**, not a fork — see
> `docs/clients/premala.md`. The general phases above are unchanged; this layers config + one general
> flag-gated feature on top. Slots in **after Phase 3** (needs the branch data layer) and can run
> parallel to Phases 4–6.

**Files:** `lib/account.js` (`getCapabilities` — new flags) · `lib/branchSubmission.js` (**new**) ·
`routes/branches.js` or a new `routes/submissions.js` (submit/list endpoints) · frontend (Phase 6 shell).

- [ ] **New capability flags** in `getCapabilities()`: `liveMasterMerge` (default **true** = general
  product), `excelLiteGrid` (default **true**), `branchSubmission` (default **false**). Premala profile:
  `multiUser=true, liveMasterMerge=false, excelLiteGrid=false, branchSubmission=true`. Tests: defaults
  reproduce today's/general behaviour; Premala flag combo resolves as specified.
- [ ] **`liveMasterMerge=false` / `excelLiteGrid=false` behaviour:** admin master view still shows **live
  reports/analysis** (data layer unchanged — the branch rows are all in the DB); what's suppressed is the
  live-editable/merged master **spreadsheet** surface only. Tests: with the flags off, reports endpoint
  still aggregates live; no excel-lite PATCH surface is exposed.
- [ ] **"Send to Admin" branch submission (`branchSubmission`, GENERAL feature):** a clerk submits their
  branch's compiled export for a period → a `submissions` record (branch_id, period, submitted_by,
  submitted_at, status) → surfaces in the admin dashboard; admin can compile/export. **Reversible;
  audit-trailed.** Keeps the hand-off in-dashboard (no WhatsApp/chat-app leak). Tests: clerk can submit
  only their own branch; admin sees all submissions; re-submit updates not duplicates; flag off → route 404.
- [ ] **Premala PDF export format — PARKED (blocked on client samples).** Their Excel-with-embedded-
  receipt-snapshots → PDF layout. Foundation = Phase 3 receipt-image embed (ADR-018/021). Do **not** build
  blind; decide the PDF-render approach (reuse `@hyzyla/pdfium`/`exceljs` before adding any dep) when
  samples arrive.
- [ ] Commit: `feat(m2): per-client capability profiles + Send-to-Admin branch submission (ADR-022)`.

---

## Phase 8 — Company dimension  (Jeevan; ADR-023)
> Premala runs **multiple companies**. Adds Group → **Company** → Branch → Staff. Additive/flag-gated
> (`companyDimension`); off ⇒ single-company behaviour (today). Spec:
> `docs/specs/2026-07-06-petty-cash-statement-format.md` §5.

**Files:** `schema.sql` (`companies` + `branches.company_id` + `expenses.company_id`) · `lib/auth.js`
(`scopeForUser` gains optional `company_id`) · `lib/branches.js`/`routes/branches.js` (company CRUD) ·
`lib/reports.js` (company grouping dim).

- [ ] Schema: `companies (id, account_id, name, currency, category_set/template_id, active)`;
  `branches.company_id`; `expenses.company_id` (stamped from branch/session). Nullable ⇒ back-compat.
- [ ] `scopeForUser` + `lib/supabase.js` scope (Barat) carry `company_id` when present; admin sees all
  companies, a clerk is pinned to their branch's company. Tests: cross-company isolation.
- [ ] Company CRUD (admin-only); each company owns its category set (FieldSpec #12). Reports gain a
  company grouping dim. Tests: aggregate per company; clerk can't read another company.
- [ ] Commit: `feat(m2): company dimension (Group→Company→Branch→Staff)`.

## Phase 9 — Petty-cash floats + claim engine  (Jeevan; ADR-023)
**Files:** `schema.sql` (`petty_cash_floats`, `cash_in`, `expenses.claim_override`) · `lib/pettyCash.js`
(**new** — balance/claim maths) · `routes/pettyCash.js` (**new** — admin float edit; period summary).

- [ ] Schema: `petty_cash_floats (account_id, company_id, branch_id, period 'YYYY-MM', balance_bf,
  currency, updated_by, updated_at)`; `cash_in (…, date, description, amount, currency)`;
  `expenses.claim_override text` (null=auto, 'claim'|'petty_cash').
- [ ] **Admin sets/edits the float per branch per month** (incl. Head-Office branch). Clerk read-only.
  Tests: admin write / clerk 403; float scoped per branch+period.
- [ ] `lib/pettyCash.js` (TDD): `cashInHand(branch,period)` = balance_bf + Σ cash_in; `expenditure` =
  Σ branch expenses in period; **`balance` = cashInHand − expenditure**; `claims()` = order expenses by
  date, flag the overspend past cashInHand, honour `claim_override`. **Positive balance = surplus (no
  claim); negative = claim.** Tests: under-budget (surplus, no claim), over-budget (claim = |balance|,
  correct expenses flagged), override forces in/out, sign correctness (the +75.09-not-−75.09 case).
- [ ] Claims reuse **Phase 4 `payment_status`** (pending → paid = reimbursed). Tests: a claim shows
  pending; bulk mark-paid reimburses.
- [ ] Commit: `feat(m2): petty-cash floats + claim engine (balance maths, reimbursement)`.

## Phase 10 — Petty Cash Monthly Statement — dual Excel/PDF export  (Jeevan; ADR-023 + ADR-024)
> **Both** exports required, **faithful to the client sample** (Owner: "the exact export of a PDF, just
> like the sample"). Styling contract = spec §2b; Excel template = layout source of truth. Foundation:
> receipt-image storage (ADR-018), currency (ADR-005), `exceljs` (ADR-012), `@hyzyla/pdfium` (rasterise
> PDF receipts), **`pdfkit`** (ADR-024, new pure-JS dep — PDF writer).
> **One model, two renderers** (spec §3).

**Files:** `lib/statement.js` (**new** — StatementModel builder + maths, pure) · `lib/statementXlsx.js`
(**new**, or extend `lib/excel.js`) · `lib/statementPdf.js` (**new** — pdfkit) · `routes/statement.js`
(**new** — `format=xlsx|pdf`) · `package.json` (+`pdfkit`).

- [ ] **`lib/statement.js` (TDD, no I/O):** build the StatementModel — Section A (balance-b/f + cash-in),
  Section B (expenses grouped by the company category set, per-category subtotals + fixed empty padding
  rows), cash-in-hand / expenditure / **balance (correct sign, §6)** / claims, sign-off roles. Reuses
  `lib/pettyCash.js` (Phase 9) + `lib/currency.js` (2nd currency). Tests: totals, balance sign
  (+75.09-not-−75.09), category grouping from FieldSpec, claim rows, empty-company month.
- [ ] **`lib/statementXlsx.js`:** StatementModel → `.xlsx` via exceljs — styling per §2b (red title, blue
  headings, grey headers, category banners, **yellow** category totals, **green** subtotal, red negative
  balance, borders), real SUBTOTAL/SUM (**never `#REF!`**), embedded receipt thumbnail per row +
  hyperlink; optional 2nd-currency + NAME(staff) columns. Tests: totals correct, sign correct, fills
  applied, image present when `receipt_url` set.
- [ ] **`lib/statementPdf.js`:** StatementModel → `.pdf` via **pdfkit** — draw statement page(s) to match
  §2b, then append receipts **in statement-line order**: image → 1 page; PDF receipt → N pages rasterised
  via pdfium; **fit-inside-page, aspect preserved, top-aligned**; missing/unreadable image → skip
  gracefully. Tests: page count = statement + Σ receipt pages, multi-page receipt expands, missing image
  skipped, no PII in logs.
- [ ] **`routes/statement.js`:** `GET /api/statement?company=&branch=&period=&format=xlsx|pdf`; admin =
  all companies/branches, clerk = own branch (via `scopeForUser`). Tests: both formats emit correct
  content-type; scope enforced; bad params 400.
- [ ] **Manual accuracy check** vs the client sample (render + visual diff) before sign-off.
- [ ] Commit: `feat(m2): Petty Cash Monthly Statement — dual Excel/PDF export (pdfkit) with appended receipts`.

---

## Verification (end-to-end, after phases land)

- `npm test` green throughout (personal baseline unchanged; new business tests added per phase).
- Business-on manual run: create account with `max_branches` + `multiUser=true`; admin creates 2 branches
  → 2 clerk logins + binding links; log in as clerk B → sees ONLY branch B; bind bot via `/start` →
  upload → "which staff?" → row appears in admin master under branch B/that staff; flag a personal
  receipt → clerk decides → admin sees "by clerk" + override; bulk mark a month paid (chunked) → clerk
  read-only; excel-lite cell edit autosaves, stale edit → refresh; export = one sheet + Branch/Staff;
  delete branch → clerk login + bot binding refuse.
- Flag-off regression: same build with `multiUser=false` behaves exactly like today's personal product.

## Out of scope (this epic) — see spec §12
Per-staff logins/bindings; stored per-branch workbooks; multi-sheet export; full-spreadsheet excel-lite;
DB-level JWT-RLS (later hardening); pooled multi-tenant (managed silos now — spec §10).
