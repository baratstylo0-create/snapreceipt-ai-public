'use strict';
// components/grid.js Phase 6 (ADR-021): the excel-lite Ledger grid's pure cell-edit logic.
// buildCellPatch mirrors the server's sanitizeExpensePatch rules client-side (fail fast, no
// round-trip) and always carries expected_updated_at so a stale edit 409s instead of
// clobbering. Values only — no column changes (v1 scope).
const test = require('node:test');
const assert = require('node:assert');
const { buildCellPatch, EDITABLE } = require('../../public/js/components/grid');

const ROW = { id: 'e1', merchant: 'Cafe', amount: 10, expense_date: '2026-07-01', category: 'Meals & Entertainment', remark: '', updated_at: '2026-07-07T10:00:00+00:00' };

test('EDITABLE lists exactly the v1 editable fields', () => {
  assert.deepStrictEqual(EDITABLE, ['expense_date', 'merchant', 'category', 'amount', 'remark']);
});

test('a text edit builds { field, expected_updated_at }', () => {
  const r = buildCellPatch(ROW, 'merchant', '  Cafe KL  ');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.patch, { merchant: 'Cafe KL', expected_updated_at: '2026-07-07T10:00:00+00:00' });
});

test('an amount edit coerces to a finite number; garbage is rejected with a message', () => {
  assert.deepStrictEqual(buildCellPatch(ROW, 'amount', ' 12.50 ').patch.amount, 12.5);
  assert.strictEqual(buildCellPatch(ROW, 'amount', 'abc').ok, false);
  assert.strictEqual(buildCellPatch(ROW, 'amount', '').ok, false);
  assert.ok(buildCellPatch(ROW, 'amount', 'abc').error);
});

test('a date edit requires YYYY-MM-DD shape', () => {
  assert.strictEqual(buildCellPatch(ROW, 'expense_date', '2026-08-02').ok, true);
  assert.strictEqual(buildCellPatch(ROW, 'expense_date', '02/08/2026').ok, false);
});

test('an unchanged value is a no-op (ok:false, noop:true — no PATCH fired)', () => {
  const r = buildCellPatch(ROW, 'merchant', 'Cafe');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.noop, true);
});

test('a non-editable field is refused', () => {
  assert.strictEqual(buildCellPatch(ROW, 'voucher_no', 'X').ok, false);
  assert.strictEqual(buildCellPatch(ROW, 'payment_status', 'paid').ok, false);
});

test('a row without updated_at still edits (guard simply omitted — pre-migration rows)', () => {
  const r = buildCellPatch({ id: 'e2', merchant: 'Old' }, 'merchant', 'New');
  assert.strictEqual(r.ok, true);
  assert.ok(!('expected_updated_at' in r.patch));
});
