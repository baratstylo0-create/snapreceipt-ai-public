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

test('a FieldSpec with no columns produces a workbook with only a header row of nothing', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe' }], { columns: [] });
  assert.strictEqual(wb.worksheets.length, 1);
});
