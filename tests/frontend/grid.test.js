'use strict';
// components/grid.js Phase 6 (ADR-021): the excel-lite Ledger grid's pure cell-edit logic.
// buildCellPatch mirrors the server's sanitizeExpensePatch rules client-side (fail fast, no
// round-trip) and always carries expected_updated_at so a stale edit 409s instead of
// clobbering. Values only — no column changes (v1 scope).
const test = require('node:test');
const assert = require('node:assert');
const { buildCellPatch, EDITABLE, filterRows, paginate, escapeCSVValue, rowsToCSV, blankTemplateCSV, statementExportUrl, statementBranchOptions, managedExportButtons, statementExportButtons, ledgerTableClass, submissionPeriod, submissionState, readyToCloseRows } = require('../../public/js/components/grid');

test('submissionPeriod returns the local YYYY-MM month used by the submit signal', () => {
  assert.strictEqual(submissionPeriod(new Date(2026, 6, 13)), '2026-07');
  assert.strictEqual(submissionPeriod(new Date(2026, 0, 2)), '2026-01');
});

test('submissionState distinguishes submitted, withdrawn, and not-yet-submitted', () => {
  assert.strictEqual(submissionState(null), 'not_submitted');
  assert.strictEqual(submissionState({ status: 'submitted' }), 'submitted');
  assert.strictEqual(submissionState({ status: 'withdrawn' }), 'withdrawn');
});

test('readyToCloseRows keeps submitted branches, labels them safely, and ignores withdrawn rows', () => {
  assert.deepStrictEqual(readyToCloseRows([
    { id: 's1', branch_id: 'b2', period: '2026-07', status: 'submitted' },
    { id: 's2', branch_id: 'b1', period: '2026-07', status: 'withdrawn' },
    { id: 's3', branch_id: 'b3', period: '2026-06', status: 'submitted' },
  ], { b2: 'South' }, '2026-07'), [
    { id: 's1', branch_id: 'b2', period: '2026-07', label: 'South' },
  ]);
  assert.deepStrictEqual(readyToCloseRows(null, {}), []);
});

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

// --- filterRows: the search box (read-only-by-default redesign) ---

const ROWS = [
  { id: 'a', merchant: '99 Speed Mart', category: 'Groceries', remark: '' },
  { id: 'b', merchant: 'Petronas', category: 'Fuel & Auto', remark: 'weekly fill-up' },
  { id: 'c', merchant: 'Touch n Go top-up', category: 'Touch n Go', remark: '' },
];

test('filterRows: case-insensitive substring match across every EDITABLE field', () => {
  assert.deepStrictEqual(filterRows(ROWS, 'petronas').map((r) => r.id), ['b']);
  assert.deepStrictEqual(filterRows(ROWS, 'TOUCH N GO').map((r) => r.id), ['c']); // matches merchant AND category, no dupes
  assert.deepStrictEqual(filterRows(ROWS, 'weekly').map((r) => r.id), ['b']); // matches remark
});

test('filterRows: empty/whitespace term returns every row unchanged', () => {
  assert.deepStrictEqual(filterRows(ROWS, ''), ROWS);
  assert.deepStrictEqual(filterRows(ROWS, '   '), ROWS);
  assert.deepStrictEqual(filterRows(ROWS, undefined), ROWS);
});

test('filterRows: no match -> empty array; garbage input never throws', () => {
  assert.deepStrictEqual(filterRows(ROWS, 'nonexistent-xyz'), []);
  assert.deepStrictEqual(filterRows(null, 'x'), []);
  assert.deepStrictEqual(filterRows([null, undefined], 'x'), []);
});

// --- paginate: client-side pagination ---

test('paginate: slices into pages of the given size', () => {
  const r = paginate([1, 2, 3, 4, 5], 1, 2);
  assert.deepStrictEqual(r, { pageRows: [1, 2], page: 1, totalPages: 3, total: 5 });
  assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 3, 2).pageRows, [5]);
});

test('paginate: an out-of-range page clamps into [1, totalPages], never throws or returns garbage', () => {
  assert.strictEqual(paginate([1, 2, 3], 99, 2).page, 2); // totalPages = 2
  assert.strictEqual(paginate([1, 2, 3], 0, 2).page, 1);
  assert.strictEqual(paginate([1, 2, 3], -5, 2).page, 1);
});

test('paginate: empty input -> page 1 of 1, zero rows, never throws', () => {
  assert.deepStrictEqual(paginate([], 1, 25), { pageRows: [], page: 1, totalPages: 1, total: 0 });
  assert.deepStrictEqual(paginate(null, 1, 25).pageRows, []);
});

// --- escapeCSVValue: formula-injection guard + RFC 4180 quoting ---

