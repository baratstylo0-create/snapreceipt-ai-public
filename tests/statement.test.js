'use strict';
// lib/statement.js — Phase 10 (ADR-023/024, spec §2/§3/§6). The PURE StatementModel builder that
// both renderers (xlsx + pdf) consume. No I/O: the route feeds it rows. This is where the layout
// LOGIC lives — Section A (cash-in), Section B (expenses grouped by the company's category set with
// per-category subtotals + pad rows), the footer balance (SIGN RULE §6), claims passthrough. The
// canonical +75.09 surplus / zero-claim case is re-asserted here at the model level.
const test = require('node:test');
const assert = require('node:assert');
const { buildStatementModel } = require('../lib/statement');

const base = {
  companyName: 'Placeholder Trading Sdn Bhd',
  branchLabel: 'HQ',
  preparedBy: 'Aisha',
  period: '2025-10',
  categories: ['Tickets', 'Hotel', 'Food', 'Others', 'Hardware'],
  currency: 'MYR',
  showStaffColumn: false,
  balanceBf: 3000,
  cashIn: [],
  expenses: [],
  staffNames: {},
  signoff: { prepared: true, checked: false, approved: true },
};
const exp = (id, amount, category, date, extra) =>
  Object.assign({ id, amount, category, expense_date: date, created_at: (date || '') + 'T00:00:00Z', merchant: 'M-' + id }, extra || {});

test('static header fields + periodLabel formatting (YYYY-MM -> MONTH YEAR)', () => {
  const m = buildStatementModel(base);
  assert.strictEqual(m.title, 'PETTY CASH MONTHLY STATEMENT OF ACCOUNT');
  assert.strictEqual(m.companyName, 'Placeholder Trading Sdn Bhd');
  assert.strictEqual(m.periodLabel, 'OCTOBER 2025');
  assert.strictEqual(m.branchLabel, 'HQ');
  assert.strictEqual(m.preparedBy, 'Aisha');
  assert.strictEqual(m.currency, 'MYR');
});

test('THE canonical case at model level: float 3000, spend 2924.91 -> balance +75.09, ZERO claims', () => {
  const expenses = [
    exp('e1', 10.10, 'Food', '2025-10-01'),
    exp('e2', 20.20, 'Tickets', '2025-10-02'),
    exp('e3', 2894.61, 'Hotel', '2025-10-03'),
  ];
  const m = buildStatementModel({ ...base, expenses });
  assert.strictEqual(m.footer.cashInHand, 3000);
  assert.strictEqual(m.footer.expenditure, 2924.91);
  assert.strictEqual(m.footer.balance, 75.09, 'positive = surplus (correct accounting, §6)');
  assert.deepStrictEqual(m.claims.ids, []);
  assert.strictEqual(m.claims.total, 0);
});

test('Section A: Balance B/F is the first row, then cash-in top-ups; total = cashInHand', () => {
  const m = buildStatementModel({ ...base, balanceBf: 1000, cashIn: [{ date: '2025-10-05', description: 'Top up', amount: 500 }] });
  assert.strictEqual(m.sectionA.rows[0].description, 'Balance B/F');
  assert.strictEqual(m.sectionA.rows[0].amount, 1000);
  assert.strictEqual(m.sectionA.rows[1].description, 'Top up');
  assert.strictEqual(m.sectionA.total, 1500);
  assert.strictEqual(m.footer.cashInHand, 1500);
});

test('Section B: categories numbered 1..N in FieldSpec order; expenses land in their category', () => {
  const expenses = [exp('e1', 50, 'Food', '2025-10-01'), exp('e2', 30, 'Tickets', '2025-10-02')];
  const m = buildStatementModel({ ...base, expenses });
  const cats = m.sectionB.categories;
  assert.deepStrictEqual(cats.map((c) => c.n), [1, 2]);
  assert.deepStrictEqual(cats.map((c) => c.name), ['Tickets', 'Food']);
  const tickets = cats.find((c) => c.name === 'Tickets');
  assert.strictEqual(tickets.rows.length, 1);
  assert.strictEqual(tickets.rows[0].amount, 30);
  assert.strictEqual(tickets.rows[0].i, 1, 'per-category item index is 1-based');
  assert.strictEqual(tickets.subtotal, 30);
});

