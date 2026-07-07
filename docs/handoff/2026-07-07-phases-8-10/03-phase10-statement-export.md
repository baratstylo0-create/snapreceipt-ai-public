# Phase 10 — Petty Cash Monthly Statement: dual Excel/PDF export

> ADR-023 + ADR-024. The client-facing deliverable: one statement per company × branch × month,
> **both** `.xlsx` and `.pdf`, faithful to the client sample. Spec
> `docs/specs/2026-07-06-petty-cash-statement-format.md` is the contract — §2 layout, §2b styling,
> §3 architecture, §6 sign rules. Branch: `feature/jeevan-m2-statement` (after Phase 9 merges).
> **The one approved new dependency: `npm install pdfkit`** (ADR-024; pure-JS). Nothing else.

## Architecture (frozen, spec §3): one model, two renderers

```
lib/statement.js      buildStatementModel({company, branch, period, ...data}) -> StatementModel   (PURE)
lib/statementXlsx.js  statementToWorkbook(model, opts) -> ExcelJS.Workbook
lib/statementPdf.js   statementToPdf(model, {receipts}) -> Buffer (statement pages + receipt pages)
routes/statement.js   GET /api/statement?branch=&period=&format=xlsx|pdf   (scoped, flag-gated)
```

## Task 10.1 — `lib/statement.js` (pure model builder, TDD first)

StatementModel (build exactly this; both renderers consume it):

```js
{
  companyName, title: 'PETTY CASH MONTHLY STATEMENT OF ACCOUNT',
  periodLabel,            // 'OCTOBER 2025' style, from 'YYYY-MM'
  branchLabel, preparedBy,
  sectionA: { rows: [{ date, description, amount, amount2? }], total, total2? },  // 2nd currency optional
  sectionB: {
    categories: [{ n, name, rows: [{ i, date, staffName?, description, amount, expenseId }],
                   subtotal, padRows }],   // padRows: blank rows for visual fidelity (default 2)
    subtotal,
  },
  footer: { cashInHand, expenditure, balance },   // balance = cashInHand - expenditure (SIGN RULE §6)
  claims: { ids, total },                          // from lib/pettyCash (Phase 9)
  signoff: { prepared: true, checked: cfgurable, approved: true },  // show/hide per company
  showStaffColumn: bool, currency, currency2?,
}
```

Rules: categories come from the **company's FieldSpec categories** (via `template_id` →
`lib/templates.js getFieldSpec`; fall back to `lib/categorize.js CATEGORIES`); every expense lands
in its category (unknown → 'Others'); category blocks are numbered 1..N in FieldSpec order; empty
categories still render (with padRows) — the sample shows empty FOOD/HARDWARE blocks; totals via
the same cents-rounding as `lib/excel.js`. Data in via arguments only — NO I/O in this file.

Tests (≥ 8): totals + **balance sign (+75.09 case again at model level)**; category grouping +
numbering; empty category present; unknown category → Others; staff column toggle; 2nd currency
rows; claims passthrough; deterministic ordering.

## Task 10.2 — `lib/statementXlsx.js` (exceljs renderer)

