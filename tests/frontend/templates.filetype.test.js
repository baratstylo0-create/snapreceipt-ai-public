'use strict';
// QA report #4 — importing a real .xlsx used to get read via FileReader.readAsText
// (garbling binary bytes) and broke with a cryptic "malformed request body".
// isNonCsvFile() lets the client reject a file it genuinely can't read BEFORE
// attempting to. 2026-07-06: real .xlsx is now properly supported (read as raw
// bytes + parsed server-side via exceljs) — it's no longer in the rejected set.
const test = require('node:test');
const assert = require('node:assert');
const Templates = require('../../public/js/components/templates');

test('isNonCsvFile: a real .csv (by name or type) is never rejected', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'receipts.csv', type: 'text/csv' }), false);
  assert.strictEqual(Templates.isNonCsvFile({ name: 'receipts.CSV', type: '' }), false); // extension case-insensitive
  assert.strictEqual(Templates.isNonCsvFile({ name: 'no-extension', type: 'text/plain' }), false);
});
test('isNonCsvFile: a real .xlsx (by name or its real MIME type) is no longer rejected', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'Receipt tracker_fresh template.xlsx', type: '' }), false);
  assert.strictEqual(Templates.isNonCsvFile({
    name: 'weird', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), false);
});
test('isNonCsvFile: formats we genuinely cannot read are still rejected (legacy .xls, Word, PDF)', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.xls' }), true);   // legacy binary format, not real .xlsx
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.xlsm' }), true);  // macro-enabled — out of scope for now
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.docx' }), true);
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.pdf' }), true);
});
test('isNonCsvFile: a non-text, non-xlsx MIME type is rejected even with a misleading/missing extension', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'weird', type: 'application/vnd.ms-excel' }), true);
});
test('isNonCsvFile: missing/garbage file never throws', () => {
  assert.strictEqual(Templates.isNonCsvFile(null), false);
  assert.strictEqual(Templates.isNonCsvFile({}), false);
});

test('isExcelFile: true only for a real .xlsx name, tolerant of garbage/missing input', () => {
  assert.strictEqual(Templates.isExcelFile({ name: 'template.xlsx' }), true);
  assert.strictEqual(Templates.isExcelFile({ name: 'template.XLSX' }), true);
  assert.strictEqual(Templates.isExcelFile({ name: 'template.xls' }), false);
  assert.strictEqual(Templates.isExcelFile({ name: 'template.csv' }), false);
  assert.strictEqual(Templates.isExcelFile(null), false);
  assert.strictEqual(Templates.isExcelFile({}), false);
});
