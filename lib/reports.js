'use strict';
/**
 * Expense reports (#8) — aggregate expenses into day/week/month/year buckets.
 * Pure + I/O-free so it's fully unit-testable; the route (routes/reports.js) supplies rows.
 *
 * buildReport(expenses, period, { from, to }) ->
 *   { period, from, to, total, count, buckets: [{ key, total, count, byCategory, byCategoryCount }] }  (buckets sorted asc)
 *
 * Amounts are summed as stored (already normalized to the account currency by #10 at ingestion).
 */

const PERIODS = new Set(['day', 'week', 'month', 'year']);
const { splitExpenseAmounts } = require('./statement');
// Strict ISO date: correct shape AND a real calendar date (rejects 2026-13-45, 2026-02-30, etc.).
function isISO(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}
const round2 = v => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;
// Strict amount coercion: only a real finite number or a numeric string counts as
// money. `Number(x) || 0` would silently turn booleans/arrays into fake amounts
// (Number(true)===1) and let Infinity poison every downstream sum — reject instead.
function toAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ISO-8601 week key 'YYYY-Www' (week belongs to the year of its Thursday).
function isoWeekKey(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;               // Mon=1..Sun=7
  dt.setUTCDate(dt.getUTCDate() + 4 - day);      // shift to the Thursday of this week
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return dt.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function bucketKey(iso, period) {
  if (period === 'year') return iso.slice(0, 4);
  if (period === 'month') return iso.slice(0, 7);
  if (period === 'week') return isoWeekKey(iso);
  return iso; // day
}

// Optional master-view grouping dimension (Phase 3): sum the same in-window rows by branch or
// staff, so the admin can see per-branch/per-staff totals and drill down. The dimension maps to a
// column; a row with no value there (e.g. an untagged/personal row) lands in the 'unassigned'
// group. sum(groups.total) == report.total by construction (same loop, same filters).
const GROUP_FIELD = { branch: 'branch_id', staff: 'staff_user_id', company: 'company_id' };

function buildReport(expenses, period, opts = {}) {
  period = PERIODS.has(period) ? period : 'month';
  const from = isISO(opts.from) ? opts.from : null;
  const to = isISO(opts.to) ? opts.to : null;
  const groupField = GROUP_FIELD[opts.groupBy] || null;
  // Drill-down / scope filters: a branch/staff value restricts the report to rows in that
  // branch/staff. A clerk's route forces `branch` = their own branch_id (hard scope); admin
  // drill-down passes them optionally. Compared as strings so uuid/text both match.
  const branchFilter = (opts.branch != null && opts.branch !== '') ? String(opts.branch) : null;
  const staffFilter = (opts.staff != null && opts.staff !== '') ? String(opts.staff) : null;
  // ADR-023 Phase 8: an admin can drill into one company; a clerk is already hard-scoped by branch
  // (which sits inside a company) so no clerk-side company filter is needed.
  const companyFilter = (opts.company != null && opts.company !== '') ? String(opts.company) : null;

  const map = new Map();
  const groupMap = groupField ? new Map() : null;
  let total = 0, count = 0;

  for (const e of (Array.isArray(expenses) ? expenses : [])) {
    if (e && e.deleted_at) continue;
    const date = String((e && e.expense_date) || '');
    if (!isISO(date)) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (branchFilter && String(e.branch_id == null ? '' : e.branch_id) !== branchFilter) continue;
    if (staffFilter && String(e.staff_user_id == null ? '' : e.staff_user_id) !== staffFilter) continue;
    if (companyFilter && String(e.company_id == null ? '' : e.company_id) !== companyFilter) continue;

    const amt = toAmount(e.amount);
    if (amt === null) continue; // malformed amount -> exclude the record entirely, don't fake a $0/$1/Infinity contribution
    const key = bucketKey(date, period);

    let b = map.get(key);
    if (!b) { b = { key, total: 0, count: 0, byCategory: {}, byCategoryCount: {} }; map.set(key, b); }
    b.total = round2(b.total + amt);
    b.count += 1;
    const portions = splitExpenseAmounts(e, opts.categories);
    for (const portion of portions) {
      const cat = portion.category || 'Others';
      b.byCategory[cat] = round2((b.byCategory[cat] || 0) + portion.amount);
      b.byCategoryCount[cat] = (b.byCategoryCount[cat] || 0) + 1;
    }

    if (groupMap) {
      const gk = (e[groupField] == null || e[groupField] === '') ? 'unassigned' : String(e[groupField]);
      let g = groupMap.get(gk);
      if (!g) { g = { key: gk, total: 0, count: 0 }; groupMap.set(gk, g); }
      g.total = round2(g.total + amt);
      g.count += 1;
    }

    total = round2(total + amt);
    count += 1;
  }

  const buckets = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const report = { period, from, to, total: round2(total), count, buckets };
  if (groupMap) {
    // largest spender first; ties broken by key for a stable order.
    report.groups = [...groupMap.values()].sort((a, b) => (b.total - a.total) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return report;
}

module.exports = { buildReport, toAmount, isISO };
