'use strict';
// components/payments.js Phase 6 (ADR-021): the payment Pending/Paid tabs' pure logic —
// tab/month/branch/staff filtering and the sticky selection summary (count + money total).
// Phase 7 (ADR-022) adds the Send-to-Admin pure logic: the admin's submissions status line
// and the clerk's send-button state. Node-testable, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const {
  filterRows,
  selectionSummary,
  submissionStatusLine,
  clerkSendState,
  statementReady,
  statementUrl,
  statementExportRows,
  optionModels,
  staffNameMapFromResponses,
  statementBranchRequiredMessage,
} = require('../../public/js/components/payments');

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

// --- ADR-022 Phase 7: Send-to-Admin pure logic ---

test('submissionStatusLine: none -> friendly empty line; submitted branches listed by name', () => {
  assert.strictEqual(submissionStatusLine([], {}), 'No branch submissions yet.');
  assert.strictEqual(submissionStatusLine(null, {}), 'No branch submissions yet.');
  const line = submissionStatusLine(
    [{ branch_id: 'bA', status: 'submitted' }, { branch_id: 'bB', status: 'submitted' }],
    { bA: 'KL Branch', bB: 'Penang' }
  );
  assert.strictEqual(line, '2 submitted · KL Branch, Penang');
});

test('submissionStatusLine: withdrawn rows are excluded; unknown branch falls back to the id', () => {
  const line = submissionStatusLine(
    [{ branch_id: 'bA', status: 'submitted' }, { branch_id: 'bB', status: 'withdrawn' }],
    {}
  );
  assert.strictEqual(line, '1 submitted · bA');
});

test('clerkSendState: no month picked -> disabled with a reason', () => {
  const s = clerkSendState({ month: '', submission: null });
  assert.strictEqual(s.canSend, false);
  assert.ok(s.reason && /month/i.test(s.reason));
});

test('clerkSendState: month picked, never sent -> Send; already submitted -> Re-send + withdrawable', () => {
  const fresh = clerkSendState({ month: '2026-07', submission: null });
  assert.deepStrictEqual({ canSend: fresh.canSend, label: fresh.label, withdrawable: fresh.withdrawable },
    { canSend: true, label: 'Send to Admin', withdrawable: false });

  const sent = clerkSendState({ month: '2026-07', submission: { id: 's1', status: 'submitted', submitted_at: '2026-07-07T00:00:00Z' } });
  assert.strictEqual(sent.canSend, true);
  assert.strictEqual(sent.label, 'Re-send to Admin');
  assert.strictEqual(sent.withdrawable, true);

  const withdrawn = clerkSendState({ month: '2026-07', submission: { id: 's1', status: 'withdrawn' } });
  assert.strictEqual(withdrawn.label, 'Send to Admin');
  assert.strictEqual(withdrawn.withdrawable, false);
});

// --- ADR-023/024 Phase 10 UI: Statement export pure logic ---

test('statementReady: clerk only needs a month; admin also needs a real branch', () => {
  assert.deepStrictEqual(statementReady({ month: '' }, false), { ok: false, reason: 'Pick a month first.' });
  assert.deepStrictEqual(statementReady({ month: '2026-07' }, false), { ok: true });
  assert.deepStrictEqual(statementReady({ month: '2026-07', branch: '' }, true), { ok: false, reason: statementBranchRequiredMessage });
  assert.deepStrictEqual(statementReady({ month: '2026-07', branch: 'unassigned' }, true), { ok: false, reason: statementBranchRequiredMessage });
  assert.deepStrictEqual(statementReady({ month: '2026-07', branch: 'bA' }, true), { ok: true });
});

test('optionModels: staff dropdown labels ids with staffNames but keeps id values', () => {
  assert.deepStrictEqual(
    optionModels('All staff', ['s1', 's2', 'unassigned'], { s1: 'Aisha Rahman', s2: 'Ben Tan' }),
    [
      { value: '', label: 'All staff' },
      { value: 's1', label: 'Aisha Rahman' },
      { value: 's2', label: 'Ben Tan' },
      { value: 'unassigned', label: 'Unassigned' },
    ]
  );
});

test('staffNameMapFromResponses: flattens branch staff responses into id -> display_name', () => {
  assert.deepStrictEqual(
    staffNameMapFromResponses([
      { staff: [{ id: 's1', display_name: 'Aisha Rahman' }] },
      { staff: [{ id: 's2', display_name: 'Ben Tan' }, { id: 's3', name: 'Legacy Name' }] },
      null,
    ]),
    { s1: 'Aisha Rahman', s2: 'Ben Tan', s3: 'Legacy Name' }
  );
});

test('statementUrl: builds period+format for a clerk, adds branch for an admin', () => {
  assert.strictEqual(
    statementUrl({ month: '2026-07', branch: 'bA' }, false, 'pdf'),
    '/api/statement?period=2026-07&format=pdf'
  );
  assert.strictEqual(
    statementUrl({ month: '2026-07', branch: 'bA' }, true, 'xlsx'),
    '/api/statement?period=2026-07&format=xlsx&branch=bA'
  );
});

test('statementExportRows: admin export data check follows statement month+branch, not the current paid/pending tab', () => {
  assert.deepStrictEqual(
    statementExportRows(ROWS, { month: '2026-07', branch: 'bA' }, true).map((r) => r.id),
    ['a', 'c']
  );
  assert.deepStrictEqual(
    statementExportRows(ROWS, { month: '2026-07', branch: 'bB' }, true),
    []
  );
});

test('statementExportRows: clerk export data check relies on already-scoped rows and only requires month', () => {
  assert.deepStrictEqual(
    statementExportRows(ROWS, { month: '2026-07' }, false).map((r) => r.id),
    ['a', 'c', 'd']
  );
});