test('empty categories are omitted — a blank category block is not useful to an auditor', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('e1', 50, 'Food', '2025-10-01')] });
  const hardware = m.sectionB.categories.find((c) => c.name === 'Hardware');
  assert.strictEqual(hardware, undefined, 'empty category sections are omitted');
});

test('unknown category falls into Others', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('e1', 12, 'Mystery Spend', '2025-10-01')] });
  const others = m.sectionB.categories.find((c) => c.name === 'Others');
  assert.strictEqual(others.rows.length, 1);
  assert.strictEqual(others.rows[0].amount, 12);
});

test('unknown category creates an Others bucket even when FieldSpec lacks one', () => {
  const m = buildStatementModel({ ...base, categories: ['Tickets', 'Hotel'], expenses: [exp('e1', 9, 'Weird', '2025-10-01')] });
  const others = m.sectionB.categories.find((c) => c.name === 'Others');
  assert.ok(others, 'Others is appended so no expense is ever dropped');
  assert.strictEqual(others.rows[0].amount, 9);
});

test('overall Section B subtotal = expenditure', () => {
  const expenses = [exp('e1', 50, 'Food', '2025-10-01'), exp('e2', 30.50, 'Tickets', '2025-10-02'), exp('e3', 19.50, 'Food', '2025-10-03')];
  const m = buildStatementModel({ ...base, expenses });
  assert.strictEqual(m.sectionB.subtotal, 100);
  assert.strictEqual(m.footer.expenditure, 100);
});

test('staff column toggle: rows carry staffName resolved from the map when shown', () => {
  const expenses = [exp('e1', 50, 'Food', '2025-10-01', { staff_user_id: 'u1' })];
  const on = buildStatementModel({ ...base, showStaffColumn: true, staffNames: { u1: 'Farid' }, expenses });
  assert.strictEqual(on.showStaffColumn, true);
  assert.strictEqual(on.sectionB.categories.find((c) => c.name === 'Food').rows[0].staffName, 'Farid');
});

test('branch column toggle (all-branches export): rows carry branchLabel resolved from the map when shown', () => {
  const expenses = [exp('e1', 50, 'Food', '2025-10-01', { branch_id: 'bA' })];
  const off = buildStatementModel({ ...base, expenses });
  assert.strictEqual(off.showBranchColumn, false);
  assert.strictEqual(off.sectionB.categories.find((c) => c.name === 'Food').rows[0].branchLabel, undefined);

  const on = buildStatementModel({ ...base, showBranchColumn: true, branchNames: { bA: 'KL Branch' }, expenses });
  assert.strictEqual(on.showBranchColumn, true);
  assert.strictEqual(on.sectionB.categories.find((c) => c.name === 'Food').rows[0].branchLabel, 'KL Branch');
});

test('branch column: an unknown branch id falls back to the raw id, never blank/undefined text', () => {
  const expenses = [exp('e1', 50, 'Food', '2025-10-01', { branch_id: 'bZ' })];
  const on = buildStatementModel({ ...base, showBranchColumn: true, branchNames: {}, expenses });
  assert.strictEqual(on.sectionB.categories.find((c) => c.name === 'Food').rows[0].branchLabel, 'bZ');
});

test('second currency: amount2 rows + total2 present only when currency2 is set', () => {
  const m = buildStatementModel({
    ...base, currency2: 'INR', balanceBf: 1000, balanceBf2: 18000,
    cashIn: [{ description: 'Top up', amount: 500, amount2: 9000 }],
    expenses: [exp('e1', 200, 'Food', '2025-10-01', { amount2: 3600 })],
  });
  assert.strictEqual(m.currency2, 'INR');
  assert.strictEqual(m.sectionA.total2, 27000, 'B/F 18000 + top-up 9000');
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Food').rows[0].amount2, 3600);
});

test('claims passthrough: an overspent month lists the claim ids/total (from lib/pettyCash)', () => {
  const expenses = [exp('e1', 2000, 'Food', '2025-10-01'), exp('e2', 2000, 'Hotel', '2025-10-02')];
  const m = buildStatementModel({ ...base, balanceBf: 3000, expenses });
  assert.strictEqual(m.footer.balance, -1000, 'negative = overspent = claim');
  assert.deepStrictEqual(m.claims.ids, ['e2'], 'the crossing expense is the claim');
  assert.strictEqual(m.claims.total, 2000);
});

