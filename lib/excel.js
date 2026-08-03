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
const { splitExpenseAmounts } = require('./statement');

const DIRECT_KEYS = new Set([
  'merchant', 'expense_date', 'amount', 'currency', 'category', 'subtotal', 'tax', 'remark',
]);
const MAX_TEXT_LEN = 500;

// receiptTypeLabel(url) -> a human label for the Receipt column (QA 2026-07-30: "receipt
// colum must popup the receipt type paper receipt or pdf file, e-bill and etc"), derived
// from the stored object's own extension — uploadReceiptImage (lib/storage.js) names every
// object `<account>/<uuid>.<ext>` with ext sniffed from the real file bytes at upload time
// (png/jpg/webp/pdf), so this is a cheap string check, not a re-fetch of the file. A true
// scanned-paper-photo vs. digital-e-bill-PDF distinction isn't reliably derivable from
// anything this system stores — PDF is labelled "PDF / E-Bill" rather than guessing further.
function receiptTypeLabel(url) {
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.pdf')) return 'PDF / E-Bill';
  if (u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.jpeg') || u.endsWith('.webp')) return 'Photo (Paper Receipt)';
  return 'Receipt';
}

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

// Aggregate a plain total/count + per-category total/count/pct (sorted by
// total descending), plus the earliest/latest expense_date actually present
// (the real date span the export covers — distinct from `opts.rangeLabel`,
// which just names the FILTER the caller applied; e.g. an "All time" export
// still has a real first/last date once there's data). Same rounding
// convention as lib/reports.js (round2). Garbage/non-numeric amounts are
// excluded from the totals entirely (never a fake $0/Infinity contribution),
// matching buildWorkbook's own per-cell rule. Never throws on junk input.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
function round2(v) { return Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100; }
function summarize(expenses, opts = {}) {
  const list = Array.isArray(expenses) ? expenses : [];
  let total = 0, count = 0;
  let earliestDate = null, latestDate = null;
  const byCategory = new Map();
  for (const e of list) {
    if (!e) continue;
    const amt = toAmount(e.amount);
    if (amt === null) continue;
    total = round2(total + amt);
    count += 1;
    for (const portion of splitExpenseAmounts(e, opts.categories)) {
      const cat = (portion.category && String(portion.category)) || 'Others';
      const cur = byCategory.get(cat) || { total: 0, count: 0 };
      cur.total = round2(cur.total + portion.amount);
      cur.count += 1;
      byCategory.set(cat, cur);
    }

    // Plain string comparison is safe here (ISO 'YYYY-MM-DD' sorts correctly
    // lexically) — same convention lib/reports.js already relies on.
    const date = String(e.expense_date || '');
    if (ISO_DATE_RE.test(date)) {
      if (earliestDate === null || date < earliestDate) earliestDate = date;
      if (latestDate === null || date > latestDate) latestDate = date;
    }
  }
  const categories = [...byCategory.entries()]
    .map(([name, v]) => ({ name, total: v.total, count: v.count, pct: total > 0 ? Math.round((v.total / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.total - a.total);
  return { total, count, categories, earliestDate, latestDate };
}

const PCT_FMT = '0.0"%"';   // literal suffix — pct is already a 0-100 number, not a 0-1 fraction

// Common ISO-4217 codes -> their conventional display symbol, for the
// accountant-style money formatting below. Codes with no entry fall back to
// the code itself as a prefix (e.g. "MYR 1,074.58") — never guessed, since a
// wrong symbol on a real financial report is worse than a plain code prefix.
const CURRENCY_SYMBOLS = {
  USD: '$', CAD: '$', AUD: '$', SGD: '$', NZD: '$', HKD: '$',
  EUR: '€', GBP: '£', INR: '₹', IDR: 'Rp', KRW: '₩', PHP: '₱',
  THB: '฿', VND: '₫', MYR: 'RM', JPY: '¥', CNY: '¥',
};
function moneyFormat(currency) {
  const code = String(currency || 'USD').trim().toUpperCase();
  const prefix = CURRENCY_SYMBOLS[code] || (code + ' ');
  return '"' + prefix + '"#,##0.00';
}

// How wide a number will actually RENDER once moneyFmt applies (symbol +
// thousands separators + 2 decimals) — e.g. 1171.28 -> "RM1,171.28" (10
// chars), not the 7-char raw "1171.28". Auto-fit must measure THIS, not the
// raw value, or a column sized off individually-small rows shows "#######"
// once a bigger formatted number (typically the Total row) lands in it.
function moneyDisplayWidth(currency, value) {
  const code = String(currency || 'USD').trim().toUpperCase();
  const prefix = CURRENCY_SYMBOLS[code] || (code + ' ');
  const n = Number(value);
  if (!isFinite(n)) return 0;
  const fixed = Math.abs(n).toFixed(2);
  const grouped = fixed.replace(/^(\d+)/, (intPart) => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  return (prefix + grouped).length + (n < 0 ? 1 : 0);
}

// Thin grey box border (ARCHITECTURE-neutral styling, not a data concern) —
// applied around the summary info block and the category table so the sheet
// reads like a real printed report instead of plain unbordered text.
const THIN = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
function applyBox(sheet, fromRow, toRow, fromCol, toCol) {
  for (let r = fromRow; r <= toRow; r++) {
    for (let c = fromCol; c <= toCol; c++) sheet.getRow(r).getCell(c).border = BOX;
  }
}

// buildWorkbook(expenses, fieldSpec, opts?) -> ExcelJS.Workbook
// TWO worksheets: "Expenses" (the row-by-row detail, unchanged from before —
// kept FIRST so existing callers/tests reading worksheets[0] are unaffected),
// then "Summary" — a fuller report page: title, the filter applied
// (`opts.rangeLabel`, e.g. "This week"/"Jul 2026"/"All time"), the REAL first/
// last date the data covers, when the report was generated
// (`opts.generatedAt`, an ISO string; defaults to now), total spend, total
// bills, categories used, average per bill, then a category breakdown with a
// %-of-total column. `opts.currency` (an ISO code, defaults 'USD') drives the
// money-cell symbol on both sheets. All opts are optional so existing 2-arg
// callers need no changes. Both sheets get print-ready page setup (fit to one
// page wide, repeat the header row) since this is meant to be handed to an
// accountant, not just read on-screen.
function buildWorkbook(expenses, fieldSpec, opts = {}) {
  const columns = (fieldSpec && Array.isArray(fieldSpec.columns)) ? fieldSpec.columns : [];
  const list = Array.isArray(expenses) ? expenses : [];
  const currency = (opts && typeof opts.currency === 'string' && opts.currency.trim()) || 'USD';
  const moneyFmt = moneyFormat(currency);
  const rangeLabel = (opts && typeof opts.rangeLabel === 'string' && opts.rangeLabel.trim()) || 'All time';
  // Business-only (Phase 3): append Branch + Staff columns after the FieldSpec columns, resolving
  // branch_id/staff_user_id to names via opts maps (id fallback when unknown, blank when absent).
  // With opts.branchStaff off, allColumns === the FieldSpec columns → personal export unchanged.
  const branchStaff = !!(opts && opts.branchStaff);
  const branchNames = (opts && opts.branchNames) || {};
  const staffNames = (opts && opts.staffNames) || {};
  // Receipt-image embed (ADR-018): opt-in via opts.receipts (id -> {buffer, ext}) and/or
  // opts.receiptLinks (id -> full-res URL). Default embeds a scaled thumbnail with a hyperlink to
  // full-res; embedReceipts:false is "links-only" (a hyperlink, no image) for very large exports.
  // NOT flag-gated — personal exports embed too. Only png/jpg/gif embed; anything else (pdf/webp)
  // falls back to the link. Opt-in so existing 2/3-arg callers get no Receipt column.
  const receipts = (opts && opts.receipts) || null;
  const receiptLinks = (opts && opts.receiptLinks) || null;
  const receiptColumn = !!(receipts || receiptLinks);
  const embedReceipts = !(opts && opts.embedReceipts === false);
  const EMBEDDABLE_EXT = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };
  const receiptFor = (expense) => {
    const id = expense && expense.id;
    if (id == null) return { bytes: undefined, link: undefined };
    return { bytes: receipts ? receipts[id] : undefined, link: receiptLinks ? receiptLinks[id] : undefined };
  };
  const embeddableExt = (bytes) => ((bytes && bytes.buffer) ? EMBEDDABLE_EXT[String(bytes.ext || '').toLowerCase()] : null);

  const extraCols = [];
  if (branchStaff) extraCols.push({ label: 'Branch', synth: 'branch' }, { label: 'Staff', synth: 'staff' });
  if (receiptColumn) extraCols.push({ label: 'Receipt', synth: 'receipt' });
  const allColumns = columns.concat(extraCols);
  const receiptColIdx = receiptColumn ? allColumns.length - 1 : -1; // 0-based, for image anchoring
  function valueOf(expense, column) {
    if (column.synth === 'branch') { const id = expense.branch_id; return (id != null && id !== '') ? (branchNames[id] || String(id)) : null; }
    if (column.synth === 'staff') { const id = expense.staff_user_id; return (id != null && id !== '') ? (staffNames[id] || String(id)) : null; }
    if (column.synth === 'receipt') { const { link } = receiptFor(expense); return link ? { text: receiptTypeLabel(expense.receipt_url), hyperlink: link } : null; }
    return cellValue(expense, column);
  }
  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet('Expenses');
  sheet.columns = allColumns.map(() => ({ width: 18 })); // placeholder — auto-fit below once content is known
  allColumns.forEach((c, i) => {
    if (c.type === 'currency') sheet.getColumn(i + 1).numFmt = moneyFmt;
  });

  const expTitleSpan = Math.max(allColumns.length, 1);
  const expTitleRow = sheet.addRow(['Expenses — ' + rangeLabel]);
  expTitleRow.getCell(1).font = { bold: true, size: 14 };
  if (expTitleSpan > 1) sheet.mergeCells(expTitleRow.number, 1, expTitleRow.number, expTitleSpan);

  const expHeaderRow = sheet.addRow(allColumns.map((c) => c.label));
  expHeaderRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  });

  // Track a running sum per currency-type column (garbage/non-numeric cells
  // already resolve to `null` via cellValue, so they're naturally excluded —
  // same "never a fake $0" rule as summarize()) for a Total row underneath the
  // data, the way a real ledger/invoice ends with a totals line. Also track
  // the longest cell value per column (starting from its header label) so
  // columns can be auto-fit afterwards — a fixed width was truncating longer
  // merchant names in practice (owner report 2026-07-07).
  const isCurrencyCol = allColumns.map((c) => c.type === 'currency');
  const colSums = allColumns.map(() => 0);
  const colWidths = allColumns.map((c) => String((c && c.label) || '').length);
  for (const expense of list) {
    if (!expense) continue;
    // Build the row POSITIONALLY (array), not as a key-object: two FieldSpec
    // columns can legitimately share a `key`, and a keyed object would collide
    // and silently drop one column's value. Positional rows give every column
    // its own cell regardless of key collisions.
    const rowValues = allColumns.map((column) => valueOf(expense, column));
    const addedRow = sheet.addRow(rowValues);
    // Float a scaled thumbnail over the Receipt cell (embed mode + an embeddable image only);
    // the cell value itself carries the optional full-res hyperlink. Row height bumped so the
    // thumbnail is visible.
    if (receiptColumn && embedReceipts) {
      const { bytes } = receiptFor(expense);
      const extn = embeddableExt(bytes);
      if (extn) {
        const imgId = workbook.addImage({ buffer: bytes.buffer, extension: extn });
        sheet.addImage(imgId, { tl: { col: receiptColIdx, row: addedRow.number - 1 }, ext: { width: 72, height: 54 } });
        sheet.getRow(addedRow.number).height = 44;
      }
    }
    rowValues.forEach((v, i) => {
      if (isCurrencyCol[i] && typeof v === 'number' && isFinite(v)) {
        colSums[i] += v;
        const width = moneyDisplayWidth(currency, v);
        if (width > colWidths[i]) colWidths[i] = width;
        return;
      }
      const len = (v === null || v === undefined) ? 0 : String(v).length;
      if (len > colWidths[i]) colWidths[i] = len;
    });
  }
  if (list.length > 0) {
    const totalRowValues = allColumns.map((c, i) => (i === 0 ? 'Total' : (isCurrencyCol[i] ? round2(colSums[i]) : null)));
    // The Total is often the widest number in the column (it's a sum) — fold ITS
    // rendered width into colWidths too, before the column widths are locked in below.
    totalRowValues.forEach((v, i) => {
      if (isCurrencyCol[i] && typeof v === 'number') {
        const width = moneyDisplayWidth(currency, v);
        if (width > colWidths[i]) colWidths[i] = width;
      }
    });
    const totalRow = sheet.addRow(totalRowValues);
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true };
      cell.border = { top: THIN };
      if (isCurrencyCol[colNumber - 1]) cell.numFmt = moneyFmt;
    });
  }

  // Auto-fit: pad for breathing room, floor at a readable minimum, cap so one
  // very long remark/note can't blow the sheet out to an unusable width.
  allColumns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.synth === 'receipt' ? 14 : Math.max(10, Math.min(colWidths[i] + 2, 40));
  });

  sheet.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '2:2' };
  sheet.views = [{ state: 'frozen', ySplit: 2 }];

  const summarySheet = workbook.addWorksheet('Summary');
  const generatedAt = (opts && typeof opts.generatedAt === 'string' && opts.generatedAt.trim()) || new Date().toISOString();
  const { total, count, categories, earliestDate, latestDate } = summarize(list, { categories: opts.categories });
  const dataCovers = (earliestDate && latestDate)
    ? (earliestDate === latestDate ? earliestDate : earliestDate + ' to ' + latestDate)
    : 'No expenses in this period';
  const average = count > 0 ? round2(total / count) : 0;

  summarySheet.columns = [{ width: 26 }, { width: 18 }, { width: 12 }, { width: 12 }];
  summarySheet.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  const titleRow = summarySheet.addRow(['Expense Report']);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  summarySheet.mergeCells(titleRow.number, 1, titleRow.number, 4);
  summarySheet.addRow([]);
  summarySheet.addRow(['Report period', rangeLabel]);
  summarySheet.addRow(['Data covers', dataCovers]);
  summarySheet.addRow(['Report generated', generatedAt]);
  summarySheet.addRow([]);
  summarySheet.addRow(['Total spend', total]).getCell(2).numFmt = moneyFmt;
  summarySheet.addRow(['Total bills', count]);
  summarySheet.addRow(['Categories used', categories.length]);
  summarySheet.addRow(['Average per bill', average]).getCell(2).numFmt = moneyFmt;
  applyBox(summarySheet, 3, summarySheet.lastRow.number, 1, 2);
  summarySheet.addRow([]);

  const headerRow = summarySheet.addRow(['Category', 'Total', 'Bills', '% of Total']);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  });
  for (const c of categories) {
    const row = summarySheet.addRow([c.name, c.total, c.count, c.pct]);
    row.getCell(2).numFmt = moneyFmt;
    row.getCell(4).numFmt = PCT_FMT;
  }
  applyBox(summarySheet, headerRow.number, summarySheet.lastRow.number, 1, 4);

  return workbook;
}

module.exports = { buildWorkbook, summarize, receiptTypeLabel };
