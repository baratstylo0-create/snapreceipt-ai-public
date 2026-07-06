'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildWorkbook, summarize } = require('../lib/excel');

const FIELD_SPEC = {
  columns: [
    { key: 'merchant', label: 'Vendor', type: 'text', required: true },
    { key: 'expense_date', label: 'Date', type: 'date', required: true },
    { key: 'amount', label: 'Total', type: 'currency', required: true },
    { key: 'quantity', label: 'Qty', type: 'number', required: false },
  ],
};

// ExcelJS's Row.values getter omits Null-typed cells (they become sparse-array
// holes that read as `undefined`, not `null`). Read each defined column via
// getCell instead, which returns `null` for a blank cell — so "blank cell"
// assertions (=== null) hold for trailing empty columns too.
function headerRow(workbook) {
  const ws = workbook.worksheets[0];
  const out = [];
  for (let i = 1; i <= ws.columnCount; i++) out.push(ws.getRow(1).getCell(i).value);
  return out;
}
function dataRow(workbook, n) {
  const ws = workbook.worksheets[0];
  const out = [];
  for (let i = 1; i <= ws.columnCount; i++) out.push(ws.getRow(n + 1).getCell(i).value);
  return out;
}

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

test('a FieldSpec with no columns produces an Expenses sheet with only a header row of nothing', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe' }], { columns: [] });
  assert.strictEqual(wb.worksheets[0].columnCount, 0);
});

test('a legitimate zero amount renders as 0, not a blank cell', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 0 }], FIELD_SPEC);
  assert.strictEqual(dataRow(wb, 1)[2], 0);
});

test('two FieldSpec columns sharing a key each get their own cell (no silent data loss)', () => {
  const spec = { columns: [
    { key: 'merchant', label: 'Vendor', type: 'text', required: true },
    { key: 'merchant', label: 'Vendor (dup)', type: 'text', required: false },
  ] };
  const wb = buildWorkbook([{ merchant: 'Cafe' }], spec);
  assert.deepStrictEqual(dataRow(wb, 1), ['Cafe', 'Cafe']);
});

// --- summarize() (pure, unit-testable without a workbook) --------------------

test('summarize: totals + per-category breakdown, sorted by total descending', () => {
  const expenses = [
    { amount: 10, category: 'Food' },
    { amount: 5, category: 'Food' },
    { amount: 20, category: 'Travel' },
  ];
  const s = summarize(expenses);
  assert.strictEqual(s.total, 35);
  assert.strictEqual(s.count, 3);
  assert.deepStrictEqual(s.categories, [
    { name: 'Travel', total: 20, count: 1 },
    { name: 'Food', total: 15, count: 2 },
  ]);
});

test('summarize: missing category falls back to "Others"; garbage amounts are excluded entirely', () => {
  const s = summarize([{ amount: 5 }, { amount: 'nope', category: 'Food' }, { amount: Infinity }]);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.count, 1);
  assert.deepStrictEqual(s.categories, [{ name: 'Others', total: 5, count: 1 }]);
});

test('summarize: empty/null/garbage input never throws', () => {
  assert.deepStrictEqual(summarize([]), { total: 0, count: 0, categories: [] });
  assert.deepStrictEqual(summarize(null), { total: 0, count: 0, categories: [] });
  assert.deepStrictEqual(summarize([null, undefined]), { total: 0, count: 0, categories: [] });
});

// --- buildWorkbook's Summary sheet (2nd worksheet) ---------------------------

test('buildWorkbook: Summary is the SECOND worksheet, Expenses stays first (back-compat)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10, category: 'Food' }], FIELD_SPEC);
  assert.strictEqual(wb.worksheets.length, 2);
  assert.strictEqual(wb.worksheets[0].name, 'Expenses');
  assert.strictEqual(wb.worksheets[1].name, 'Summary');
});

test('buildWorkbook: Summary sheet shows the range label, totals, and category rows', () => {
  const expenses = [
    { merchant: 'Cafe', amount: 10, category: 'Food' },
    { merchant: 'Shop', amount: 20, category: 'Travel' },
  ];
  const wb = buildWorkbook(expenses, FIELD_SPEC, { rangeLabel: 'This week' });
  const s = wb.worksheets[1];
  assert.deepStrictEqual(s.getRow(1).values.slice(1), ['Report period', 'This week']);
  assert.deepStrictEqual(s.getRow(2).values.slice(1), ['Total spend', 30]);
  assert.deepStrictEqual(s.getRow(3).values.slice(1), ['Total bills', 2]);
  assert.deepStrictEqual(s.getRow(5).values.slice(1), ['Category', 'Total', 'Bills']);
  assert.deepStrictEqual(s.getRow(6).values.slice(1), ['Travel', 20, 1]);
  assert.deepStrictEqual(s.getRow(7).values.slice(1), ['Food', 10, 1]);
});

test('buildWorkbook: Summary sheet defaults rangeLabel to "All time" when omitted', () => {
  const wb = buildWorkbook([], FIELD_SPEC);
  assert.deepStrictEqual(wb.worksheets[1].getRow(1).values.slice(1), ['Report period', 'All time']);
});
