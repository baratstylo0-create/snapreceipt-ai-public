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

test('summarize: totals + per-category breakdown (with % of total), sorted by total descending', () => {
  const expenses = [
    { amount: 10, category: 'Food', expense_date: '2026-07-01' },
    { amount: 5, category: 'Food', expense_date: '2026-07-03' },
    { amount: 20, category: 'Travel', expense_date: '2026-06-15' },
  ];
  const s = summarize(expenses);
  assert.strictEqual(s.total, 35);
  assert.strictEqual(s.count, 3);
  assert.deepStrictEqual(s.categories, [
    { name: 'Travel', total: 20, count: 1, pct: Math.round((20 / 35) * 1000) / 10 },
    { name: 'Food', total: 15, count: 2, pct: Math.round((15 / 35) * 1000) / 10 },
  ]);
  assert.strictEqual(s.earliestDate, '2026-06-15');
  assert.strictEqual(s.latestDate, '2026-07-03');
});

test('summarize: missing category falls back to "Others"; garbage amounts are excluded entirely', () => {
  const s = summarize([{ amount: 5 }, { amount: 'nope', category: 'Food' }, { amount: Infinity }]);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.count, 1);
  assert.deepStrictEqual(s.categories, [{ name: 'Others', total: 5, count: 1, pct: 100 }]);
});

test('summarize: empty/null/garbage input never throws, dates are null', () => {
  assert.deepStrictEqual(summarize([]), { total: 0, count: 0, categories: [], earliestDate: null, latestDate: null });
  assert.deepStrictEqual(summarize(null), { total: 0, count: 0, categories: [], earliestDate: null, latestDate: null });
  assert.deepStrictEqual(summarize([null, undefined]), { total: 0, count: 0, categories: [], earliestDate: null, latestDate: null });
});

test('summarize: a garbage/missing expense_date is excluded from earliest/latest, not crashed', () => {
  const s = summarize([{ amount: 5, expense_date: 'not-a-date' }, { amount: 5 }]);
  assert.strictEqual(s.earliestDate, null);
  assert.strictEqual(s.latestDate, null);
});

// --- buildWorkbook's Summary sheet (2nd worksheet) ---------------------------

test('buildWorkbook: Summary is the SECOND worksheet, Expenses stays first (back-compat)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10, category: 'Food' }], FIELD_SPEC);
  assert.strictEqual(wb.worksheets.length, 2);
  assert.strictEqual(wb.worksheets[0].name, 'Expenses');
  assert.strictEqual(wb.worksheets[1].name, 'Summary');
});

test('buildWorkbook: Summary sheet shows title, period, data-covers, generated-at, totals, average, and category rows with %', () => {
  const expenses = [
    { merchant: 'Cafe', amount: 10, category: 'Food', expense_date: '2026-07-01' },
    { merchant: 'Shop', amount: 20, category: 'Travel', expense_date: '2026-07-03' },
  ];
  const wb = buildWorkbook(expenses, FIELD_SPEC, { rangeLabel: 'This week', generatedAt: '2026-07-06T12:00:00.000Z' });
  const s = wb.worksheets[1];
  // Title cell is merged across A1:D1 — ExcelJS's row.values replicates the
  // master value across every cell in a merge, so assert the cell directly.
  assert.strictEqual(s.getRow(1).getCell(1).value, 'Expense Report');
  assert.deepStrictEqual(s.getRow(3).values.slice(1), ['Report period', 'This week']);
  assert.deepStrictEqual(s.getRow(4).values.slice(1), ['Data covers', '2026-07-01 to 2026-07-03']);
  assert.deepStrictEqual(s.getRow(5).values.slice(1), ['Report generated', '2026-07-06T12:00:00.000Z']);
  assert.deepStrictEqual(s.getRow(7).values.slice(1), ['Total spend', 30]);
  assert.deepStrictEqual(s.getRow(8).values.slice(1), ['Total bills', 2]);
  assert.deepStrictEqual(s.getRow(9).values.slice(1), ['Average per bill', 15]);
  assert.deepStrictEqual(s.getRow(11).values.slice(1), ['Category', 'Total', 'Bills', '% of Total']);
  assert.deepStrictEqual(s.getRow(12).values.slice(1), ['Travel', 20, 1, 66.7]);
  assert.deepStrictEqual(s.getRow(13).values.slice(1), ['Food', 10, 1, 33.3]);
});

test('buildWorkbook: Summary sheet defaults rangeLabel to "All time" and shows "no expenses" when empty', () => {
  const wb = buildWorkbook([], FIELD_SPEC);
  const s = wb.worksheets[1];
  assert.deepStrictEqual(s.getRow(3).values.slice(1), ['Report period', 'All time']);
  assert.deepStrictEqual(s.getRow(4).values.slice(1), ['Data covers', 'No expenses in this period']);
  assert.deepStrictEqual(s.getRow(9).values.slice(1), ['Average per bill', 0]);
});

test('buildWorkbook: Summary sheet money/percent cells carry a number format (not just raw numbers)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10, category: 'Food', expense_date: '2026-07-01' }], FIELD_SPEC);
  const s = wb.worksheets[1];
  assert.strictEqual(s.getRow(7).getCell(2).numFmt, '#,##0.00');   // Total spend
  assert.strictEqual(s.getRow(9).getCell(2).numFmt, '#,##0.00');   // Average per bill
  assert.strictEqual(s.getRow(12).getCell(2).numFmt, '#,##0.00');  // category Total
  assert.strictEqual(s.getRow(12).getCell(4).numFmt, '0.0"%"');    // category % of Total
});
