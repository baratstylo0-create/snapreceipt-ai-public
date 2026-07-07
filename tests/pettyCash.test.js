'use strict';
// lib/pettyCash.js — the Phase 9 petty-cash MATHS (ADR-023, spec §6). PURE layer only here:
// computeBalance (cashInHand / expenditure / balance) and computeClaims (which expenses are
// reimbursement claims). Claim status is COMPUTED, never stored, so it can't drift from the
// numbers. These are the assertions the whole deliverable rests on — the client's own spreadsheet
// got the sign wrong (float 3000, spend 2924.91 → they showed a −75.09 "claim"; the truth is a
// +75.09 SURPLUS and ZERO claims). That exact case is the first test below and must never regress.
const test = require('node:test');
const assert = require('node:assert');
const { computeBalance, computeClaims } = require('../lib/pettyCash');

// small helper: an expense row as the pure layer sees it
const exp = (id, amount, date, created_at, claim_override) =>
  ({ id, amount, expense_date: date, created_at: created_at || (date + 'T00:00:00Z'), claim_override: claim_override || null });

// ---- computeBalance ---------------------------------------------------------

test('THE canonical case: float 3000, spend 2924.91 → balance +75.09 (surplus), ZERO claims', () => {
  // amounts chosen to force float drift (10.10 + 20.20 = 30.299999… in IEEE-754) so the round2
  // idiom is actually exercised, exactly the arithmetic the client sheet fumbled.
  const expenses = [exp('e1', 10.10, '2026-07-01'), exp('e2', 20.20, '2026-07-02'), exp('e3', 2894.61, '2026-07-03')];
  const bal = computeBalance({ balanceBf: 3000, cashIn: [], expenses });
  assert.strictEqual(bal.cashInHand, 3000);
  assert.strictEqual(bal.expenditure, 2924.91);
  assert.strictEqual(bal.balance, 75.09, 'positive = surplus, NOT a claim');
  const claims = computeClaims({ cashInHand: bal.cashInHand, expenses });
  assert.deepStrictEqual(claims.claimIds, [], 'a surplus month has zero claims');
  assert.strictEqual(claims.claimTotal, 0);
});

test('cash_in top-ups add to cashInHand', () => {
  const bal = computeBalance({ balanceBf: 1000, cashIn: [{ amount: 200 }, { amount: 300 }], expenses: [{ amount: 400 }] });
  assert.strictEqual(bal.cashInHand, 1500);
  assert.strictEqual(bal.expenditure, 400);
  assert.strictEqual(bal.balance, 1100);
});

test('exact-zero balance is still NO claim (strictly > cashInHand crosses)', () => {
  const expenses = [exp('e1', 500, '2026-07-01'), exp('e2', 500, '2026-07-02')];
  const bal = computeBalance({ balanceBf: 1000, cashIn: [], expenses });
  assert.strictEqual(bal.balance, 0);
  const claims = computeClaims({ cashInHand: bal.cashInHand, expenses });
  assert.deepStrictEqual(claims.claimIds, [], 'spending the float exactly to zero is not overspending');
  assert.strictEqual(claims.claimTotal, 0);
});

test('overspent → negative balance (negative = overspent, per spec sign rule)', () => {
  const bal = computeBalance({ balanceBf: 100, cashIn: [], expenses: [{ amount: 150 }] });
  assert.strictEqual(bal.balance, -50);
});

test('empty month → balance = float, expenditure 0, no excluded', () => {
  const bal = computeBalance({ balanceBf: 500, cashIn: [], expenses: [] });
  assert.strictEqual(bal.cashInHand, 500);
  assert.strictEqual(bal.expenditure, 0);
  assert.strictEqual(bal.balance, 500);
  assert.strictEqual(bal.excluded, 0);
});

