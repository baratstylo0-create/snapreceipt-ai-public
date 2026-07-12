# Round 2 — Metrics, UX Clarity, Submit-Signal + Barat/Codex Task Split

> **Date:** 2026-07-13 · **Author:** Jeevan (via Claude, CTO/orchestrator)
> **Companion to:** `docs/plans/2026-07-13-premala-customisation-and-lineitem-plan.md` (that doc has the
> deep feature specs for the packaging + line-item splitting; THIS doc adds the round-2 decisions and
> is the **authoritative work split** between Barat and Codex).
> **Positioning:** Friction = tech ecosystem provider automating manual work across sectors. Petty
> cash is beachhead #1. Metrics = the instrument panel for the whole company, not a petty-cash feature.

---

## 0. Round-2 decisions (new, Owner-confirmed 2026-07-13)

| # | Decision | Status |
|---|----------|--------|
| R1 | **ERP-shaped CSV** (match SQL Accounting/AutoCount import format) | ⏸ **DEFERRED** — not now |
| R2 | **Automation-impact metrics** on Overview (client value + internal ops) | ✅ BUILD |
| R3 | **Submit-signal replaces manual PDF handoff** (revises earlier "manual email" call) | ✅ BUILD |
| R4 | **Admin Activity clarity** — Branch/Staff column + filter; fix the "whose row is this?" confusion | ✅ BUILD |

### R2 — Automation-impact metrics (Overview)
- **Where:** a compact **"Automation impact" band at the TOP of the Overview page**, above the existing KPIs.
- **Client-facing (visible to admin):** this month — **receipts auto-processed**, **% that needed no edit**,
  **estimated hours saved** (= receipts × a stated assumption, default **2.5 min/receipt**, config
  `MANUAL_MINUTES_PER_RECEIPT`), **statements generated**.
- **Internal/ops (admin-only "details" toggle, or a separate panel):** correction rate per field,
  review-queue dwell time, most-corrected categories, OCR-confidence trend.
- **Data source:** ALL computable from existing columns — `created_at`, `status` transitions,
  `anomaly`/review audit, `line_items`, `confidence`. **No new capture, no migration** — pure aggregation.
- **Why it matters:** proves ROI to the client (renewal + pricing), and tells us which vertical actually
  saves the most time so we invest deliberately.

### R3 — Submit-signal (not a file handoff)
- **Insight:** the admin ALREADY sees every branch's data and can export any branch's statement themselves.
  Emailing a PDF is theatre. So **move a signal, not a file.**
- **Design:** keep a slim **"Submit / month ready"** action for the clerk (reuse the existing
  branch-submission feature — do NOT delete it as the earlier plan said). Clerk taps it → the month's
  branch status flips to **submitted** → admin gets a **notification** (in-app badge + optional Telegram
  ping) and the branch appears in a **"Ready to close"** list → admin exports directly from data they hold.
- **Net:** zero manual email, real close-the-month workflow, reuses existing code. **This supersedes the
  §A1 "drop Send-to-Admin / manual handoff" decision in the companion plan.**

### R4 — Admin Activity clarity (the confusion the Owner hit)
- **Problem (confirmed in code):** the Activity table columns are `Ref · Merchant · Date · Amount ·
  Category · Status` — **no Branch, no Staff column.** An admin sees every branch's rows + their own in
  one flat list with no way to tell whose is whose. UI/UX logic gap.
