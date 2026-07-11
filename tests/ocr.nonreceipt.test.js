'use strict';
// Regression tests for the non-receipt guard (user-reported 2026-07-03: sending a
// selfie replied "✅ Expense Captured / Unknown / $0.00" and saved a junk row).
// isEmptyReceipt is the decision function: a photo with no merchant AND no positive
// amount is not a receipt — don't save it, don't claim it was captured. A partial
// read (a merchant OR a positive amount) IS a real receipt and must be kept for review.
const test = require('node:test');
const assert = require('node:assert');
const { isEmptyReceipt, skipReason, skipMessage, refLine } = require('../lib/ocr');

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

// --- skipReason: WHY a skipped photo was skipped, from the model's own signal ---
// (Owner feedback 2026-07-03: a blurry real receipt and a totally unrelated photo used
// to get the exact same reply. They need different, honest wording.)

test('skipReason: looks_like_receipt true -> "blurry" (it IS a receipt, just unreadable)', () => {
  assert.strictEqual(skipReason({ looks_like_receipt: true }), 'blurry');
});

test('skipReason: looks_like_receipt false -> "not_receipt"', () => {
  assert.strictEqual(skipReason({ looks_like_receipt: false }), 'not_receipt');
});

test('skipReason: a stringified "true"/"false" (model didn\'t emit a real JSON boolean) still resolves', () => {
  assert.strictEqual(skipReason({ looks_like_receipt: 'true' }), 'blurry');
  assert.strictEqual(skipReason({ looks_like_receipt: 'TRUE' }), 'blurry');
  assert.strictEqual(skipReason({ looks_like_receipt: 'false' }), 'not_receipt');
});

test('skipReason: missing/garbled signal -> "unclear" (never guess)', () => {
  assert.strictEqual(skipReason({}), 'unclear');
  assert.strictEqual(skipReason(null), 'unclear');
  assert.strictEqual(skipReason({ looks_like_receipt: 'maybe' }), 'unclear');
  assert.strictEqual(skipReason({ looks_like_receipt: null }), 'unclear');
});

test('skipMessage: each reason has distinct, humanized wording', () => {
  assert.match(skipMessage('blurry'), /blurry/i);
  assert.match(skipMessage('not_receipt'), /doesn't look like a receipt/i);
  assert.match(skipMessage('unclear'), /couldn't read this clearly/i);
  assert.ok(skipMessage('blurry') !== skipMessage('not_receipt'), 'blurry and not_receipt must read differently');
});

test('skipMessage: every reason states it was NOT saved AND asks to re-upload (Owner directive 2026-07-11)', () => {
  for (const reason of ['blurry', 'not_receipt', 'unclear']) {
    assert.match(skipMessage(reason), /NOT saved/, reason + ' must say it was NOT saved');
    assert.match(skipMessage(reason), /re-upload/i, reason + ' must ask the user to re-upload');
  }
});

test('skipMessage: an unrecognised reason falls back to the safe generic wording', () => {
  assert.strictEqual(skipMessage('something-new'), skipMessage('unclear'));
  assert.strictEqual(skipMessage(undefined), skipMessage('unclear'));
});

// --- refLine (ADR-017): the optional "Ref: RC-2026-0041" line in the Telegram reply ---

test('refLine: includes the voucher_no when present', () => {
  assert.match(refLine({ voucher_no: 'RC-2026-0041' }), /RC-2026-0041/);
  assert.match(refLine({ voucher_no: 'RC-2026-0041' }), /Ref:/);
});

test('refLine: empty string when voucher_no is missing (no migration applied yet, or an old row) — never a blank "Ref: " placeholder', () => {
  assert.strictEqual(refLine({}), '');
  assert.strictEqual(refLine({ voucher_no: null }), '');
  assert.strictEqual(refLine({ voucher_no: '' }), '');
});

test('refLine: does not throw on null/undefined expense', () => {
  assert.strictEqual(refLine(null), '');
  assert.strictEqual(refLine(undefined), '');
});