test('garbage amounts contribute 0 and are counted as excluded (spec §6)', () => {
  const expenses = [{ amount: 100 }, { amount: NaN }, { amount: 'oops' }, { amount: 50 }, { amount: undefined }, { amount: Infinity }];
  const bal = computeBalance({ balanceBf: 0, cashIn: [], expenses });
  assert.strictEqual(bal.expenditure, 150, 'only the two finite amounts count');
  assert.strictEqual(bal.excluded, 4, 'NaN, "oops", undefined, Infinity are excluded');
});

test('non-finite balanceBf is treated as 0', () => {
  const bal = computeBalance({ balanceBf: NaN, cashIn: [], expenses: [{ amount: 10 }] });
  assert.strictEqual(bal.cashInHand, 0);
  assert.strictEqual(bal.balance, -10);
});

// ---- computeClaims ----------------------------------------------------------

test('over-budget: the crossing expense AND everything after it are claims', () => {
  // cashInHand 100; 60 (fits), 60 (running 120 > 100 → crossing, claim for its FULL amount), 60 (claim).
  const expenses = [exp('e1', 60, '2026-07-01'), exp('e2', 60, '2026-07-02'), exp('e3', 60, '2026-07-03')];
  const { claimIds, claimTotal } = computeClaims({ cashInHand: 100, expenses });
  assert.deepStrictEqual(claimIds, ['e2', 'e3']);
  assert.strictEqual(claimTotal, 120, 'crossing expense claimed in full + all after');
});

test('missing float (cashInHand 0) → every expense is a claim', () => {
  const expenses = [exp('e1', 50, '2026-07-01'), exp('e2', 30, '2026-07-02')];
  const { claimIds, claimTotal } = computeClaims({ cashInHand: 0, expenses });
  assert.deepStrictEqual(claimIds, ['e1', 'e2']);
  assert.strictEqual(claimTotal, 80);
});

test('claim_override="claim" forces a within-float expense INTO the claim set', () => {
  const expenses = [exp('e1', 300, '2026-07-01', null, 'claim'), exp('e2', 300, '2026-07-02')];
  const { claimIds, claimTotal } = computeClaims({ cashInHand: 1000, expenses });
  assert.deepStrictEqual(claimIds, ['e1'], 'override beats the computed petty-cash result');
  assert.strictEqual(claimTotal, 300);
});

test('claim_override="petty_cash" forces an over-float expense OUT of the claim set', () => {
  const expenses = [exp('e1', 60, '2026-07-01'), exp('e2', 60, '2026-07-02', null, 'petty_cash')];
  const { claimIds, claimTotal } = computeClaims({ cashInHand: 100, expenses });
  assert.deepStrictEqual(claimIds, [], 'the pinned row is kept out even though it crossed the float');
  assert.strictEqual(claimTotal, 0);
});

test('deterministic regardless of input order (sorted by expense_date, tie-break created_at)', () => {
  const e1 = exp('e1', 60, '2026-07-01', '2026-07-01T09:00:00Z');
  const e2 = exp('e2', 60, '2026-07-02', '2026-07-02T09:00:00Z');
  const e3 = exp('e3', 60, '2026-07-03', '2026-07-03T09:00:00Z');
  const forward = computeClaims({ cashInHand: 100, expenses: [e1, e2, e3] });
  const shuffled = computeClaims({ cashInHand: 100, expenses: [e3, e1, e2] });
  assert.deepStrictEqual(forward.claimIds, ['e2', 'e3']);
  assert.deepStrictEqual(shuffled.claimIds, forward.claimIds, 'shuffling the input must not change the result');
  assert.strictEqual(shuffled.claimTotal, forward.claimTotal);
});

test('same-date rows break the tie on created_at, deterministically', () => {
  const early = exp('e1', 60, '2026-07-01', '2026-07-01T08:00:00Z');
  const late = exp('e2', 60, '2026-07-01', '2026-07-01T18:00:00Z');
  const { claimIds } = computeClaims({ cashInHand: 100, expenses: [late, early] });
  assert.deepStrictEqual(claimIds, ['e2'], 'the later same-day expense is the one that crosses the float');
});
