'use strict';
/**
 * Expense reports (#8) — aggregate expenses into day/week/month/year buckets.
 * Pure + I/O-free so it's fully unit-testable; the route (routes/reports.js) supplies rows.
 *
 * buildReport(expenses, period, { from, to }) ->
 *   { period, from, to, total, count, buckets: [{ key, total, count, byCategory }] }  (buckets sorted asc)
 *
 * Amounts are summed as stored (already normalized to the account currency by #10 at ingestion).
 */

const PERIODS = new Set(['day', 'week', 'month', 'year']);
// Strict ISO date: correct shape AND a real calendar date (rejects 2026-13-45, 2026-02-30, etc.).
function isISO(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}
const round2 = v => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

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

function buildReport(expenses, period, opts = {}) {
  period = PERIODS.has(period) ? period : 'month';
  const from = isISO(opts.from) ? opts.from : null;
  const to = isISO(opts.to) ? opts.to : null;

  const map = new Map();
  let total = 0, count = 0;

  for (const e of (Array.isArray(expenses) ? expenses : [])) {
    if (e && e.deleted_at) continue;
    const date = String((e && e.expense_date) || '');
    if (!isISO(date)) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;

    const amt = Number(e.amount) || 0;
    const cat = e.category || 'Others';
    const key = bucketKey(date, period);

    let b = map.get(key);
    if (!b) { b = { key, total: 0, count: 0, byCategory: {} }; map.set(key, b); }
    b.total = round2(b.total + amt);
    b.count += 1;
    b.byCategory[cat] = round2((b.byCategory[cat] || 0) + amt);

    total = round2(total + amt);
    count += 1;
  }

  const buckets = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { period, from, to, total: round2(total), count, buckets };
}

module.exports = { buildReport };
