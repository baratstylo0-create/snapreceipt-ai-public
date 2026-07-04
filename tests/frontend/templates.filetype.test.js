'use strict';
// QA report #4 — importing a real .xlsx got read via FileReader.readAsText (garbling
// binary bytes) and broke with a cryptic "malformed request body". isNonCsvFile() lets
// the client reject it BEFORE reading, from the file's name/type.
const test = require('node:test');
const assert = require('node:assert');
const Templates = require('../../public/js/components/templates');

test('isNonCsvFile: a real .csv (by name or type) is never rejected', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'receipts.csv', type: 'text/csv' }), false);
  assert.strictEqual(Templates.isNonCsvFile({ name: 'receipts.CSV', type: '' }), false); // extension case-insensitive
  assert.strictEqual(Templates.isNonCsvFile({ name: 'no-extension', type: 'text/plain' }), false);
});
test('isNonCsvFile: known binary extensions are rejected (the reported .xlsx case)', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'Receipt tracker_fresh template.xlsx', type: '' }), true);
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.docx' }), true);
  assert.strictEqual(Templates.isNonCsvFile({ name: 'x.pdf' }), true);
});
test('isNonCsvFile: a non-text MIME type is rejected even with a misleading/missing extension', () => {
  assert.strictEqual(Templates.isNonCsvFile({ name: 'weird', type: 'application/vnd.ms-excel' }), true);
});
test('isNonCsvFile: missing/garbage file never throws', () => {
  assert.strictEqual(Templates.isNonCsvFile(null), false);
  assert.strictEqual(Templates.isNonCsvFile({}), false);
});
