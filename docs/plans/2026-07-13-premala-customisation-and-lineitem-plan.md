# Premala Customisation + Line-Item Splitting — Implementation Plan

> **Author:** Jeevan (via Claude, CTO pass) · **Date:** 2026-07-13 · **Executor:** Barat
> **Positioning (ADR-020):** this is a *delivered, per-client system*. Everything below that says
> "remove" means **hide/flag-off in Premala's instance — NOT delete the code.** Keep every feature
> in the codebase, documented, behind a config/CAP flag, so other clients can turn it back on.

---

## 0. TL;DR — what changes

| # | Change | Type | Size |
|---|--------|------|------|
| A1 | Remove **Payments** (Pending/Paid) page from both dashboards | hide | S |
| A2 | Move **Petty Cash Statement export** (Excel+PDF) into Manage → Data editor | move | S |
| A3 | Remove **Template editor** (field/column builder) from Manage, both roles | hide | S |
| A4 | Keep **Category management** (chart of accounts) — the client's self-serve freedom | keep | — |
| A5 | Hide **Companies** for Premala (pending one-vs-many answer) | hide | S |
| **B** | **Line-item category splitting** — one receipt → correct per-category totals ⭐ | build | **L** |
| C | Confirm/polish category **flow-through** (add a category → adapts everywhere) | verify | S |
| D | **Overview + Reports**: admin branch/own filters + live updates | build | M |
| E | Land #215 (readable status + real approve reason); retire #212 | cleanup | XS |

**Recommended order:** E → A (packaging, fast visual win) → **B (the selling point)** → D → C.

---

## Part A — Premala dashboard packaging (hide/move only)

All of this is **per-client presentation.** Gate behind a config flag (extend the existing
`CAP_*` capability system / `deps.config`), so the code path stays and other clients keep it.

### A1. Remove the Payments page (both roles)
- **Where:** nav registration (`public/js/components/nav.js` / wherever the business nav array is)
  + `public/js/components/payments.js`.
