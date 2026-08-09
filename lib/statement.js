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

// Resolve a category against the current template, case-insensitively. A line item whose
// category is not in that set falls back to the receipt's rolled-up category; this keeps every
// cent in the report even when OCR/categorisation returned a stale or off-template label.
function categoryInSet(value, names) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return names.find((name) => name === text)
    || names.find((name) => name.toLowerCase() === text.toLowerCase())
    || null;
}

// Return one money portion per category for a receipt. The stored line-item amounts are already
// FX-scaled, but we round each portion at the statement boundary and give any reconciliation
// remainder to the largest item (the deterministic rule in the line-item spec). An expense with
// no line items, or with no valid item category at all, deliberately takes the legacy whole-row
// path. `categories` is optional for reports/legacy callers; when present it is the allow-list.
function splitExpenseAmounts(expense, categories) {
  const e = expense || {};
  const names = Array.isArray(categories) && categories.length ? categories.map(String) : null;
  const fallback = names
    ? (categoryInSet(e.category, names) || categoryInSet(OTHERS, names) || names[0] || OTHERS)
    : (typeof e.category === 'string' && e.category.trim() ? e.category.trim() : OTHERS);
  const whole = round2(num(e.amount));
  const items = Array.isArray(e.line_items) ? e.line_items : [];
  if (!items.length) return [{ category: fallback, amount: whole, itemCount: 1 }];

  const parsed = items.map((item, index) => {
    const rawCategory = item && item.category;
    const category = names ? categoryInSet(rawCategory, names) : (typeof rawCategory === 'string' && rawCategory.trim() ? rawCategory.trim() : null);
    const rawAmount = num(item && item.amount);
    return { index, category, rawAmount, amount: round2(rawAmount) };
  });
  // Bug fix (2026-08-09, found via a real receipt): OCR's line-item extractor tags an
  // individual item 'Others' when it isn't confident enough to categorize THAT SPECIFIC
  // ITEM (see lib/ocr.js — stored with source:'fallback', confidence:0.3). That is not the
  // same thing as the receipt actually belonging to "Others" — the receipt's own
  // higher-confidence e.category (set from the merchant/whole-receipt read) is more
  // reliable. Before this fix, a receipt whose line items were ALL low-confidence
  // 'Others' silently overrode a correct receipt-level category like "Meals &
  // Entertainment" in every report/chart, with zero visible warning. Only treat 'Others'
  // as "no real signal" when EVERY item landed there — a genuine mix of real categories
  // + some Others items is still a meaningful split and keeps working as before.
  const hasRealCategory = parsed.some((item) => item.category && item.category !== OTHERS);
  if (!hasRealCategory) return [{ category: fallback, amount: whole, itemCount: 1 }];

  const byCategory = new Map();
  for (const item of parsed) {
    const category = item.category || fallback;
    const current = byCategory.get(category) || { category, amount: 0, largest: null, itemCount: 0 };
    current.amount = round2(current.amount + item.amount);
    current.itemCount += 1;
    if (!current.largest || Math.abs(item.rawAmount) > Math.abs(current.largest.rawAmount)) current.largest = item;
    byCategory.set(category, current);
  }
  const portions = [...byCategory.values()];
  // A valid line-item list that only names one category is still a normal single-category receipt.
  if (portions.length === 1) return [{ category: portions[0].category, amount: whole, itemCount: items.length }];

  const itemTotal = round2(portions.reduce((sum, part) => sum + part.amount, 0));
  const largest = parsed.reduce((best, item) => (!best || Math.abs(item.rawAmount) > Math.abs(best.rawAmount)) ? item : best, null);
  const remainder = round2(whole - itemTotal);
  if (largest && remainder !== 0) {
    const target = largest.category || fallback;
    const part = byCategory.get(target) || { category: target, amount: 0, largest, itemCount: 0 };
    part.amount = round2(part.amount + remainder);
    if (!byCategory.has(target)) byCategory.set(target, part);
  }
  return [...byCategory.values()]
    .filter((part) => part.amount !== 0 || whole === 0)
    .map((part) => ({ category: part.category, amount: round2(part.amount), itemCount: part.itemCount }));
}

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
  // title (2026-07-30, QA): overridable so callers outside the real petty-cash-statement
  // feature (routes/statement.js, which never passes this and keeps the exact original
  // "PETTY CASH MONTHLY STATEMENT OF ACCOUNT" title) can use this same evidence-pack
  // renderer for a plain personal export without showing business-only wording.
  title = TITLE,
  // showBranchLabel (2026-07-30, QA): distinct from showBranchColumn — that one controls
  // a per-ROW branch column in the expense table; this controls the document-level
  // "Branch: ..." header line + the "(branchLabel)" suffix on the Section B heading.
  // Defaults true (routes/statement.js's real single/all-branch statements never pass
  // this, so their existing behaviour is byte-for-byte unchanged); manageExport.js's
  // personal-export path is the only caller that sets it false, since `branchLabel` there
  // is a synthetic "Filtered rows"/"All branches" placeholder that means nothing on a
  // single-user personal account.
  showBranchLabel = true,
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
    const portions = splitExpenseAmounts(e, catNames);
    const mixed = portions.length > 1;
    portions.forEach((portion, portionIndex) => {
      const cat = categoryInSet(portion.category, catNames) || othersName;
      buckets.get(cat).push({ expense: e, portion, mixed, portionIndex, splitCount: portions.length });
    });
  }

  let sectionBSubtotal = 0;
  const catModels = catNames.map((name, idx) => {
    const rows = buckets.get(name).slice().sort((a, b) => byDate(a.expense, b.expense));
    let subtotal = 0;
    const rowModels = rows.map((entry, i) => {
      const e = entry.expense;
      const amount = round2(entry.portion.amount);
      subtotal = round2(subtotal + amount);
      const baseDescription = e.merchant || e.description || e.remark || '';
      const description = entry.mixed
        ? (baseDescription ? baseDescription + ' - ' : '') + (e.voucher_no || 'Receipt') + ' (' + (entry.portionIndex + 1) + '/' + entry.splitCount + ')'
        : baseDescription;
      return {
        i: i + 1,
        date: e.expense_date || '',
        staffName: showStaffColumn ? (staffNames[e.staff_user_id] || (e.staff_user_id != null ? String(e.staff_user_id) : '')) : undefined,
        branchLabel: showBranchColumn ? (branchNames[e.branch_id] || (e.branch_id != null ? String(e.branch_id) : '')) : undefined,
        description,
        baseDescription,
        voucherNo: e.voucher_no || '',
        amount,
        amount2: hasCur2 ? round2(e.amount2 == null ? 0 : (num(e.amount2) * (num(e.amount) ? amount / num(e.amount) : 0))) : undefined,
        expenseId: e.id,
        splitCategory: entry.mixed ? name : undefined,
        splitIndex: entry.mixed ? entry.portionIndex + 1 : undefined,
        splitCount: entry.mixed ? entry.splitCount : undefined,
      };
    });
    sectionBSubtotal = round2(sectionBSubtotal + subtotal);
    return { n: idx + 1, name, rows: rowModels, subtotal, padRows };
  }).filter((cat) => cat.rows.length > 0).map((cat, i) => ({ ...cat, n: i + 1 }));

  // ---- footer + claims (Phase 9 maths, so it can't drift) ------------------
  const bal = computeBalance({ balanceBf, cashIn: cashInList, expenses });
  const claims = computeClaims({ cashInHand: bal.cashInHand, expenses });

  return {
    companyName: companyName || '',
    title,
    showBranchLabel,
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

module.exports = { buildStatementModel, periodToLabel, splitExpenseAmounts };
