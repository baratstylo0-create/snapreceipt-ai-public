'use strict';
// lib/pettyCash.js — Phase 9 petty-cash floats + claim engine (ADR-023, spec §6). The heart of
// the Premala deliverable. TWO layers, deliberately separated so the maths is unit-testable with
// zero I/O:
//   1. PURE functions (computeBalance / computeClaims) — no DB, no dates-from-now, fully
//      deterministic. This is where the correctness lives (see tests/pettyCash.test.js).
//   2. Thin DB wrappers (getPeriodSummary / upsertFloat / addCashIn / deleteCashIn) that fetch via
//      lib/supabase (import-only — Barat's file) and hand the rows to the pure layer.
//
// FROZEN RULES (spec §6 — do NOT re-derive):
//   cashInHand  = balance_bf + Σ cash_in            (non-finite contributes 0)
//   expenditure = Σ that branch/period's expenses   (non-finite contributes 0, counted as excluded)
//   balance     = cashInHand − expenditure          (POSITIVE = surplus/no-claim, NEGATIVE = overspent)
//   claim       = walk the period's expenses in expense_date order (tie-break created_at); once the
//                 running total EXCEEDS cashInHand, that expense (in FULL) and everything after it is
//                 a claim. Per-expense claim_override ('claim'|'petty_cash') beats the computed row.
// Claim status is COMPUTED ON READ, never stored, so it can never drift from the numbers.
const { sbSelect, sbInsertReturning, sbUpdate } = require('./supabase');
const { cfg } = require('./config');
const { hreq } = require('./http');