Reproduce the §2b styling contract. The essentials (all via exceljs cell `font`/`fill`/`border`/
`alignment` — reuse the fill/border idioms already in `lib/excel.js`'s Summary sheet):

- Company name: bold serif ~16pt, **red** (`FFCC0000`-ish), centred, merged across the table width.
  Title + period: bold black, centred, merged.
- Section headings ("A.  SUMMARY OF CASH IN", "B.  SUMMARY OF EXPENSES: (BRANCH)"): **blue, italic,
  underlined**, left-aligned.
- Header rows (DATE/DESCRIPTION/AMOUNT…, ITEM/DATE/NAME/DESCRIPTION/T. AMOUNT): grey fill
  (`FFE8E8E8`), bold, thin black borders. Full thin-border grid over the whole statement body.
- Category banner rows: grey fill, bold, item number in its own bordered cell at the left.
- Per-category TOTAL cell: **yellow fill** (`FFFFFF00`). Statement SUBTOTAL: **green fill**
  (`FF92D050`-ish). Money format `#,##0.00`.
- Footer block (A. TOTAL CASH IN-HAND / B. TOTAL EXPENDITURE / BALANCE), boxed, right-of-centre;
  **negative balance in red font** (ours will only be negative on a genuine claim month).
- Sign-off block per model.signoff: "PREPARED BY :" / "CHECKED BY :" / "APPROVED BY:" + "DATE :"
  lines, spaced like the sample (merged cells, no borders).
- padRows render as empty bordered rows inside each category block.
- **Real formulas welcome but computed values REQUIRED** — never emit `#REF!`; the model's numbers
  are the truth (write value; adding SUBTOTAL() formulas on top is optional polish).
- Receipt thumbnails: reuse the existing embed machinery style from `lib/excel.js` (`addImage`,
  row-height bump, links-only fallback past `EXCEL_EMBED_LIMIT`) — accept the same
  `opts.receipts`/`opts.receiptLinks` maps.

Tests: cell VALUES + fills/fonts asserted programmatically (exceljs lets you read
`cell.fill.fgColor.argb`, `cell.font.color/bold/italic/underline`) for: red title, blue headings,
yellow category total, green subtotal, red negative balance (feed a negative-balance model),
borders on the header row, correct totals in the right cells, sign-off rows present/absent per
config. No pixel testing — the Owner does the final visual diff.

## Task 10.3 — `lib/statementPdf.js` (pdfkit renderer + receipt pages)

- Page 1..n: draw the statement to match §2b — pdfkit `rect().fill()` for banner/total fills,
  `font('Helvetica-Bold')`/`fillColor()` for the red/blue/bold text, `lineWidth(0.5)` grid strokes.
  A4 portrait. Paginate section B if it overflows (repeat the ITEM/DATE/… header on the new page).
- Then the receipts, **in statement-line order** (spec §3): image (`png/jpg`) → one page,
  **fit-inside-page, aspect preserved, top-aligned, centred horizontally**; a PDF receipt →
  rasterise EVERY page via `@hyzyla/pdfium` (already a dep — see `lib/pdf.js` for the existing
  render helper + the `PDF_MAX_RENDER_PIXELS` guard; REUSE it, don't re-wrap pdfium) → one page per
  page. Missing/unreadable receipt → skip it, count it, continue (never fail the statement).
- Return `{ buffer, pages, skippedReceipts }`.

Tests: output starts with `%PDF-`; page count = statement pages + Σ receipt pages (parse with
pdfium or assert via pdfkit's internal page count); multi-page PDF receipt expands; missing
receipt skipped + counted; no receipts ⇒ statement-only document; NO PII in logs.

## Task 10.4 — `routes/statement.js` (mount in `server.js`, announce)

- Gate: 404 unless `multiUser` AND `pettyCash`. Limiter `STATEMENT_RATE_MAX` default 30 (exports
  are heavy). `GET /api/statement?branch=<id>&period=YYYY-MM&format=xlsx|pdf`.
- Admin: any branch. Clerk: forced to own branch (same pattern as `/api/petty-cash`). Validate
  period + format (400 otherwise).
- Assemble: floats/cash-in/claims via `lib/pettyCash`, expenses via `sbSelect` (period-filtered,
  branch-scoped, not deleted), company + FieldSpec, staff/branch name maps (as `routes/excel.js`
  does), receipt bytes via `lib/storage.fetchReceiptObject` for rows with `receipt_url` (embed cap
  like `routes/excel.js`). Content-Type: xlsx →
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, pdf → `application/pdf`;
  `Content-Disposition: attachment; filename="petty-cash-<branch>-<period>.<ext>"` (filename built
  ONLY from validated tokens — same rule as `routes/excel.js`).

Tests: both formats emit with correct content-type + magic bytes (`PK` / `%PDF-`); clerk scope
forced; flag off 404; bad params 400.

## Done when

- Suite green (expect ≈ +25 tests), `pdfkit` added to `package.json` (commit the lockfile),
  flag-off byte-for-byte.
- Commit: `feat(m2): Phase 10 — Petty Cash Monthly Statement, dual xlsx/pdf export (pdfkit) with appended receipts`.
- PR: cite ADR-023/024, list "Owner visual diff vs client sample" as the explicit final acceptance
  step, and remind that Groq ZDR + migrations + `setup-admin` remain the pre-live ops gates.
