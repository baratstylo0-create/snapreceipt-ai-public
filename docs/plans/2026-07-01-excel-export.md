# #2 Excel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/excel?from=&to=` — a real, downloadable `.xlsx` file whose columns exactly match the account's FieldSpec, built from the same money/date/status rules already hardened in #8 reports.

**Architecture:** Mirrors the existing #8 reports split exactly: a pure, I/O-free `lib/excel.js` (`buildWorkbook(expenses, fieldSpec) -> ExcelJS.Workbook`, fully unit-testable with no network/DB) plus a thin `routes/excel.js` (HTTP glue — fetch, filter, serialize, stream). Reuses `lib/reports.js`'s already-hardened `toAmount()` (strict numeric coercion) and `isISO()` (strict calendar-date validation) instead of reimplementing them.

**Tech Stack:** Node 22, Express, `exceljs` (new dependency — ADR-012), `node:test` + `node:assert`, no network in tests (Supabase stubbed by replacing `sbSelect` on the shared module object, same pattern as `tests/reports.route.test.js`).

Full design context: `docs/specs/2026-07-01-excel-design.md`. Frozen contracts consumed (read-only, do not modify): `getFieldSpec()` in `lib/templates.js`, `sbSelect()` in `lib/supabase.js`, `checkDash` in `routes/expenses.js`.

---

## Task 1: Add the `exceljs` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Edit `package.json`'s `"dependencies"` block to:

```json
  "dependencies": {
    "dotenv": "^16.4.5",
    "exceljs": "^4.4.0",
    "express": "^4.19.2"
  }
```

- [ ] **Step 2: Install and verify the lockfile updates**

Run: `npm install`
Expected: installs cleanly, `package-lock.json` gains an `exceljs` entry, no errors.

- [ ] **Step 3: Verify existing suite is still green before touching any code**

