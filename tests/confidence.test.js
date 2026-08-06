'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scoreConfidence, isPresent } = require('../lib/confidence');

const SPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Merchant', type: 'text',     required: true },
    { key: 'amount',       label: 'Amount',   type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
    { key: 'remark',       label: 'Note',     type: 'text',     required: false },
  ],
};

test('isPresent: empty/null/blank are absent; money 0 is absent; real values present', () => {
  assert.strictEqual(isPresent(null, 'text'), false);
  assert.strictEqual(isPresent('', 'text'), false);
  assert.strictEqual(isPresent('   ', 'text'), false);
  assert.strictEqual(isPresent('Acme', 'text'), true);
  assert.strictEqual(isPresent(0, 'currency'), false);   // 0 total => coercion fallback, not read
  assert.strictEqual(isPresent('0', 'number'), false);
  assert.strictEqual(isPresent(12.5, 'currency'), true);
});

test('all fields read → all high, not flagged', () => {
  const c = scoreConfidence(SPEC, { merchant: 'Acme', amount: 42.5, expense_date: '2026-01-02', remark: 'lunch' });
  assert.deepStrictEqual(c.perField, { merchant: 'high', amount: 'high', expense_date: 'high', remark: 'high' });
  assert.strictEqual(c.flagged, false);
  assert.deepStrictEqual(c.low, []);
  assert.strictEqual(c.reason, '');
});

test('missing REQUIRED field → low + flagged with reason', () => {
  const c = scoreConfidence(SPEC, { merchant: 'Acme', amount: 0, expense_date: null, remark: '' });
  assert.strictEqual(c.perField.amount, 'low');
  assert.strictEqual(c.perField.expense_date, 'low');
  assert.strictEqual(c.flagged, true);
  assert.match(c.reason, /required field/i);
  assert.match(c.reason, /amount/);
  assert.match(c.reason, /expense_date/);
});

test('missing only OPTIONAL field → low but NOT flagged', () => {
  const c = scoreConfidence(SPEC, { merchant: 'Acme', amount: 10, expense_date: '2026-01-02', remark: null });
  assert.deepStrictEqual(c.low, ['remark']);
  assert.strictEqual(c.flagged, false);
  assert.match(c.reason, /Low confidence on: remark/);
});

test('empty/garbage inputs do not throw', () => {
  assert.doesNotThrow(() => scoreConfidence(null, null));
  assert.doesNotThrow(() => scoreConfidence({}, undefined));
  const c = scoreConfidence({ columns: [] }, {});
  assert.deepStrictEqual(c, { perField: {}, low: [], flagged: false, reason: '' });
});

// PR #12 review (QA nice-to-add): garbage/unreadable values must stay 'low',
// never score 'high' by accident — including malformed object/array values.
test('garbage and malformed values stay low (never high by accident)', () => {
  const c = scoreConfidence(SPEC, {
    merchant: {},            // object for a text field -> malformed -> low
    amount: 'N/A',           // non-numeric money -> low
    expense_date: [1, 2],    // array -> malformed -> low
    remark: '   ',           // whitespace only -> low
  });
  assert.strictEqual(c.perField.merchant, 'low');
  assert.strictEqual(c.perField.amount, 'low');
  assert.strictEqual(c.perField.expense_date, 'low');
  assert.strictEqual(c.perField.remark, 'low');
  assert.strictEqual(c.flagged, true); // required merchant/amount/date are low
});

// Issue #149 (live client QA): a faded/garbled date is a NON-EMPTY string the model
// returned, but it isn't actually a date — isPresent used to treat any non-empty string
// as 'high', so lib/money.js's normaliseDate() would silently rewrite it to today with
// no flag at all. It must now score 'low' so the existing needs_review/⚠️ path fires.
test('isPresent: a non-empty but unparseable date string is low, not high (issue #149)', () => {
  assert.strictEqual(isPresent('totally illegible', 'date'), false);
  assert.strictEqual(isPresent('????', 'date'), false);
});

// The flip side: a date that's non-ISO/non-DD-MM-YYYY but STILL genuinely readable
// (a trailing OCR timestamp) must stay 'high' — the model DID read it correctly.
test('isPresent: a date with a trailing timestamp is still high (issue #149)', () => {
  assert.strictEqual(isPresent('30/06/2026 12:46:53', 'date'), true);
});

// Amount parity (issue #149 asked to double-check this): a garbled/non-numeric amount
// was already correctly low BEFORE this fix — isPresent checks the RAW value with the
// same Number() cast coerce() uses, so an unreadable amount never scored high by
// accident. Locking it in as a regression guard, not a behaviour change.
test('isPresent: a garbled non-numeric amount is low (already-correct parity check, issue #149)', () => {
  assert.strictEqual(isPresent('RM1O.5O', 'currency'), false); // letter-O instead of zero
  assert.strictEqual(isPresent(undefined, 'currency'), false);
});