test('deterministic: shuffled expenses produce the same row order within a category', () => {
  const a = exp('e1', 10, 'Food', '2025-10-01');
  const b = exp('e2', 20, 'Food', '2025-10-02');
  const c = exp('e3', 30, 'Food', '2025-10-03');
  const forward = buildStatementModel({ ...base, expenses: [a, b, c] });
  const shuffled = buildStatementModel({ ...base, expenses: [c, a, b] });
  const ids = (m) => m.sectionB.categories.find((x) => x.name === 'Food').rows.map((r) => r.expenseId);
  assert.deepStrictEqual(ids(forward), ['e1', 'e2', 'e3']);
  assert.deepStrictEqual(ids(shuffled), ids(forward));
});

test('sign-off block reflects per-company config (prepared/checked/approved)', () => {
  const m = buildStatementModel({ ...base, signoff: { prepared: true, checked: false, approved: true } });
  assert.deepStrictEqual(m.signoff, { prepared: true, checked: false, approved: true });
});

test('line-item split: two categories receive their item amounts and voucher suffixes', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('mix-2', 80, 'Food', '2025-10-04', {
    voucher_no: 'RC-42', line_items: [
      { description: 'Lunch', amount: 50, category: 'Food' },
      { description: 'Fuel', amount: 30, category: 'Tickets' },
    ],
  })] });
  const food = m.sectionB.categories.find((c) => c.name === 'Food');
  const tickets = m.sectionB.categories.find((c) => c.name === 'Tickets');
  assert.strictEqual(food.subtotal, 50);
  assert.strictEqual(tickets.subtotal, 30);
  assert.match(food.rows[0].description, /RC-42 \(1\/2\)/);
  assert.match(tickets.rows[0].description, /RC-42 \(2\/2\)/);
  assert.strictEqual(m.sectionB.subtotal, 80);
});

test('line-item split: three categories and fx-scaled decimal items reconcile exactly', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('mix-3', 100, 'Food', '2025-10-04', {
    line_items: [
      { amount: 33.33, category: 'Food' },
      { amount: 33.33, category: 'Tickets' },
      { amount: 33.34, category: 'Hotel' },
    ],
  })] });
  assert.deepStrictEqual(
    ['Food', 'Tickets', 'Hotel'].map((name) => m.sectionB.categories.find((c) => c.name === name).subtotal),
    [33.33, 33.33, 33.34],
  );
  assert.strictEqual(m.sectionB.subtotal, 100);
});

test('line-item split: single-category and empty-line_items receipts remain unchanged', () => {
  const m = buildStatementModel({ ...base, expenses: [
    exp('single', 12, 'Food', '2025-10-01', { voucher_no: 'S-1', line_items: [{ amount: 12, category: 'Food' }] }),
    exp('empty', 9, 'Tickets', '2025-10-02', { voucher_no: 'E-1', line_items: [] }),
  ] });
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Food').rows[0].description, 'M-single');
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Food').subtotal, 12);
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Tickets').rows[0].description, 'M-empty');
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Tickets').subtotal, 9);
});

test('line-item split: rounding remainder goes to the largest item category', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('round', 80, 'Food', '2025-10-04', {
    line_items: [{ amount: 50.01, category: 'Food' }, { amount: 29.98, category: 'Tickets' }],
  })] });
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Food').subtotal, 50.02);
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Tickets').subtotal, 29.98);
});

test('line-item split: off-template and missing categories fall back to the rolled-up category', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('fallback', 80, 'Tickets', '2025-10-04', {
    line_items: [{ amount: 50, category: 'Food' }, { amount: 20, category: 'Not in template' }, { amount: 10 }],
  })] });
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Food').subtotal, 50);
  assert.strictEqual(m.sectionB.categories.find((c) => c.name === 'Tickets').subtotal, 30);
  assert.strictEqual(m.sectionB.subtotal, 80);
});

test('empty category sections are omitted once no expense contributes to them', () => {
  const m = buildStatementModel({ ...base, expenses: [exp('only', 5, 'Food', '2025-10-01')] });
  assert.deepStrictEqual(m.sectionB.categories.map((c) => c.name), ['Food']);
});