Run: `npm test`
Expected: `# pass 127`, `# fail 0` (baseline unchanged — this step only added a dependency).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(#2): add exceljs dependency (ADR-012)"
```

---

## Task 2: Widen `lib/reports.js`'s exports (no logic change)

**Why:** `toAmount()` (strict numeric coercion — rejects booleans/arrays/Infinity, the exact bug QA found in #8) and `isISO()` (strict calendar-date validation — rejects `2026-13-45`) already exist in `lib/reports.js` but are private. Excel needs the identical rules; duplicating them would let the two features silently drift apart. This task only widens the export surface — zero behavior change to `buildReport`.

**Files:**
- Modify: `lib/reports.js:74` (the `module.exports` line)
- Test: `tests/reports.test.js`

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/reports.test.js`:

```js
test('toAmount and isISO are exported for reuse by lib/excel.js (#2)', () => {
  const { toAmount, isISO } = require('../lib/reports');
  assert.strictEqual(typeof toAmount, 'function');
  assert.strictEqual(typeof isISO, 'function');
  assert.strictEqual(toAmount('12.50'), 12.5);
  assert.strictEqual(toAmount(true), null);
  assert.strictEqual(toAmount(Infinity), null);
  assert.strictEqual(isISO('2026-07-01'), true);
  assert.strictEqual(isISO('2026-13-45'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reports.test.js`
Expected: FAIL — `toAmount is not a function` (or `undefined`), because `module.exports` currently only has `buildReport`.

- [ ] **Step 3: Widen the export**

In `lib/reports.js`, change the last line (currently `module.exports = { buildReport };`) to:

```js
module.exports = { buildReport, toAmount, isISO };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reports.test.js`
Expected: `# tests 23`, `# pass 23`, `# fail 0` (this file currently has 22 tests; the new one makes 23).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: `# pass 128`, `# fail 0` (127 + 1 new test).

- [ ] **Step 6: Commit**

```bash
git add lib/reports.js tests/reports.test.js
git commit -m "refactor(#8): export toAmount + isISO for reuse by #2 Excel export"
```

---

## Task 3: `lib/excel.js` — the pure workbook builder

**Files:**
- Create: `lib/excel.js`
- Test: `tests/excel.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/excel.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildWorkbook } = require('../lib/excel');

const FIELD_SPEC = {
  columns: [
    { key: 'merchant', label: 'Vendor', type: 'text', required: true },
    { key: 'expense_date', label: 'Date', type: 'date', required: true },
    { key: 'amount', label: 'Total', type: 'currency', required: true },
    { key: 'quantity', label: 'Qty', type: 'number', required: false },
  ],
};

// ExcelJS row.values is 1-indexed (index 0 is always null); drop it for readable assertions.
function headerRow(workbook) { return workbook.worksheets[0].getRow(1).values.slice(1); }
function dataRow(workbook, n) { return workbook.worksheets[0].getRow(n + 1).values.slice(1); }

test('header row matches FieldSpec labels, in FieldSpec order', () => {
  const wb = buildWorkbook([], FIELD_SPEC);
  assert.deepStrictEqual(headerRow(wb), ['Vendor', 'Date', 'Total', 'Qty']);
});

test('canonical columns (with a dedicated expenses table column) read straight off the row', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', expense_date: '2026-07-01', amount: 12.5 }], FIELD_SPEC);
  assert.deepStrictEqual(dataRow(wb, 1), ['Cafe', '2026-07-01', 12.5, null]);
});

test('quantity (canonical key, but no dedicated DB column) resolves from ai_raw', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 5, ai_raw: { quantity: 3 } }], FIELD_SPEC);
  assert.strictEqual(dataRow(wb, 1)[3], 3);
});

test('a custom (non-canonical) FieldSpec key resolves from ai_raw', () => {
  const spec = { columns: [{ key: 'po_number', label: 'PO #', type: 'text', required: false }] };
  const wb = buildWorkbook([{ ai_raw: { po_number: 'PO-42' } }], spec);
  assert.strictEqual(dataRow(wb, 1)[0], 'PO-42');
});

test('missing value -> blank cell, not a crash', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe' }], FIELD_SPEC);
  const row = dataRow(wb, 1);
  assert.strictEqual(row[2], null); // amount missing
  assert.strictEqual(row[3], null); // quantity missing (no ai_raw at all)
});

test('garbage (non-numeric) amount becomes a blank cell, not fake money', () => {
  // Same rule as #8's toAmount() fix: Number(true)===1 must NOT become $1.
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: true }], FIELD_SPEC);
  assert.strictEqual(dataRow(wb, 1)[2], null);
});

test('Infinity amount becomes a blank cell, never poisons the workbook', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: Infinity }], FIELD_SPEC);
  assert.strictEqual(dataRow(wb, 1)[2], null);
});

test('numeric string amount is coerced to a real numeric cell (Excel can sum it)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: '12.50' }], FIELD_SPEC);
  const cell = dataRow(wb, 1)[2];
  assert.strictEqual(cell, 12.5);
  assert.strictEqual(typeof cell, 'number');
});

test('null/undefined entries in the expenses array are skipped, not crashed', () => {
  const wb = buildWorkbook([null, undefined, { merchant: 'Cafe', amount: 1 }], FIELD_SPEC);
  assert.strictEqual(wb.worksheets[0].rowCount, 2); // header + 1 real data row
});

test('an overlong text value is capped at 500 chars, not left unbounded', () => {
  const spec = { columns: [{ key: 'remark', label: 'Notes', type: 'text', required: false }] };
  const wb = buildWorkbook([{ remark: 'x'.repeat(2000) }], spec);
  assert.strictEqual(dataRow(wb, 1)[0].length, 500);
});

test('empty expenses array -> header only, no data rows', () => {
  const wb = buildWorkbook([], FIELD_SPEC);
  assert.strictEqual(wb.worksheets[0].rowCount, 1);
});

test('a FieldSpec with no columns produces a workbook with only a header row of nothing', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe' }], { columns: [] });
  assert.strictEqual(wb.worksheets.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/excel.test.js`
Expected: FAIL — `Cannot find module '../lib/excel'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/excel.js`:

```js
'use strict';
// #2 Excel export — turns expenses into a real .xlsx workbook matching the
// customer's FieldSpec exactly (ARCHITECTURE §2). Pure + I/O-free (like
// lib/reports.js's buildReport) so it's fully unit-testable without touching
// Supabase or the filesystem; the route (routes/excel.js) supplies rows.
//
// buildWorkbook(expenses, fieldSpec) -> ExcelJS.Workbook
//   One worksheet. Header row = fieldSpec.columns[].label, in FieldSpec order
//   (the frozen contract: Excel emits columns in `label` order, ARCHITECTURE §3.1).
//   Canonical columns with a dedicated `expenses` table column (merchant,
//   expense_date, amount, currency, category, subtotal, tax, remark) read
//   straight off the row; any other FieldSpec key (a customer's own CSV
//   header, or the canonical-but-columnless "quantity") reads from
//   expense.ai_raw[key] instead (the raw OCR-extracted object, per the
//   existing #4/#12 convention). Never throws on a missing/malformed value —
//   blank cell instead, so one bad row can't fail the whole export.

const ExcelJS = require('exceljs');
const { toAmount } = require('./reports');

const DIRECT_KEYS = new Set([
  'merchant', 'expense_date', 'amount', 'currency', 'category', 'subtotal', 'tax', 'remark',
]);
const MAX_TEXT_LEN = 500;

function resolveRawValue(expense, key) {
  if (DIRECT_KEYS.has(key)) return expense[key];
  return (expense.ai_raw && typeof expense.ai_raw === 'object') ? expense.ai_raw[key] : undefined;
}

function cellValue(expense, column) {
  const raw = resolveRawValue(expense, column.key);
  if (raw === undefined || raw === null) return null;
  if (column.type === 'currency' || column.type === 'number') {
    return toAmount(raw); // strict coercion (same rule as #8) -> garbage/Infinity becomes null (blank cell)
  }
  return String(raw).slice(0, MAX_TEXT_LEN);
}

function buildWorkbook(expenses, fieldSpec) {
  const columns = (fieldSpec && Array.isArray(fieldSpec.columns)) ? fieldSpec.columns : [];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 18 }));

  for (const expense of (Array.isArray(expenses) ? expenses : [])) {
    if (!expense) continue;
    const row = {};
    for (const column of columns) row[column.key] = cellValue(expense, column);
    sheet.addRow(row);
  }
  return workbook;
}

module.exports = { buildWorkbook };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/excel.test.js`
Expected: all 12 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `# pass 140`, `# fail 0` (128 + 12 new).

- [ ] **Step 6: Commit**

```bash
git add lib/excel.js tests/excel.test.js
git commit -m "feat(#2): lib/excel.js — pure FieldSpec-driven workbook builder"
```

---

## Task 4: `routes/excel.js` — the HTTP endpoint

**Files:**
- Create: `routes/excel.js`
- Test: `tests/excel.route.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/excel.route.test.js` (mirrors `tests/reports.route.test.js`'s structure):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');     // shared module object — stub its sbSelect
const templates = require('../lib/templates');   // shared module object — stub its getFieldSpec
const mountExcel = require('../routes/excel');
const { EXCEL_ROW_LIMIT } = mountExcel;

async function callExcel(query = '') {
  const app = express();
  mountExcel(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/excel' + query);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf };
  } finally { server.close(); }
}

const FIELD_SPEC = { columns: [
  { key: 'merchant', label: 'Vendor', type: 'text', required: true },
  { key: 'amount', label: 'Total', type: 'currency', required: true },
] };

test('route: excludes rejected expenses from the query (status=neq.rejected)', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  let capturedOpts;
  supabase.sbSelect = async (table, opts) => { capturedOpts = opts; return []; };
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    await callExcel();
    assert.match(capturedOpts.extra, /status=neq\.rejected/);
    assert.match(capturedOpts.extra, /deleted_at=is\.null/);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: returns a real, parseable .xlsx with the right headers and rows', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([
    { merchant: 'Cafe', amount: 12.5, expense_date: '2026-06-01', status: 'saved', deleted_at: null },
    { merchant: 'Fuel', amount: 40, expense_date: '2026-06-15', status: 'saved', deleted_at: null },
  ]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { status, headers, buf } = await callExcel('?period=month');
    assert.strictEqual(status, 200);
    assert.strictEqual(headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(headers.get('content-disposition'), /attachment; filename="expenses-.*\.xlsx"/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    assert.deepStrictEqual(sheet.getRow(1).values.slice(1), ['Vendor', 'Total']);
    assert.deepStrictEqual(sheet.getRow(2).values.slice(1), ['Cafe', 12.5]);
    assert.deepStrictEqual(sheet.getRow(3).values.slice(1), ['Fuel', 40]);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: from/to filters rows by expense_date, inclusive on both ends', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([
    { merchant: 'A', amount: 1, expense_date: '2026-05-31' },
    { merchant: 'B', amount: 2, expense_date: '2026-06-01' },
    { merchant: 'C', amount: 3, expense_date: '2026-06-30' },
    { merchant: 'D', amount: 4, expense_date: '2026-07-01' },
  ]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { buf } = await callExcel('?from=2026-06-01&to=2026-06-30');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    assert.strictEqual(sheet.rowCount, 3); // header + B + C only
    assert.strictEqual(sheet.getRow(2).getCell(1).value, 'B');
    assert.strictEqual(sheet.getRow(3).getCell(1).value, 'C');
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: an impossible from/to date (2026-13-45) is ignored, not applied as a filter bound', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ merchant: 'A', amount: 1, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { buf } = await callExcel('?from=2026-13-45');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.strictEqual(wb.worksheets[0].rowCount, 2); // header + the one row (filter was ignored, not applied as "always excluded")
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: at the row limit -> X-Truncated header set (money export never silently undercounts)', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => Array.from({ length: EXCEL_ROW_LIMIT }, () => ({
    merchant: 'Cafe', amount: 1, expense_date: '2026-06-01',
  }));
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { headers } = await callExcel();
    assert.strictEqual(headers.get('x-truncated'), 'true');
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: below the row limit -> no X-Truncated header', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ merchant: 'Cafe', amount: 1, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { headers } = await callExcel();
    assert.strictEqual(headers.get('x-truncated'), null);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: DB error -> graceful 502 JSON, no crash, no internal leak', async () => {
  const origSelect = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('db down secret detail'); };
  try {
    const { status, headers, buf } = await callExcel();
    assert.strictEqual(status, 502);
    assert.match(headers.get('content-type'), /json/);
    const body = JSON.parse(buf.toString('utf8'));
    assert.deepStrictEqual(body, { error: 'export failed' });
    assert.ok(!buf.toString('utf8').includes('secret detail'), 'must not leak the real error message');
  } finally { supabase.sbSelect = origSelect; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/excel.route.test.js`
Expected: FAIL — `Cannot find module '../routes/excel'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `routes/excel.js`:

```js
'use strict';
// #2 Excel export — HTTP surface. OWNER: Jeevan.
//   GET /api/excel?from=&to=  -> a real .xlsx download of the account's expenses,
//                                columns driven by the customer's FieldSpec (#12).
// Mirrors routes/reports.js's fetch/filter/fail-safe pattern exactly; reuses its
// hardened toAmount()/isISO() (via lib/excel.js and lib/reports.js) instead of
// re-implementing money/date validation.

const supabase = require('../lib/supabase');       // namespace import so tests can stub sbSelect
const templates = require('../lib/templates');     // namespace import so tests can stub getFieldSpec
const { buildWorkbook } = require('../lib/excel');
const { isISO } = require('../lib/reports');
const { checkDash } = require('./expenses');       // reuse the same optional API gate

// Same cap philosophy as routes/reports.js's REPORT_ROW_LIMIT: never silently
// undercount a money export; signal truncation instead (via a header, since
// the response body here is a binary file, not JSON).
const EXCEL_ROW_LIMIT = 10000;

module.exports = function mountExcel(app) {
  app.get('/api/excel', checkDash, async (req, res) => {
    try {
      const from = isISO(req.query.from) ? String(req.query.from) : null;
      const to = isISO(req.query.to) ? String(req.query.to) : null;

      const rows = await supabase.sbSelect('expenses', {
        // status=neq.rejected: a rejected expense (#5 admin review queue) must
        // never appear in an exported ledger, matching the rule applied to #8.
        extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.desc', limit: EXCEL_ROW_LIMIT,
      });
      const truncated = rows.length >= EXCEL_ROW_LIMIT;

      const filtered = rows.filter((e) => {
        if (!e) return false;
        const date = String(e.expense_date || '');
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });

      const fieldSpec = await templates.getFieldSpec();
      const workbook = buildWorkbook(filtered, fieldSpec);
      const buf = await workbook.xlsx.writeBuffer();

      // Filenames are built ONLY from already-ISO-validated strings (or fixed
      // literals) -- never raw query input -- to avoid a header-injection vector.
      const filename = 'expenses-' + (from || 'all') + '-' + (to || new Date().toISOString().slice(0, 10)) + '.xlsx';

      res.set('Access-Control-Allow-Origin', '*');
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
      if (truncated) res.set('X-Truncated', 'true');
      res.send(buf);
    } catch (e) {
      console.error('[api/excel]', e.message);
      res.status(502).json({ error: 'export failed' });
    }
  });
};

module.exports.EXCEL_ROW_LIMIT = EXCEL_ROW_LIMIT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/excel.route.test.js`
Expected: all 7 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `# pass 147`, `# fail 0` (140 + 7 new).

- [ ] **Step 6: Commit**

```bash
git add routes/excel.js tests/excel.route.test.js
git commit -m "feat(#2): routes/excel.js — GET /api/excel download endpoint"
```

---

## Task 5: Wire into `server.js` + smoke test

**Files:**
- Modify: `server.js`
- Modify: `tests/smoke.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/smoke.test.js`, add `routes/excel` to the "all modules import without throwing" require list. The current line (post-#13-merge) is:

```js
    require('../routes/receipt'); require('../routes/reports'); require('../routes/templates'); require('../routes/misc');
```

Change it to:

```js
    require('../routes/receipt'); require('../routes/reports'); require('../routes/templates'); require('../routes/excel'); require('../routes/misc');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/smoke.test.js`
Expected: FAIL — `Cannot find module '../routes/excel'` is already created (Task 4), so actually this should already resolve. Instead expect this smoke test to currently PASS already once Task 4 lands — the real "fail" checkpoint here is that `server.js` hasn't mounted it, which the next step's manual check covers. Run it anyway to confirm no import-time throw: `node --test tests/smoke.test.js` should show all passing.

- [ ] **Step 3: Mount the route in `server.js`**

In `server.js`, add the require alongside the other route mounts (after `const mountTemplates = require('./routes/templates');`):

```js
const mountExcel = require('./routes/excel');
```

And mount it alongside the others (after `mountTemplates(app);`):

```js
mountExcel(app);
```

- [ ] **Step 4: Verify the full suite still passes**

Run: `npm test`
Expected: `# pass 147`, `# fail 0` (no new tests in this task, just wiring).

- [ ] **Step 5: Manual boot check**

Run: `node -e "require('./lib/config').assertConfig()" 2>&1 | head -5` to confirm config loads (if this errors on missing `.env`, that's expected/pre-existing and not caused by this change — skip to Step 6).

Then run: `node --test` one more time as the final gate.
Expected: `# pass 147`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/smoke.test.js
git commit -m "feat(#2): mount GET /api/excel in server.js"
```

---

## Task 6: Docs — WORKLOG + open PR

**Files:**
- Modify: `docs/WORKLOG.md`

- [ ] **Step 1: Add a WORKLOG entry**

Prepend (newest-first, right after the `---` divider near the top) to `docs/WORKLOG.md`:

```markdown
## 2026-07-01 · Claude-J2 (for Jeevan) · feature/jeevan-p4-excel (PR — #2 Excel export)
- **Files:** `lib/excel.js`, `routes/excel.js`, `tests/excel.test.js`, `tests/excel.route.test.js`, `lib/reports.js` (widened exports), `tests/reports.test.js`, `server.js`, `tests/smoke.test.js`, `package.json`, `docs/specs/2026-07-01-excel-design.md`, `docs/DECISIONS.md` (ADR-012).
- **What changed:** #2 Excel export. `GET /api/excel?from=&to=` streams a real `.xlsx` whose columns exactly match the account's FieldSpec (label + order, ARCHITECTURE §3.1). Canonical fields (merchant/expense_date/amount/currency/category/subtotal/tax/remark) read straight off the expense row; any other FieldSpec key (including the canonical-but-columnless `quantity`, or a customer's own custom CSV header) reads from `ai_raw`. Reuses #8's hardened `toAmount()` (rejects booleans/arrays/Infinity — never fabricates money) and `isISO()` (rejects impossible calendar dates) instead of re-implementing them; excludes `status='rejected'` and soft-deleted rows, same rule as reports. Truncation (row cap hit) signaled via an `X-Truncated` response header since the body is binary, not JSON. New dependency **`exceljs`** (ADR-012) — the first exception to the "two deps only" rule, since a genuine binary `.xlsx` can't be produced without one. **Tests: 147/147 pass** (20 new: 1 export-widening test on `lib/reports.js`, 12 on `lib/excel.js`, 7 on `routes/excel.js`).
- **What's next:** Tier-2 review (new third-party dependency, per SOP §4.7) → independent QA pass before merge, same bar as #8/#13. After merge: #9 dashboard agent, then #7 mass upload, then the ADR-011 reference frontend for Mugi.
- **Assumptions:** `lib/excel.js`/`routes/excel.js` are Jeevan's own files (`docs/roles/JEEVAN.md`) — no cross-team handoff needed. `getFieldSpec()`/`sbSelect()` consumed read-only, unchanged (Barat's frozen contracts).
```

- [ ] **Step 2: Commit**

```bash
git add docs/WORKLOG.md
git commit -m "docs: WORKLOG entry for #2 Excel export"
```

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feature/jeevan-p4-excel
gh pr create --title "feat(#2): Excel export (GET /api/excel)" --body "$(cat <<'EOF'
Feature #2 — export expenses as a real .xlsx matching the customer's FieldSpec exactly.

## What
- `lib/excel.js` — pure `buildWorkbook(expenses, fieldSpec)`, fully unit-tested, no I/O.
- `routes/excel.js` — `GET /api/excel?from=&to=`, reuses #8's hardened `toAmount()`/`isISO()`, excludes rejected/deleted rows, X-Truncated header on row-cap hit.
- Widened `lib/reports.js` exports (toAmount, isISO) for reuse — no behavior change.

## New dependency
Adds `exceljs` (ADR-012 in docs/DECISIONS.md) — first exception to the "two deps only" rule, justified because a real binary .xlsx needs a library.

## Verification
`npm test` -> 147/147 (20 new).

**Tier-2** (new third-party dependency, SOP §4.7) -> non-author review + QA pass required before merge.

Design spec: docs/specs/2026-07-01-excel-design.md
EOF
)"
```

Expected: PR opens successfully; note the PR number for the review step.

---

## After this plan

This plan's job ends at "PR opened." The Tier-2 review (independent QA subagent + fix loop) happens the same way #13 and #8 were handled this session — dispatch a fresh QA subagent against the opened PR, verify/fix findings, then merge. That is a review action, not an implementation task, so it is deliberately not a step in this plan.
