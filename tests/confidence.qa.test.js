'use strict';
// QA pass (adversarial) — GAPS in scoreConfidence() beyond confidence.test.js:
// rawParsed as null/array/primitive, zero-required-column FieldSpec, huge values.
const test = require('node:test');
const assert = require('node:assert');
const { scoreConfidence } = require('../lib/confidence');

const SPEC = {
  columns: [
    { key: 'merchant',     type: 'text',     required: true },
    { key: 'amount',       type: 'currency', required: true },
    { key: 'expense_date', type: 'date',     required: true },
    { key: 'remark',       type: 'text',     required: false },
  ],
};

test('rawParsed = null -> every required field low + flagged, no throw', () => {
  const c = scoreConfidence(SPEC, null);
  assert.strictEqual(c.flagged, true);
  assert.deepStrictEqual(c.perField, { merchant: 'low', amount: 'low', expense_date: 'low', remark: 'low' });
});

test('rawParsed = an array -> treated as empty object, all low + flagged', () => {
  const c = scoreConfidence(SPEC, [{ merchant: 'sneaky' }]);
  // array indices are not the field keys => nothing "present"
  assert.strictEqual(c.perField.merchant, 'low');
  assert.strictEqual(c.flagged, true);
});

test('rawParsed = a primitive (string/number) -> no throw, all low', () => {
  for (const p of ['hello', 42, true]) {
    const c = scoreConfidence(SPEC, p);
    assert.strictEqual(c.perField.merchant, 'low', 'primitive ' + JSON.stringify(p));
    assert.strictEqual(c.flagged, true);
  }
});

test('FieldSpec with zero REQUIRED columns -> never flagged even when all empty', () => {
  const spec = { columns: [{ key: 'note', type: 'text', required: false }] };
  const c = scoreConfidence(spec, {});
  assert.strictEqual(c.flagged, false);
  assert.strictEqual(c.perField.note, 'low');
  assert.deepStrictEqual(c.low, ['note']);
});

test('FieldSpec with an empty columns array -> flagged false, empty perField', () => {
  const c = scoreConfidence({ columns: [] }, { merchant: 'x' });
  assert.deepStrictEqual(c, { perField: {}, low: [], flagged: false, reason: '' });
});

test('extremely long text value is still counted present (high), no throw', () => {
  const big = 'A'.repeat(200000);
  const c = scoreConfidence(SPEC, { merchant: big, amount: 10, expense_date: '2026-01-01' });
  assert.strictEqual(c.perField.merchant, 'high');
  assert.strictEqual(c.flagged, false); // all required present
});

test('required present but optional missing -> low list has optional, not flagged', () => {
  const c = scoreConfidence(SPEC, { merchant: 'Acme', amount: 5, expense_date: '2026-01-01' });
  assert.strictEqual(c.flagged, false);
  assert.deepStrictEqual(c.low, ['remark']);
});