- **Action:** stop mounting the Payments section for Premala (flag: e.g. `CAP_PAYMENTS_PAGE=false`).
- **Knock-on:** Payments currently hosts three things that disappear with it —
  1. the Pending/Paid **mark-paid** workflow (Premala doesn't use it → fine to drop),
  2. the **Send-to-Admin** branch-submission button → **RESOLVED: drop it.** Owner confirmed
     (2026-07-13) clerks hand off by **exporting their branch PDF and sending it manually** — no
     in-app handoff needed. Keep the submission code/route (`routes/submissions`) documented, flagged
     off, for other clients.
  3. the **Petty Cash Statement export** buttons → **relocated in A2, do not lose these.**
- **Note:** PR #212 (hide clerk branch-filter on Payments) becomes moot once the page is gone — close it.

### A2. Move the Petty Cash Statement export into Manage → Data editor
- **Where:** `public/js/components/grid.js` toolbar (already has *Export CSV / Export Excel /
  Export PDF (with receipts) / Export template*). Add **Statement Excel** + **Statement PDF**.
- **Wire to:** the existing `GET /api/statement?period=<YYYY-MM>&format=xlsx|pdf&branch=<id|all>`
  (`routes/statement.js`) — unchanged server-side. This already produces the client-faithful
  BUMI-ERA-style statement with receipt evidence pages.
- **Scope rules (reuse existing):** clerk → own branch (server hard-forces it); admin → month +
  branch picker (or `all`). A month picker is required (statement is month-scoped).
- **Keep** the existing raw CSV/Excel/PDF exports too (they're the data-dump, different purpose).

### A3. Remove the Template (field/column) editor
- **Where:** `public/js/components/manage.js` (`subPagesFor` / `defaultSubPage`) +
  `public/js/components/templates.js`.
- **Action:** drop the **Template/columns** sub-page from Manage for Premala (flag it off). The
  Data editor stays the default (already is, per PR #199).
- **Keep** `templates.js`, `routes/templates.js`, `lib/templates.js` intact + documented.

### A4. Keep Category management (chart of accounts) — DO NOT remove  *(RESOLVED 2026-07-13)*
- The Owner explicitly wants the client to add categories themselves without contacting us.
- **Where it lives now:** `templates.js` "Category list (chart of accounts)" section →
  `saveCategories()` (`lib/templates.js`) → `POST /api/templates` with `{categories}` only.
- **Action (Owner-confirmed):** the Manage **Category tab shows ONLY the Category list (chart of
  accounts)** — nothing else. The column/field template builder is removed from Premala's view
  (A3). Premala is template-focused; keep the builder code for other clients. This category-list
  editor is the client's "one editing freedom." See **Part C** for the flow-through guarantee.

### A5. Companies — REMOVE the Companies/Add-company UI (Premala = single company)  *(RESOLVED 2026-07-13)*
- **Owner-confirmed:** Premala is **one company** for now. **Remove the "Add company" / Companies
  section** from the dashboard (`public/js/components/team.js` — `renderAddCompany` + the companies
  strip; feature-flag it off, don't delete the code — keep for multi-company clients).
- **Statement header:** set the company name via **`STATEMENT_COMPANY_NAME` env**, value taken from
  the client's sample template header — **`BUMI ERA NEW CONSTRUCTION (M) SDN BHD`** ("the empty
  sample template I gave has BumiEra in it, just follow that"). Set the branch's currency default to
  MYR (already the account default). `routes/statement.js` already falls back to
  `STATEMENT_COMPANY_NAME` when a branch has no `company_id`, so no code change needed there — just
  the env value.  *(Confirm the exact registered-name spelling against the sample PDF before setting.)*
- **What we lose by hiding it:** company-level *grouping* in Reports (`GROUP_FIELD.company`) — not
  needed for a single-company client; branch grouping (Part D) covers Premala's needs.
- **Cleanup:** delete the stray `asdad (MYR)` test company row from the live DB.

---

## Part B — Line-item category splitting ⭐ (the selling point)

**Goal:** a single receipt with mixed categories (e.g. RM50 Food + RM30 Petrol) must total
RM50 → Food and RM30 → Petrol in the statement/reports, **not** RM80 → one category.

### B0. Current state (important — most of this is already built)
- `expenses.line_items jsonb` (schema.sql:26) **already persists** each item:
  `{description, amount, category, source, confidence, flagged}`.
- `lib/ocr.js assembleExpense` already populates it: OCR reads `line_items`, `lib/categorize.js
  categorizeLineItems()` categorizes each item, amounts are **fx-scaled so items sum to the stored
  total** (see the `scale`/`round2` block ~ocr.js:440-460).
- What's WRONG: the expense also stores a single rolled-up `category` (`rollup()` = dominant by
  amount), and **every downstream total groups by that single `category` + full `amount`**, ignoring
  the per-item breakdown. **B is an aggregation-layer fix, not a data-model change. No migration.**

### B1. Statement — distribute per line item  *(owner: Jeevan — `lib/statement.js`)*
- In Section B (expenses grouped by category set), when `expense.line_items` is non-empty **and**
  items carry per-item `category`, add **each item's amount to ITS category's subtotal** instead of
  the whole `expense.amount` to `expense.category`.
- **Fallback (must preserve):** an expense with empty `line_items` (or items lacking `category`)
  behaves EXACTLY as today — whole amount → single `category`. Single-category receipts unchanged.
- **Row rendering:** a mixed receipt now appears as a line under each category it touches; show the
  `voucher_no` on each split line (optionally suffixed, e.g. `RC-2026-0074 (1/2)`) so the auditor
  can see it's one physical receipt split across categories.
- **Reconciliation guard:** items should sum to `expense.amount` (they're fx-scaled to). If a
  rounding remainder exists, attribute it to the largest item's category (document the rule).

### B2. Reports — same distribution  *(owner: Jeevan — `lib/reports.js`)*
- Category breakdowns/totals (`GROUP_FIELD.category` path) must sum per line-item category when
  present, same fallback as B1. Branch/staff/company grouping unaffected (those key off the
  expense row, not the item).

### B3. Exports reflect the split  *(owner: Jeevan — `lib/statementXlsx.js`, `lib/statementPdf.js`, `lib/excel.js`)*
- Category groupings + subtotals in xlsx/pdf mirror B1. The **receipt image/evidence page still
  appears once per physical receipt** (one photo), but its annotation lists each category portion.

### B4. Dashboard display — surface the in-line categorization  *(owner: Mugi/Jeevan — `activity.js`, `grid.js`)*
- **Owner-confirmed (2026-07-13): explicitly wanted** ("just for now show that we have in-line
  categorisation"). A mixed receipt's category cell reads e.g. `Mixed (2)`; the detail **drawer**
  lists the per-item breakdown (description · amount · category) — data already on the row
  (`line_items`). This is the visible proof of the feature; do it alongside B1-B3, not after.

### B5. Tests (TDD — write first)
- Statement + reports totals for: a 2-category receipt (RM50/RM30) → two subtotals; a 3-category
  receipt; a single-category receipt (unchanged); an empty-`line_items` receipt (unchanged);
  fx-scaled items summing to a converted total; a rounding-remainder case; an item with no
  `category` (→ falls back to the expense rollup / Others — pick + document).

### B6. Edge cases — RESOLVED (2026-07-13)
- **Item `category` IS in the template set** → split it into that category (Owner: "if it follows
  the templates category then add categorise it accordingly").
- **Item `category` NOT in the template set** (or missing) → attribute that item's amount to the
  **expense's rolled-up `category`** (fallback), so the receipt total is never lost/altered — it
  just isn't split for the off-template portion. Document this in the statement code.
- **Items don't sum to total** (bad OCR) → attribute the rounding remainder to the largest item's
  category (B1).
- **Per-item manual editing:** OUT of scope for now. Whole-receipt `Edit category` (dashboard + bot)
  stays as-is; the split is driven by OCR/categorizer output. Per-item override = later iteration.

---

## Part C — Category flow-through (verify + polish)

**Confirmed today** by code trace: adding a category via the Category list editor updates the live
set (`saveCategories`), which propagates to:
- the **receipt category dropdown** (dashboard reads `/api/config` `categories`),
- the **Telegram bot** category picker,
- the **Petty Cash Statement** Section B grouping — categories are numbered **in list order** and
  each gets its own subtotal, and long names are single-line/aligned via `fitToWidth` (PR #201).

So "add *Business Expenses* below *Touch n Go*" **will** appear, aligned, in the dropdowns, the bot,
and the statement — not "look like crap." **Owner-confirmed (2026-07-13): this is the required
behaviour — the BUMI ERA statement template must absorb a newly added category exactly this way.**
**Polish/verify items:**
- **Empty new category** (added but no expenses yet): **RESOLVED — omit** sections with zero
  expenses to keep the statement clean; verify/implement in `lib/statement.js`.
- **Reorder** respected (list order = statement order) — already true, keep.
- **Delete a category that still has expenses** → guard with a warning (don't silently orphan rows).

---

## Part D — Overview + Reports: filters + live updates (admin analysis)

### D1. Admin-only filters
- **Overview** (`public/js/components/overview.js`) + **Reports** (`public/js/components/reports.js`):
  add a **branch** picker + a **"My uploads"** option (= the admin's own branch / Head Office
  `branch_id`) + **All**. Server grouping already supports branch (`lib/reports.js`).
- **Clerk:** no filter UI — locked to their own branch (server already hard-scopes). Same pattern as
  the Payments fix (`isAdmin` guard).

### D2. Live updates
- Overview + Reports auto-refresh: **poll on an interval (~20–30s) + refetch on tab
  `visibilitychange`/focus.** No websockets (keep the zero-build, 2-runtime-dep rule). Debounce so a
  filter change doesn't double-fetch. Pause polling when the tab is hidden.

---

## Part E — In flight
- **PR #215** — readable "Need Review" + surfaces the real Approve/Reject reason (the staff-first
  valve message). Ready, CI green → merge.
- **PR #212** — clerk branch-filter on Payments → **close** (Payments is being removed, A1).

---

## Ownership map (collision rule — edit only your files)
- **Barat:** `lib/ocr.js`, `lib/categorize.js` (line-item extraction — already done; B only needs
  light confirmation here), `lib/templates.js`, `schema.sql` (no migration expected for B),
  `routes/webhook`, `routes/templates`.
- **Jeevan:** `lib/statement.js`, `lib/statementPdf.js`, `lib/statementXlsx.js`, `lib/reports.js`,
  `lib/excel.js`, `routes/{statement,manageExport,reports,expenses}`, config/flags.
- **Mugi/Jeevan:** `public/js/components/{nav,payments,manage,templates,team,grid,activity,overview,reports}.js`.

## Guardrails (repo conventions — keep)
- `.env` move-aside before `node --test` (restore after). Full suite green before every PR.
- Branch → PR → **Owner names the merge** (never self-merge). CI must pass.
- No feature deletes — hide behind a flag + document (ADR-020). Don't touch `docs/STATUS.md` M2
  sprint section (known-stale).

## Open decisions for the Owner — ALL RESOLVED (2026-07-13)
1. ~~Companies one vs several~~ — ✅ RESOLVED: **one company.** Remove the Companies/Add-company UI;
   set the statement header via `STATEMENT_COMPANY_NAME=BUMI ERA NEW CONSTRUCTION (M) SDN BHD` (per
   the sample template). (A5)
2. ~~Clerk → Admin handoff~~ — ✅ RESOLVED: no in-app handoff; clerks export their branch PDF and
   send it manually. Drop Send-to-Admin (keep code flagged off). (A1)
3. ~~Mixed-receipt display~~ — ✅ RESOLVED: show `voucher_no` on each split category line
   (`(1/2)` suffix); off-template item portions fall back to the receipt's rolled-up category so the
   total is preserved; rounding remainder → largest item's category. (B1/B6)
4. ~~Empty category sections~~ — ✅ RESOLVED: omit zero-expense sections from the statement. (C)

**→ Plan is FINAL. Ready for Barat to execute in the sequence in §0.**
