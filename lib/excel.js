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

function buildWorkbook(expenses, fieldSpec) {
  const columns = (fieldSpec && Array.isArray(fieldSpec.columns)) ? fieldSpec.columns : [];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 18 }));

  for (const expense of (Array.isArray(expenses) ? expenses : [])) {
    if (!expense) continue;
    const row = {};
    for (const column of columns) row[column.key] = cellValue(expense, column);
    sheet.addRow(row);
  }
  return workbook;
}

module.exports = { buildWorkbook };
