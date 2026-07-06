'use strict';
// lib/reports.js Phase 3 (ADR-021): buildReport gains an optional branch/staff grouping dimension
// for the master view. The invariant that makes the master trustworthy — sum of the branch group
// totals == the report total — is asserted directly (plan Phase 3: "master aggregate == sum of
// branch rows"). Grouping is additive: with no groupBy the return shape is byte-for-byte unchanged.
const test = require('node:test');
const assert = require('node:assert');
const { buildReport } = require('../lib/reports');

test('buildReport: groupBy branch -> per-branch totals that sum to the report total', () => {
  const rows = [
    { expense_date: '2026-07-01', amount: 100, branch_id: 'bA' },
    { expense_date: '2026-07-02', amount: 50, branch_id: 'bA' },
    { expense_date: '2026-07-03', amount: 30, branch_id: 'bB' },
    { expense_date: '2026-07-04', amount: 20, branch_id: null }, // unassigned (personal/HQ untagged)
  ];
  const r = buildReport(rows, 'month', { groupBy: 'branch' });
  assert.strictEqual(r.total, 200);
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g.total]));
  assert.strictEqual(byKey.bA, 150);
  assert.strictEqual(byKey.bB, 30);
  assert.strictEqual(byKey.unassigned, 20);
  // the load-bearing invariant: master == sum of the branch rows
  assert.strictEqual(r.groups.reduce((s, g) => s + g.total, 0), r.total);
});

test('buildReport: groupBy staff -> per-staff totals + counts', () => {
  const rows = [
    { expense_date: '2026-07-01', amount: 10, staff_user_id: 's1' },
    { expense_date: '2026-07-01', amount: 5, staff_user_id: 's1' },
    { expense_date: '2026-07-02', amount: 7, staff_user_id: 's2' },
  ];
  const r = buildReport(rows, 'month', { groupBy: 'staff' });
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, { total: g.total, count: g.count }]));
  assert.deepStrictEqual(byKey.s1, { total: 15, count: 2 });
  assert.deepStrictEqual(byKey.s2, { total: 7, count: 1 });
});

test('buildReport: groups respect the from/to window (same filter as buckets)', () => {
  const rows = [
    { expense_date: '2026-06-30', amount: 999, branch_id: 'bA' }, // out of window
    { expense_date: '2026-07-02', amount: 40, branch_id: 'bA' },
  ];
  const r = buildReport(rows, 'month', { groupBy: 'branch', from: '2026-07-01', to: '2026-07-31' });
  assert.strictEqual(r.total, 40);
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].total, 40);
});

test('buildReport: no groupBy -> no groups key (shape unchanged)', () => {
  const r = buildReport([{ expense_date: '2026-07-01', amount: 10 }], 'month');
  assert.ok(!('groups' in r), 'groups only appears when a grouping dimension is requested');
});

test('buildReport: branch filter restricts totals to that branch (drill-down / clerk scope)', () => {
  const rows = [
    { expense_date: '2026-07-01', amount: 100, branch_id: 'bA' },
    { expense_date: '2026-07-02', amount: 30, branch_id: 'bB' },
    { expense_date: '2026-07-03', amount: 5, branch_id: null },
  ];
  const r = buildReport(rows, 'month', { branch: 'bA' });
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.count, 1);
});

test('buildReport: staff filter restricts totals to that staff', () => {
  const rows = [
    { expense_date: '2026-07-01', amount: 10, staff_user_id: 's1', branch_id: 'bA' },
    { expense_date: '2026-07-02', amount: 7, staff_user_id: 's2', branch_id: 'bA' },
  ];
  const r = buildReport(rows, 'month', { staff: 's1' });
  assert.strictEqual(r.total, 10);
});

test('buildReport: branch filter + groupBy staff = a branch drilled down by its staff', () => {
  const rows = [
    { expense_date: '2026-07-01', amount: 10, branch_id: 'bA', staff_user_id: 's1' },
    { expense_date: '2026-07-01', amount: 20, branch_id: 'bA', staff_user_id: 's2' },
    { expense_date: '2026-07-01', amount: 99, branch_id: 'bB', staff_user_id: 's3' }, // other branch, excluded
  ];
  const r = buildReport(rows, 'month', { branch: 'bA', groupBy: 'staff' });
  assert.strictEqual(r.total, 30);
  const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g.total]));
  assert.deepStrictEqual(byKey, { s2: 20, s1: 10 });
});
