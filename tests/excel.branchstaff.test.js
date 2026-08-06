'use strict';
// lib/excel.js Phase 3 (ADR-021): business exports append Branch + Staff columns after the
// FieldSpec columns, resolving branch_id/staff_user_id to names via opts maps (id fallback when a
// name is unknown, blank when the row has none). Business-only: with no opts.branchStaff the sheet
// is byte-for-byte the personal export (no extra columns).
const test = require('node:test');
const assert = require('node:assert');
const { buildWorkbook } = require('../lib/excel');

const FIELD_SPEC = {
  columns: [
    { key: 'merchant', label: 'Vendor', type: 'text' },
    { key: 'amount', label: 'Total', type: 'currency' },
  ],
};
const HEADER_ROW = 2;
function headerRow(wb) {
  const ws = wb.worksheets[0]; const out = [];
  for (let i = 1; i <= ws.columnCount; i++) out.push(ws.getRow(HEADER_ROW).getCell(i).value);
  return out;
}
function dataRow(wb, n) {
  const ws = wb.worksheets[0]; const out = [];
  for (let i = 1; i <= ws.columnCount; i++) out.push(ws.getRow(HEADER_ROW + n).getCell(i).value);
  return out;
}

test('business export appends Branch + Staff columns with resolved names', () => {
  const wb = buildWorkbook(
    [{ merchant: 'Cafe', amount: 10, branch_id: 'bA', staff_user_id: 's1' }],
    FIELD_SPEC,
    { branchStaff: true, branchNames: { bA: 'KL Branch' }, staffNames: { s1: 'Ravi' } },
  );
  assert.deepStrictEqual(headerRow(wb), ['Vendor', 'Total', 'Branch', 'Staff']);
  assert.deepStrictEqual(dataRow(wb, 1), ['Cafe', 10, 'KL Branch', 'Ravi']);
});

test('business export leaves Branch/Staff blank when the row has none', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10 }], FIELD_SPEC, { branchStaff: true });
  assert.deepStrictEqual(dataRow(wb, 1), ['Cafe', 10, null, null]);
});

test('business export falls back to the id when a name is unknown', () => {
  const wb = buildWorkbook([{ merchant: 'X', amount: 1, branch_id: 'bZ' }], FIELD_SPEC,
    { branchStaff: true, branchNames: {}, staffNames: {} });
  assert.strictEqual(dataRow(wb, 1)[2], 'bZ', 'Branch cell falls back to the id');
});

test('personal export (no branchStaff) has NO Branch/Staff columns (unchanged)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10 }], FIELD_SPEC);
  assert.deepStrictEqual(headerRow(wb), ['Vendor', 'Total']);
});