test('escapeCSVValue: a leading = + - @ is prefixed with a literal quote (formula-injection guard)', () => {
  assert.strictEqual(escapeCSVValue('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.strictEqual(escapeCSVValue('+1234'), "'+1234");
  assert.strictEqual(escapeCSVValue('-1234'), "'-1234");
  assert.strictEqual(escapeCSVValue('@mention'), "'@mention");
});

test('escapeCSVValue: commas/quotes/newlines trigger RFC 4180 quoting with doubled internal quotes', () => {
  assert.strictEqual(escapeCSVValue('a, b'), '"a, b"');
  assert.strictEqual(escapeCSVValue('say "hi"'), '"say ""hi"""');
  assert.strictEqual(escapeCSVValue('line1\nline2'), '"line1\nline2"');
});

test('escapeCSVValue: a plain value passes through unquoted; null/undefined -> empty string', () => {
  assert.strictEqual(escapeCSVValue('Groceries'), 'Groceries');
  assert.strictEqual(escapeCSVValue(12.5), '12.5');
  assert.strictEqual(escapeCSVValue(null), '');
  assert.strictEqual(escapeCSVValue(undefined), '');
});

// --- rowsToCSV / blankTemplateCSV: export ---

test('rowsToCSV: raw export header + one CSV line per expense, including receipt_url', () => {
  const csv = rowsToCSV([
    {
      id: 'e1', expense_date: '2026-07-08', merchant: 'Cafe, KL', amount: 12.5, currency: 'MYR',
      category: 'Meals & Entertainment', branch_id: 'b1', staff_user_id: 's1', payment_status: 'paid',
      receipt_url: 'default/r1.png',
    },
  ]);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'Date,Merchant,Amount,Currency,Category,Branch,Staff,Status,Receipt URL');
  assert.strictEqual(lines[1], '2026-07-08,"Cafe, KL",12.5,MYR,Meals & Entertainment,b1,s1,paid,/api/receipt/by-id/e1');
});

test('rowsToCSV: a formula-like merchant name is neutralised (defense in depth for a re-imported export)', () => {
  const csv = rowsToCSV([{ expense_date: '2026-07-08', merchant: '=cmd|/c calc', category: '', amount: 1, remark: '' }]);
  assert.ok(csv.includes("'=cmd|/c calc"));
});

test('rowsToCSV: empty input -> header row only; garbage input never throws', () => {
  const header = 'Date,Merchant,Amount,Currency,Category,Branch,Staff,Status,Receipt URL';
  assert.strictEqual(rowsToCSV([]), header);
  assert.strictEqual(rowsToCSV(null), header);
});

test('blankTemplateCSV: exactly the header row, matching rowsToCSV\'s own header', () => {
  assert.strictEqual(blankTemplateCSV(), 'Date,Merchant,Category,Amount,Remark');
});

// --- Petty Cash Statement export moved into the Data editor toolbar (C1) ---

test('statementExportUrl: builds the existing statement route query for xlsx/pdf', () => {
  assert.strictEqual(statementExportUrl({ period: '2026-07', format: 'xlsx', branch: 'all' }), '/api/statement?period=2026-07&format=xlsx&branch=all');
  assert.strictEqual(statementExportUrl({ period: '2026-07', format: 'pdf', branch: 'bA' }), '/api/statement?period=2026-07&format=pdf&branch=bA');
});

test('statementExportUrl: clerk/own-branch path omits branch so the server hard-forces scope', () => {
  assert.strictEqual(statementExportUrl({ period: '2026-07', format: 'pdf', branch: '' }), '/api/statement?period=2026-07&format=pdf');
});

test('statementBranchOptions: admin gets All + My uploads + branch ids from loaded rows', () => {
  const opts = statementBranchOptions([
    { branch_id: 'bA' }, { branch_id: 'bB' }, { branch_id: 'bA' }, { branch_id: null },
  ], { role: 'admin', branch_id: 'bHQ' });
  assert.deepStrictEqual(opts.map((o) => [o.value, o.label]), [
    ['all', 'All branches'],
    ['bHQ', 'My uploads'],
    ['bA', 'Branch bA'],
    ['bB', 'Branch bB'],
  ]);
});

test('statementBranchOptions: clerk gets no branch picker options', () => {
  assert.deepStrictEqual(statementBranchOptions([{ branch_id: 'bA' }], { role: 'clerk', branch_id: 'bA' }), []);
});

// --- Export menu trimmed (QA 2026-07-13, Untitled document.md): keep ONLY Export Excel +
// Statement PDF; remove Export CSV / Export PDF (with receipts) / Export template / Statement
// Excel. The kept buttons' FORMAT must stay 'xlsx'/'pdf' so the actual export output is
// unchanged (the Owner's explicit constraint). These pure descriptors are the single source
// of truth the toolbar builds from, so this locks the button set against a silent re-add. ---

test('managedExportButtons: exactly one button — Export Excel wired to the unchanged xlsx format', () => {
  assert.deepStrictEqual(managedExportButtons(), [{ label: 'Export Excel', format: 'xlsx' }]);
});

test('statementExportButtons: exactly one button — Statement PDF wired to the unchanged pdf format', () => {
  assert.deepStrictEqual(statementExportButtons(), [{ label: 'Statement PDF', format: 'pdf' }]);
});

test('export button set contains NONE of the four removed options', () => {
  const labels = managedExportButtons().concat(statementExportButtons()).map((b) => b.label);
  ['Export CSV', 'Export PDF (with receipts)', 'Export template', 'Statement Excel'].forEach((gone) => {
    assert.ok(labels.indexOf(gone) === -1, gone + ' must no longer be offered');
  });
  assert.deepStrictEqual(labels, ['Export Excel', 'Statement PDF']);
});

// --- Edit Mode visual cue (QA 2026-07-13): the ledger table gets an `is-editing` hook class
// while Edit cells is on, so CSS can green the editable columns; off = plain. ---

test('ledgerTableClass: adds the is-editing hook only while editing', () => {
  assert.strictEqual(ledgerTableClass(true), 'ledger-table is-editing');
  assert.strictEqual(ledgerTableClass(false), 'ledger-table');
});