// Money rounding — the SAME idiom as lib/excel.js / lib/reports.js round2 (copy, don't diverge).
function round2(v) { return Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100; }
function finite(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---- pure layer (no I/O; exhaustively unit-tested) --------------------------

// computeBalance({ balanceBf, cashIn:[{amount}], expenses:[{amount}] })
//   -> { cashInHand, expenditure, balance, excluded }
// `excluded` = count of expense rows whose amount was non-finite (contributed 0) — surfaced so the
// route/statement can flag "N amounts couldn't be read" rather than silently under-counting.
function computeBalance({ balanceBf, cashIn = [], expenses = [] } = {}) {
  const bf = finite(balanceBf) == null ? 0 : Number(balanceBf);
  let cashInSum = 0;
  for (const c of Array.isArray(cashIn) ? cashIn : []) {
    const n = finite(c && c.amount);
    if (n != null) cashInSum = round2(cashInSum + n);
  }
  let expenditure = 0;
  let excluded = 0;
  for (const e of Array.isArray(expenses) ? expenses : []) {
    const n = finite(e && e.amount);
    if (n == null) { excluded += 1; continue; }
    expenditure = round2(expenditure + n);
  }
  const cashInHand = round2(bf + cashInSum);
  const balance = round2(cashInHand - expenditure);
  return { cashInHand, expenditure, balance, excluded };
}

// Deterministic order: expense_date asc, then created_at asc, then id asc (ISO strings sort
// lexically — safe, and never cast the TEXT expense_date column, gotcha #1). Total tie-break on id
// so a shuffled input can never change the result.
function claimOrder(a, b) {
  const ad = String((a && a.expense_date) || '');
  const bd = String((b && b.expense_date) || '');
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ac = String((a && a.created_at) || '');
  const bc = String((b && b.created_at) || '');
  if (ac !== bc) return ac < bc ? -1 : 1;
  const ai = String((a && a.id) || '');
  const bi = String((b && b.id) || '');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// computeClaims({ cashInHand, expenses:[{id, amount, expense_date, created_at, claim_override}] })
//   -> { claimIds:[...], claimTotal }
// The crossing expense is claimed for its FULL amount (simplest defensible rule — spec §6). Once
// crossed, the state latches on (everything after is a claim). A per-row claim_override then wins:
// 'claim' pins a within-float row IN, 'petty_cash' pins an over-float row OUT — the override never
// changes the running total (which tracks actual cash spent), only the final label of that row.
function computeClaims({ cashInHand, expenses = [] } = {}) {
  const cap = finite(cashInHand) == null ? 0 : Number(cashInHand);
  const sorted = (Array.isArray(expenses) ? expenses.slice() : []).sort(claimOrder);
  let running = 0;
  let crossed = false;
  const claimIds = [];
  let claimTotal = 0;
  for (const e of sorted) {
    const n = finite(e && e.amount);
    const amt = n == null ? 0 : n;
    running = round2(running + amt);
    if (!crossed && running > cap) crossed = true;
    let isClaim = crossed;
    const ov = e && e.claim_override;
    if (ov === 'claim') isClaim = true;
    else if (ov === 'petty_cash') isClaim = false;
    if (isClaim) { claimIds.push(e && e.id); claimTotal = round2(claimTotal + amt); }
  }
  return { claimIds, claimTotal };
}

// ---- thin DB wrappers (fetch, then call the pure layer) ---------------------
// sbSelect / sbInsertReturning / sbUpdate auto-inject account_id (managed-silo). Period filtering
// on expenses is a JS string-prefix compare because expense_date is TEXT (gotcha #1).

async function getPeriodSummary({ branchId, period }) {
  const floats = await sbSelect('petty_cash_floats', { eq: { branch_id: branchId, period }, limit: 1 });
  const float = floats[0] || null;
  const cashIn = await sbSelect('cash_in', { eq: { branch_id: branchId, period }, order: 'created_at.asc', limit: 1000 });
  const all = await sbSelect('expenses', { eq: { branch_id: branchId }, extra: 'deleted_at=is.null', order: 'expense_date.asc', limit: 5000 });
  const expenses = all.filter((e) => e && typeof e.expense_date === 'string' && e.expense_date.slice(0, 7) === period);
  const balanceBf = float ? float.balance_bf : 0;
  const { cashInHand, expenditure, balance, excluded } = computeBalance({ balanceBf, cashIn, expenses });
  const { claimIds, claimTotal } = computeClaims({ cashInHand, expenses });
  return { float, cashIn, cashInHand, expenditure, balance, excluded, claims: { ids: claimIds, total: claimTotal } };
}

// Upsert on (branch, period) via select-then-insert/update — there is no generic multi-eq update
// helper (gotcha #4), same shape as the submissions route.
async function upsertFloat({ branchId, period, balanceBf, currency, updatedBy }) {
  const patch = {
    balance_bf: balanceBf,
    currency: currency || null,
    updated_by: updatedBy || null,
    updated_at: new Date().toISOString(),
  };
  const existing = await sbSelect('petty_cash_floats', { eq: { branch_id: branchId, period }, limit: 1 });
  if (existing[0]) {
    const rows = await sbUpdate('petty_cash_floats', { id: existing[0].id }, patch);
    return rows[0] || { ...existing[0], ...patch };
  }
  return sbInsertReturning('petty_cash_floats', { branch_id: branchId, period, ...patch });
}

async function addCashIn({ branchId, period, date, description, amount, createdBy }) {
  return sbInsertReturning('cash_in', {
    branch_id: branchId,
    period,
    date: date || null,
    description: description || null,
    amount,
    created_by: createdBy || null,
  });
}

// Hard delete — this is a ledger the admin owns (no soft-delete column on cash_in). Account-scoped
// so one instance can never touch another's rows.
async function deleteCashIn(id) {
  const url = cfg.SB_REST + '/cash_in?id=eq.' + encodeURIComponent(id)
    + '&account_id=eq.' + encodeURIComponent(cfg.ACCOUNT_ID);
  await hreq({ method: 'DELETE', url, headers: { ...cfg.sbH, Prefer: 'return=minimal' }, json: true });
}

module.exports = {
  round2,
  computeBalance,
  computeClaims,
  getPeriodSummary,
  upsertFloat,
  addCashIn,
  deleteCashIn,
};
