'use strict';
// Regression tests for the non-receipt guard (user-reported 2026-07-03: sending a
// selfie replied "✅ Expense Captured / Unknown / $0.00" and saved a junk row).
// isEmptyReceipt is the decision function: a photo with no merchant AND no positive
// amount is not a receipt — don't save it, don't claim it was captured. A partial
// read (a merchant OR a positive amount) IS a real receipt and must be kept for review.
const test = require('node:test');
const assert = require('node:assert');
const { isEmptyReceipt } = require('../lib/ocr');

test('selfie / non-receipt: merchant "Unknown" + amount 0 -> EMPTY (do not save)', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: 'Unknown' }), true);
});

test('non-receipt: empty merchant string + amount 0 -> EMPTY', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: '' }), true);
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: '   ' }), true);
});

test('non-receipt: merchant missing entirely + amount 0 -> EMPTY', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, {}), true);
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: null }), true);
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: 123 }), true);
});

test('non-receipt: "Unknown" is case-insensitive', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: 'unknown' }), true);
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: 'UNKNOWN' }), true);
});

test('non-receipt: a non-positive amount (0, negative, NaN) with no merchant -> EMPTY', () => {
  assert.strictEqual(isEmptyReceipt({ amount: -5 }, { merchant: 'Unknown' }), true);
  assert.strictEqual(isEmptyReceipt({ amount: NaN }, { merchant: '' }), true);
  assert.strictEqual(isEmptyReceipt({ amount: undefined }, {}), true);
});

// --- The "keep it" cases: a real (even if partial) receipt must NOT be treated as empty ---

test('real receipt: merchant + positive amount -> NOT empty (save it)', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 42.5 }, { merchant: 'Tesco' }), false);
});

test('partial read: a real merchant but amount unread (0) -> NOT empty (keep for review)', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 0 }, { merchant: 'Starbucks' }), false);
});

test('partial read: no merchant but a positive amount -> NOT empty (keep for review)', () => {
  assert.strictEqual(isEmptyReceipt({ amount: 19.99 }, { merchant: 'Unknown' }), false);
  assert.strictEqual(isEmptyReceipt({ amount: 19.99 }, {}), false);
});

test('does not throw on odd inputs (null expense / null fields)', () => {
  assert.doesNotThrow(() => isEmptyReceipt(null, null));
  assert.strictEqual(isEmptyReceipt(null, null), true);
});
