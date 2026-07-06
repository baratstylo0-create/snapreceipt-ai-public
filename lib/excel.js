'use strict';
// #2 Excel export — turns expenses into a real .xlsx workbook matching the
// customer's FieldSpec exactly (ARCHITECTURE §2). Pure + I/O-free (like
// lib/reports.js's buildReport) so it's fully unit-testable without touching
// Supabase or the filesystem; the route (routes/excel.js) supplies rows.
//
// buildWorkbook(expenses, fieldSpec) -> ExcelJS.Workbook
//   One worksheet. Header row = fieldSpec.columns[].label, in FieldSpec order
//   (the frozen contract: Excel emits columns in `label` order, ARCHITECTURE §3.1).
//   Canonical columns with a dedicated `expenses` table column (merchant,
//   expense_date, amount, currency, category, subtotal, tax, remark) read
//   straight off the row; any other FieldSpec key (a customer's own CSV
//   header, or the canonical-but-columnless "quantity") reads from
//   expense.ai_raw[key] instead (the raw OCR-extracted object, per the
//   existing #4/#12 convention). Never throws on a missing/malformed value —
//   blank cell instead, so one bad row can't fail the whole export.

const ExcelJS = require('exceljs');
const { toAmount } = require('./reports');

const DIRECT_KEYS = new Set([
  'merchant', 'expense_date', 'amount', 'currency', 'category', 'subtotal', 'tax', 'remark',
]);
const MAX_TEXT_LEN = 500;

function resolveRawValue(expense, key) {
  if (DIRECT_KEYS.has(key)) return expense[key];
  return (expense.ai_raw && typeof expense.ai_raw === 'object') ? expense.ai_raw[key] : undefined;
}

function cellValue(expense, column) {
  const raw = resolveRawValue(expense, column.key);
  if (raw === undefined || raw === null) return null;
  if (column.type === 'currency' || column.type === 'number') {
    return toAmount(raw); // strict coercion (same rule as #8) -> garbage/Infinity becomes null (blank cell)
  }
  return String(raw).slice(0, MAX_TEXT_LEN);
}

// Aggregate a plain total/count + per-category total/count, sorted by total
// descending. Same rounding convention as lib/reports.js (round2). Garbage/
// non-numeric amounts are excluded from the totals entirely (never a fake
// $0/Infinity contribution), matching buildWorkbook's own per-cell rule.
function round2(v) { return Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100; }
function summarize(expenses) {
  const list = Array.isArray(expenses) ? expenses : [];
  let total = 0, count = 0;
  const byCategory = new Map();
  for (const e of list) {
    if (!e) continue;
    const amt = toAmount(e.amount);
    if (amt === null) continue;
    total = round2(total + amt);
    count += 1;
    const cat = (e.category && String(e.category)) || 'Others';
    const cur = byCategory.get(cat) || { total: 0, count: 0 };
    cur.total = round2(cur.total + amt);
    cur.count += 1;
    byCategory.set(cat, cur);
  }
  const categories = [...byCategory.entries()]
    .map(([name, v]) => ({ name, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);
  return { total, count, categories };
}

// buildWorkbook(expenses, fieldSpec, opts?) -> ExcelJS.Workbook
// TWO worksheets: "Expenses" (the row-by-row detail, unchanged from before —
// kept FIRST so existing callers/tests reading worksheets[0] are unaffected),
// then "Summary" (Owner request 2026-07-06: a "professional" export should
// also carry the totals a person actually wants — overall spend, bill count,
// and a category breakdown — not just the raw row list). `opts.rangeLabel`
// (e.g. "This week", "Jul 2026", "All time") is shown as a heading; optional,
// defaults to "All time" so existing 2-arg callers need no changes.
function buildWorkbook(expenses, fieldSpec, opts = {}) {
  const columns = (fieldSpec && Array.isArray(fieldSpec.columns)) ? fieldSpec.columns : [];
  const list = Array.isArray(expenses) ? expenses : [];
  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet('Expenses');
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 18 }));
  for (const expense of list) {
    if (!expense) continue;
    // Build the row POSITIONALLY (array), not as a key-object: two FieldSpec
    // columns can legitimately share a `key`, and a keyed object would collide
    // and silently drop one column's value. Positional rows give every column
    // its own cell regardless of key collisions.
    sheet.addRow(columns.map((column) => cellValue(expense, column)));
  }

  const summarySheet = workbook.addWorksheet('Summary');
  const rangeLabel = (opts && typeof opts.rangeLabel === 'string' && opts.rangeLabel.trim()) || 'All time';
  const { total, count, categories } = summarize(list);
  summarySheet.columns = [{ width: 26 }, { width: 16 }, { width: 10 }];
  summarySheet.addRow(['Report period', rangeLabel]);
  summarySheet.addRow(['Total spend', total]);
  summarySheet.addRow(['Total bills', count]);
  summarySheet.addRow([]);
  const headerRow = summarySheet.addRow(['Category', 'Total', 'Bills']);
  headerRow.font = { bold: true };
  for (const c of categories) summarySheet.addRow([c.name, c.total, c.count]);

  return workbook;
}

module.exports = { buildWorkbook, summarize };
