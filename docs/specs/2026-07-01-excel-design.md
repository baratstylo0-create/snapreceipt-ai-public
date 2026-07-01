# Spec — #2 Excel export

> Status: approved (brainstorm 2026-07-01). Owner: Jeevan. Branch: `feature/jeevan-p4-excel`.
> Frozen interface (ARCHITECTURE §3): `lib/excel.js` exports `exportExcel()` (buildWorkbook internally).
> Consumes `getFieldSpec()` (Barat, `lib/templates.js` — frozen, read-only) and `sbSelect()` (Barat, `lib/supabase.js`).

## Goal
Export the account's expenses as a real `.xlsx` file whose columns match the customer's FieldSpec
exactly (header labels + order), so the file opens as a normal, correctly-typed Excel workbook —
not a CSV renamed to `.xlsx`.

## New dependency (Tier-2 — SOP §4.7)
Adds `exceljs` (pure JS, no native bindings, MIT) to `package.json`. This is the one deviation from
the "only express+dotenv" rule (CLAUDE.md), justified because a genuine binary `.xlsx` (real cell
types, not just comma-separated text) cannot be produced without a library, and hand-rolling OOXML
is a worse security/maintenance trade for a money-facing export. Recorded as **ADR-012** in
`docs/DECISIONS.md`. New-dependency PRs are Tier-2 → independent QA pass before merge, same as the
money-math / untrusted-input work already landed this session.

## `lib/excel.js`
`buildWorkbook(expenses, fieldSpec) -> ExcelJS.Workbook` — pure, I/O-free (like `buildReport`), so
fully unit-testable without touching Supabase or the filesystem.

- One worksheet. Header row = `fieldSpec.columns[].label`, in FieldSpec order (the frozen contract:
  Excel emits columns in `label` order per ARCHITECTURE §3.1).
- Per expense row, per column, value resolution by `column.key`:
  - **Canonical keys with a dedicated DB column** (`merchant`, `expense_date`, `amount`, `currency`,
    `category`, `subtotal`, `tax`, `remark`) → read directly off the expense row.
  - **Any other key** (a customer's own CSV header that isn't one of the above — including the
    canonical-but-not-a-column `quantity`) → read from `expense.ai_raw[key]` (the raw extracted
    object stored at OCR time, per the existing WORKLOG assumption from #4/#12). Absent → blank.
  - Never throws on a missing/malformed value — blank cell instead (an export must never 500 on
    one bad row).
- Type-aware cell values so Excel treats them as real data, not strings:
  - `type: "currency"` or `"number"` → numeric cell (via the same strict `toAmount()`-style coercion
    used in #8's fix — non-numeric garbage becomes a blank cell, not a fabricated `0`/`1`).
  - `type: "date"` → the ISO string as-is (matches `expense_date` staying TEXT elsewhere; no attempt
    to coerce into an Excel date serial, to avoid timezone/format surprises).
  - `type: "text"` / `"category"` → string, capped defensively at a reasonable length so a
    pathological `ai_raw` value can't blow up cell size.

## `routes/excel.js`
`GET /api/excel?from=&to=` — `checkDash` gate (same as reports/templates).

- Reuses the exact `from`/`to` ISO validation and row-fetch filter as `routes/reports.js`:
  `deleted_at is null` AND `status=neq.rejected` (a rejected expense from #5's review queue must
  never appear in an exported ledger, matching the rule just applied to reports totals).
- Row cap: same `REPORT_ROW_LIMIT` constant/pattern as reports. Since the response is a binary file
  (no JSON body to carry a `truncated` flag), truncation is signaled via response header
  `X-Truncated: true` when the fetch hit the cap.
- Calls `getFieldSpec()` (frozen contract) once, then `buildWorkbook(rows, fieldSpec)`, serializes
  via `workbook.xlsx.writeBuffer()`, and responds with:
  - `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `Content-Disposition: attachment; filename="expenses-<from|all>-<to|today>.xlsx"` (filename
    built from validated ISO date strings only — never raw query input — to avoid a header-injection
    vector).
- Fails safe like every other route this session: DB error → `502 { error }` JSON, no stack trace.

## Testing (TDD, no network)
- `lib/excel.js`: column order matches FieldSpec; canonical-column resolution; `ai_raw` fallback
  resolution (including `quantity`); missing/malformed value → blank, never a throw; numeric coercion
  matches #8's `toAmount()` behavior (garbage/Infinity → blank, not fake money); a custom FieldSpec
  with unknown headers renders those columns correctly. Assert on the generated workbook via
  ExcelJS's own reader (read the buffer back and inspect cells), not just byte-length.
- `routes/excel.js` (mirroring `tests/reports.route.test.js`): normal export returns a valid
  `.xlsx` buffer with correct headers; truncation header set at the row cap; `status=neq.rejected`
  filter present in the query; `from`/`to` validation matches reports; DB error → 502, no leak.

## Out of scope
Business-account Excel template (parked, personal M1 first per SOP), scheduled/emailed exports,
multi-sheet workbooks (e.g. per-category tabs), a "download" button in the dashboard UI (Mugi, #3 —
this PR only ships the API).
