'use strict';
// refDisplay — the voucher/reference-number cell (RC-2026-0041) in the Activity view.
// Falls back to an em dash for rows that predate the voucher migration so the column
// is never a blank/undefined cell.
const test = require('node:test');
const assert = require('node:assert');
const Activity = require('../../public/js/components/activity');

test('refDisplay: shows the voucher_no when present', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: 'RC-2026-0041' }), 'RC-2026-0041');
});
test('refDisplay: trims surrounding whitespace', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: '  RC-2026-0001  ' }), 'RC-2026-0001');
});
test('refDisplay: missing / empty / null voucher_no -> em dash (never blank)', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: '' }), '—');
  assert.strictEqual(Activity.refDisplay({ voucher_no: null }), '—');
  assert.strictEqual(Activity.refDisplay({}), '—');
});
test('refDisplay: null/garbage row never throws', () => {
  assert.strictEqual(Activity.refDisplay(null), '—');
  assert.strictEqual(Activity.refDisplay({ voucher_no: 123 }), '—'); // non-string is ignored
});