- **Fix (admin only):**
  1. Add a **Branch** column (and **Staff** where present) to the admin's Activity table/cards.
  2. Add a **branch filter** + a **"My uploads"** option (the admin's own branch / Head Office).
  3. **Default the admin's Activity view to "My uploads"** so they see THEIR data first, and explicitly
     filter to a branch when they want it — directly kills the "why am I seeing everyone mixed together"
     confusion.
- **Clerk:** unchanged — single branch, no Branch column, no filter (server already hard-scopes).

---

## 1. Execution model (3 lanes, collision-safe by file ownership)

- **Barat (his Claude):** his owned files only — bot, OCR/categorize, templates backend, schema.
- **Codex (Owner-side):** frontend (`public/js/**`, `public/css`) + statement/reports/export aggregation
  + metrics + the UX work. Detailed specs in §3.
- **Claude / me (orchestration + config — NOT coding):** env, VPS/nginx/deploy, merges, test-data
  cleanup, security hygiene, keeping the two coding lanes from colliding, plan coherence. §4.

**File-ownership split (disjoint → Barat and Codex run in parallel):**

| Lane | Files |
|------|-------|
| **Barat** | `lib/ocr.js`, `lib/categorize.js`, `lib/templates.js`, `lib/bot.js`, `schema.sql`, `routes/webhook.js`, `routes/templates.js` |
| **Codex** | `public/js/components/*.js`, `public/css/*`, `lib/statement.js`, `lib/statementPdf.js`, `lib/statementXlsx.js`, `lib/reports.js`, `lib/excel.js`, `routes/{statement,reports,manageExport,expenses,submissions,overview}.js` |
| **Me** | `.env`/config on VPS, `/etc/nginx/*`, deploy/merge, CI, test-data cleanup |

If a task needs a file in the other lane, flag it to me — I sequence it so the two don't touch the same
file at once (WORKLOG is the only expected merge conflict; resolve newest-first, mechanical).

---

## 2. Barat's tasks (his lane)

1. **Line-item extraction — confirm + harden.** `expenses.line_items` already persists per-item
   `{description, amount (fx-scaled), category, source, confidence, flagged}` (`assembleExpense`).
   Confirm it's populated for the album + PDF + single-photo paths; make sure per-item `category` is a
   valid template category (drop off-list to keep the aggregation clean). No schema change expected.
2. **Category management backend** (`lib/templates.js` `saveCategories`) — confirm add/remove/reorder a
   category updates the live set that `/api/config` serves + the statement grouping reads. This is the
   client's self-serve freedom; make it robust (guard deleting a category that still has expenses).
3. **Bot** (`lib/bot.js`) — no functional change required for this round unless the submit-signal (R3)
   needs a Telegram ping to the admin; if so, Codex will call a bot helper — coordinate the interface.

## 3. Codex coding tasks (detailed, self-contained specs)

> Conventions for ALL tasks: no build step; pure-DOM (`createElement`/`textContent`, never innerHTML
> with dynamic values); UMD module shim like the sibling components; pure logic node-tested; **TDD —
> write the test first**; before `node --test` do `mv .env .env.local.bak` and restore after; full suite
> green before each PR; **one PR per task**; **never self-merge** (Jeevan names merges); features being
> "removed" are hidden behind a config flag, code kept (ADR-020).

**C1 — Packaging (from the companion plan §A).**
- Remove the **Payments** page from nav for both roles (flag `CAP_PAYMENTS_PAGE`). **EXCEPTION:** keep
  the clerk **"Submit / month ready"** action alive — relocate it (see C5), don't delete it with the page.
- Move the **Petty Cash Statement export** (Excel + PDF) into the Manage → **Data editor** toolbar
  (`grid.js`), wired to `GET /api/statement?period=&format=&branch=`. Clerk → own branch; admin → branch
  picker/all + month.
- Remove the **Template/column builder** from Manage (flag off, keep code). Manage **Category tab shows
  ONLY the chart-of-accounts list.**
- Remove the **Companies / Add-company** UI from Team (`team.js`, flag off, keep code).
- *Acceptance:* clerk + admin dashboards show no Payments page, no template builder, no Companies UI;
  statement export works from the Data editor; category list editor still present.

**C2 — Line-item category splitting in the STATEMENT/REPORTS/EXPORTS (companion plan §B).**
- `lib/statement.js` Section B: when `expense.line_items` has per-item categories, add **each item's
  amount to ITS category subtotal**; off-template/no-category portions fall back to the receipt's
  rolled-up `category` so the total is never lost; rounding remainder → largest item's category.
  Empty-`line_items` receipts behave exactly as today.
- Same distribution in `lib/reports.js` (category grouping) and the xlsx/pdf exports
  (`lib/statementXlsx.js`, `lib/statementPdf.js`, `lib/excel.js`). Receipt evidence page still once per
  physical receipt; show `voucher_no` on each split line (`(1/2)` suffix).
- *Acceptance (TDD):* a RM50-Food + RM30-Petrol receipt → RM50 under Food, RM30 under Petrol; single-
  category + empty-line_items receipts unchanged; fx-scaled sums reconcile; omit zero-expense category
  sections.

**C3 — Show in-line categorization in the dashboard (companion plan §B4).**
- A mixed receipt's category cell reads e.g. `Mixed (2)`; the detail drawer lists per-item
  `description · amount · category` (data already on the row). This is the visible proof of the feature.

**C4 — Automation-impact metrics band (R2).**
- New pure aggregator (suggest `lib/metrics.js` — a NEW file, no collision) computing the R2 numbers from
  the expenses/review data; new `GET /api/metrics` (or fold into overview route). New Overview band
  (`overview.js`) rendering the client-facing numbers, with an admin-only "details" toggle for the ops
  metrics. Config `MANUAL_MINUTES_PER_RECEIPT` (default 2.5).
- *Acceptance:* Overview shows "N auto-processed · N% no-edit · ~H hrs saved · N statements" for the
  selected period; details toggle shows correction-rate/dwell/most-corrected. Pure aggregator unit-tested.

**C5 — Submit-signal (R3).**
- Keep/relocate the clerk **"Submit / month ready"** button (out of the removed Payments page — e.g. onto
  the Data editor or a small header action). On submit → flip branch-month status to `submitted` via the
  existing submissions endpoint → admin sees an in-app **"Ready to close"** list/badge (+ optional
  Telegram ping via a Barat bot helper). Admin exports directly.
- *Acceptance:* clerk can signal a month ready without emailing; admin sees which branches submitted;
  no file is moved.

**C6 — Admin Activity clarity (R4).**
- Add **Branch** (+ **Staff** where present) column to the admin Activity table + cards. Add a branch
  filter + **"My uploads"** option; **default the admin view to "My uploads."** Clerk view unchanged.
- *Acceptance:* admin can instantly tell whose receipt each row is; defaults to their own; can filter to
  a branch. Clerk sees no branch column/filter.

**C7 — Overview + Reports filters + live update (companion plan §D).**
- Admin-only branch + "My uploads" filters on Overview + Reports; clerk locked to own branch. Live update
  via polling (~20–30s) + refetch on tab focus/visibility; pause when hidden. No websockets.

## 4. My lane (orchestration + configuration — Claude)

- **Env/config on the VPS:** set `STATEMENT_COMPANY_NAME="BUMI ERA NEW CONSTRUCTION (M) SDN BHD"` (confirm
  spelling vs the sample PDF), `MANUAL_MINUTES_PER_RECEIPT=2.5`, any `CAP_*` flags C1 introduces.
- **Test-data cleanup:** delete the stray `asdad (MYR)` company + any other junk test rows on live.
- **Security hygiene:** rotate current dashboard sessions (pre-nginx-fix tokens may sit in FrictionAI logs).
- **Infra:** nginx `/receipt/`→:3005 already fixed; keep an eye on deploy/health after each merge.
- **Coordination:** keep Barat + Codex lanes non-overlapping; sequence any cross-lane file touch; run the
  Owner-named merges; keep the plan docs + WORKLOG/ledger coherent; CI/setup.

## 5. Deferred / not now
- **ERP-shaped CSV** (R1) — revisit once a client will pay for one-click ERP import.
- **Direct ERP/accounting integration** (Level 3) — later, per-client.
- **Per-item manual category override** — later iteration; OCR-driven split ships first.
