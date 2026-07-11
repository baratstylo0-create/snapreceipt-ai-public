'use strict';
// lib/statement.js — Phase 10 (ADR-023/024, spec §2/§3/§6). The PURE StatementModel builder that
// BOTH renderers (lib/statementXlsx.js + lib/statementPdf.js) consume. Data comes in via arguments
// only — NO I/O here (the route does the fetching), so the whole layout logic is unit-testable.
//
// It reuses Phase 9's pure maths (lib/pettyCash.js computeBalance/computeClaims) so the footer
// balance + claim set can never disagree with the petty-cash engine — the canonical +75.09
// surplus / zero-claim case is guaranteed identical at every layer.
const { computeBalance, computeClaims, round2 } = require('./pettyCash');

const TITLE = 'PETTY CASH MONTHLY STATEMENT OF ACCOUNT';
const OTHERS = 'Others';
const DEFAULT_PAD_ROWS = 2;
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// 'YYYY-MM' -> 'OCTOBER 2025'. Falls back to the raw string for anything unparseable.
function periodToLabel(period) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period || ''));
  if (!m) return String(period || '');
  return MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

// Deterministic within a category: expense_date asc, tie-break created_at, then id — a shuffled
// input can never reorder the statement (expense_date is TEXT/ISO, lexical sort is safe, gotcha #1).
function byDate(a, b) {
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

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// buildStatementModel(args) -> StatementModel (spec §2/Task 10.1). See tests/statement.test.js for
// the exact shape the renderers rely on.
function buildStatementModel({
  companyName, branchLabel, preparedBy, period,
  categories = [], cashIn = [], balanceBf = 0, balanceBf2,
  expenses = [], staffNames = {},
  showStaffColumn = false, currency = '', currency2,
  showBranchColumn = false, branchNames = {},
  signoff = { prepared: true, checked: false, approved: true },
  padRows = DEFAULT_PAD_ROWS,
} = {}) {
  const hasCur2 = currency2 != null && currency2 !== '';

  // ---- Section A (cash in): Balance B/F first, then the admin's top-ups ----
  const cashInList = Array.isArray(cashIn) ? cashIn : [];
  const sectionARows = [{ date: '', description: 'Balance B/F', amount: round2(balanceBf), amount2: hasCur2 ? round2(balanceBf2) : undefined }]
    .concat(cashInList.map((c) => ({
      date: (c && c.date) || '',
      description: (c && c.description) || 'Cash In',
      amount: round2(c && c.amount),
      amount2: hasCur2 ? round2(c && c.amount2) : undefined,
    })));
  const sectionATotal = round2(sectionARows.reduce((s, r) => s + num(r.amount), 0));
  const sectionATotal2 = hasCur2 ? round2(sectionARows.reduce((s, r) => s + num(r.amount2), 0)) : undefined;

  // ---- Section B (expenses grouped by the company's category set) ----------
  // Category blocks in FieldSpec order; guarantee an Others bucket so no expense is ever dropped.
  const catNames = (Array.isArray(categories) ? categories.slice() : []).map((c) => String(c));
  if (!catNames.some((c) => c.toLowerCase() === OTHERS.toLowerCase())) catNames.push(OTHERS);
  const othersName = catNames.find((c) => c.toLowerCase() === OTHERS.toLowerCase());

  const buckets = new Map(catNames.map((name) => [name, []]));
  for (const e of (Array.isArray(expenses) ? expenses : [])) {
    if (!e) continue;
    const cat = catNames.find((c) => c === e.category)
      || catNames.find((c) => c.toLowerCase() === String(e.category || '').toLowerCase())
      || othersName;
    buckets.get(cat).push(e);
  }

  let sectionBSubtotal = 0;
  const catModels = catNames.map((name, idx) => {
    const rows = buckets.get(name).slice().sort(byDate);
    let subtotal = 0;
    const rowModels = rows.map((e, i) => {
      const amount = round2(e.amount);
      subtotal = round2(subtotal + num(e.amount));
      return {
        i: i + 1,
        date: e.expense_date || '',
        staffName: showStaffColumn ? (staffNames[e.staff_user_id] || (e.staff_user_id != null ? String(e.staff_user_id) : '')) : undefined,
        branchLabel: showBranchColumn ? (branchNames[e.branch_id] || (e.branch_id != null ? String(e.branch_id) : '')) : undefined,
        description: e.merchant || e.description || e.remark || '',
        amount,
        amount2: hasCur2 ? round2(e.amount2) : undefined,
        expenseId: e.id,
      };
    });
    sectionBSubtotal = round2(sectionBSubtotal + subtotal);
    return { n: idx + 1, name, rows: rowModels, subtotal, padRows };
  });

  // ---- footer + claims (Phase 9 maths, so it can't drift) ------------------
  const bal = computeBalance({ balanceBf, cashIn: cashInList, expenses });
  const claims = computeClaims({ cashInHand: bal.cashInHand, expenses });

  return {
    companyName: companyName || '',
    title: TITLE,
    periodLabel: periodToLabel(period),
    branchLabel: branchLabel || '',
    preparedBy: preparedBy || '',
    sectionA: { rows: sectionARows, total: sectionATotal, total2: sectionATotal2 },
    sectionB: { categories: catModels, subtotal: sectionBSubtotal },
    footer: { cashInHand: bal.cashInHand, expenditure: bal.expenditure, balance: bal.balance },
    claims: { ids: claims.claimIds, total: claims.claimTotal },
    signoff: {
      prepared: !!signoff.prepared,
      checked: !!signoff.checked,
      approved: !!signoff.approved,
    },
    showStaffColumn: !!showStaffColumn,
    showBranchColumn: !!showBranchColumn,
    currency: currency || '',
    currency2: hasCur2 ? currency2 : undefined,
    excluded: bal.excluded,
  };
}

module.exports = { buildStatementModel, periodToLabel };
