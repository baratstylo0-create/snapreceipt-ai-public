'use strict';
// Issue #153 — pure helpers for the dashboard upload saved-results staff assignment grid.
const test = require('node:test');
const assert = require('node:assert');
const Upload = require('../../public/js/components/upload');

test('showStaffAssignment: only true in business/multi-user mode', () => {
  assert.strictEqual(Upload.showStaffAssignment({ multi_user: true }), true);
  assert.strictEqual(Upload.showStaffAssignment({ multi_user: false }), false);
  assert.strictEqual(Upload.showStaffAssignment({}), false);
  assert.strictEqual(Upload.showStaffAssignment(null), false);
  assert.strictEqual(Upload.showStaffAssignment(undefined), false);
});

test('branchIdsForSavedItems: unique sorted non-empty branch ids only', () => {
  assert.deepStrictEqual(Upload.branchIdsForSavedItems([
    { id: 'e1', branch_id: 'b2' },
    { id: 'e2', branch_id: 'b1' },
    { id: 'e3', branch_id: 'b2' },
    { id: 'e4', branch_id: '' },
    null,
  ]), ['b1', 'b2']);
});

test('selectedBranchId: returns the single selected branch, null for mixed branches', () => {
  const items = [{ id: 'e1', branch_id: 'bA' }, { id: 'e2', branch_id: 'bA' }, { id: 'e3', branch_id: 'bB' }];
  assert.strictEqual(Upload.selectedBranchId(items, { e1: true, e2: true }), 'bA');
  assert.strictEqual(Upload.selectedBranchId(items, { e1: true, e3: true }), null);
  assert.strictEqual(Upload.selectedBranchId(items, {}), '');
});

test('normalizeStaff: accepts branch staff response shape and drops unusable rows', () => {
  assert.deepStrictEqual(Upload.normalizeStaff({ staff: [
    { id: 's1', display_name: 'Ali' },
    { id: 's2', name: 'Siti' },
    { display_name: 'No id' },
  ] }), [
    { id: 's1', display_name: 'Ali' },
    { id: 's2', display_name: 'Siti' },
  ]);
  assert.deepStrictEqual(Upload.normalizeStaff(null), []);
});

test('applyStaffAssignResult: updates only rows whose per-id result succeeded', () => {
  const items = [{ id: 'e1', staff_user_id: null }, { id: 'e2', staff_user_id: null }];
  Upload.applyStaffAssignResult(items, ['e1', 'e2'], 'sA', { results: [
    { id: 'e1', ok: true },
    { id: 'e2', ok: false },
  ] });
  assert.deepStrictEqual(items.map((x) => x.staff_user_id), ['sA', null]);
});

test('summarize: saved_items carries branch_id/staff_user_id for assignment grid', () => {
  const item = { id: 'e1', branch_id: 'bA', staff_user_id: null };
  const vm = Upload.summarize({ saved_items: [item] });
  assert.deepStrictEqual(vm.savedItems, [item]);
});

test('flaggedDisplay: duplicate flags name the existing expense id', () => {
  assert.deepStrictEqual(Upload.flaggedDisplay({
    merchant: 'Shell',
    reason: true,
    existing_expense_id: 'old-123',
  }), {
    text: 'Shell — Possible duplicate of existing expense old-123',
    duplicate: true,
  });
  assert.deepStrictEqual(Upload.flaggedDisplay({ merchant: 'Cafe', reason: 'low confidence' }), {
    text: 'Cafe — low confidence',
    duplicate: false,
  });
});
