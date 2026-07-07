'use strict';
// components/payments.js Phase 6 (ADR-021): the payment Pending/Paid tabs' pure logic —
// tab/month/branch/staff filtering and the sticky selection summary (count + money total).
// Node-testable, no DOM; the view wires these to the table + the Phase-4 bulk-pay endpoint.
const test = require('node:test');
const assert = require('node:assert');
const { filterRows, selectionSummary } = require('../../public/js/components/payments');

const ROWS = [
  { id: 'a', amount: 10, payment_status: 'pending', expense_date: '2026-07-01', branch_id: 'bA', staff_user_id: 's1' },
  { id: 'b', amount: 20, payment_status: 'pending', expense_date: '2026-06-15', branch_id: 'bB', staff_user_id: 's2' },
  { id: 'c', amount: 5, payment_status: 'paid', expense_date: '2026-07-03', branch_id: 'bA', staff_user_id: null },
  { id: 'd', amount: 7, expense_date: '2026-07-04', branch_id: null, staff_user_id: null }, // legacy row, no payment_status
];

test('filterRows: tab pending includes rows WITHOUT payment_status (legacy rows default pending)', () => {
  const ids = filterRows(ROWS, { tab: 'pending' }).map((r) => r.id);
  assert.deepStrictEqual(ids, ['a', 'b', 'd']);
});

test('filterRows: tab paid -> only paid rows', () => {
  assert.deepStrictEqual(filterRows(ROWS, { tab: 'paid' }).map((r) => r.id), ['c']);
});

test('filterRows: month filter matches the expense_date YYYY-MM prefix', () => {
  const ids = filterRows(ROWS, { tab: 'pending', month: '2026-07' }).map((r) => r.id);
  assert.deepStrictEqual(ids, ['a', 'd']);
});

test('filterRows: branch + staff filters ("unassigned" matches null)', () => {
  assert.deepStrictEqual(filterRows(ROWS, { tab: 'pending', branch: 'bA' }).map((r) => r.id), ['a']);
  assert.deepStrictEqual(filterRows(ROWS, { tab: 'pending', branch: 'unassigned' }).map((r) => r.id), ['d']);
  assert.deepStrictEqual(filterRows(ROWS, { tab: 'pending', staff: 's2' }).map((r) => r.id), ['b']);
});

test('filterRows: garbage input never throws', () => {
  assert.deepStrictEqual(filterRows(null, {}), []);
  assert.deepStrictEqual(filterRows([null, undefined], { tab: 'pending' }), []);
});

test('selectionSummary: counts + sums only the selected ids, rounds to cents', () => {
  const sel = selectionSummary(ROWS, ['a', 'c']);
  assert.deepStrictEqual(sel, { count: 2, total: 15 });
});

test('selectionSummary: skips non-finite amounts (never a fake total)', () => {
  const rows = [{ id: 'x', amount: 'garbage' }, { id: 'y', amount: 2.345 }];
  assert.deepStrictEqual(selectionSummary(rows, ['x', 'y']), { count: 2, total: 2.35 });
});

test('selectionSummary: empty selection -> zeros', () => {
  assert.deepStrictEqual(selectionSummary(ROWS, []), { count: 0, total: 0 });
  assert.deepStrictEqual(selectionSummary(ROWS, null), { count: 0, total: 0 });
});
