'use strict';
// Shared export/extract guard logic for PR-A:
// - empty views must not export ("No data to export.")
// - non-empty extracts must ask the user to confirm they reviewed the data first.
const test = require('node:test');
const assert = require('node:assert');
const Guards = require('../../public/js/exportGuards');

test('hasExtractData: report-shaped objects use count > 0', () => {
  assert.strictEqual(Guards.hasExtractData({ count: 1 }), true);
  assert.strictEqual(Guards.hasExtractData({ count: '2' }), true);
  assert.strictEqual(Guards.hasExtractData({ count: 0 }), false);
  assert.strictEqual(Guards.hasExtractData({ count: '0' }), false);
});

test('hasExtractData: arrays use length; garbage is empty', () => {
  assert.strictEqual(Guards.hasExtractData([{}]), true);
  assert.strictEqual(Guards.hasExtractData([]), false);
  assert.strictEqual(Guards.hasExtractData(null), false);
  assert.strictEqual(Guards.hasExtractData({}), false);
});

test('exportGate: empty data blocks before confirmation', () => {
  const out = Guards.exportGate({ data: { count: 0 }, confirmed: true });
  assert.deepStrictEqual(out, { ok: false, needsConfirm: false, message: Guards.NO_DATA_MESSAGE });
});

test('exportGate: non-empty data asks for review confirmation before extracting', () => {
  const out = Guards.exportGate({ data: { count: 1 }, confirmed: false });
  assert.deepStrictEqual(out, { ok: false, needsConfirm: true, message: Guards.CONFIRM_REVIEW_MESSAGE });
});

test('exportGate: non-empty confirmed data may proceed', () => {
  assert.deepStrictEqual(Guards.exportGate({ data: [{ id: 'e1' }], confirmed: true }), { ok: true });
});
