'use strict';
// routes/manageExport.js — QA PR-F Manage/Data-editor exports.
// POST /api/manage-export?format=csv|xlsx|pdf { ids:[expense ids in current filtered order] }
// The frontend owns the current search/filter state; the server re-fetches scoped expenses and
// intersects by id so a tampered request cannot export rows outside the caller's scope. CSV gets
// receipt references, Excel gets receipt hyperlinks, PDF reuses lib/statementPdf.js's evidence-pack
// engine (summary table + one appended receipt page per line item).
const express = require('express');
const supabase = require('../lib/supabase');
const templates = require('../lib/templates');
const storage = require('../lib/storage');
const { cfg } = require('../lib/config');
const { getCapabilities } = require('../lib/account'); // business-mode gate (multiUser), QA 2026-07-30
const { CATEGORIES } = require('../lib/categorize');
const { buildWorkbook, receiptTypeLabel } = require('../lib/excel');
const { tgFileUrl } = require('../lib/telegram');
const { hreq } = require('../lib/http');
const { buildStatementModel } = require('../lib/statement');
const { statementToPdf } = require('../lib/statementPdf');
const { checkDash, dashOrigin } = require('./expenses');
const { guestVisibilityExtra, mergeExtra } = require('../lib/auth'); // Guest Mode (2026-07-28) read isolation

const EXPORT_ROW_LIMIT = 10000;
const PERSONAL_TITLE = 'EXPENSES RECORD';

// getExportColumns(business) — Branch/Staff only make sense for a business account (QA
// 2026-07-30: "NO NEED STAFF COLUM FOR PERSONAL DASHBOARD" — Branch has the identical
// reasoning, both empty/meaningless on a personal export, fixed together). A separate
// "Receipt Type" column (Photo vs PDF/E-Bill, see lib/excel.js's receiptTypeLabel) sits
// alongside the existing Receipt URL link rather than replacing it, so the link still works.
function getExportColumns(business) {
  const cols = [
    { key: 'expense_date', label: 'Date' },
    { key: 'merchant', label: 'Merchant' },
    { key: 'amount', label: 'Amount' },
    { key: 'currency', label: 'Currency' },
    { key: 'category', label: 'Category' },
  ];
  if (business) cols.push({ key: 'branch', label: 'Branch' }, { key: 'staff', label: 'Staff' });
  cols.push(
    { key: 'payment_status', label: 'Status' },
    { key: 'receipt_type', label: 'Receipt Type' },
    { key: 'receipt_url', label: 'Receipt URL' },
  );
  return cols;
}

function receiptLink(row) {
  if (!row || !row.id || (!row.receipt_url && !row.receipt_file_id)) return '';
  return '/api/receipt/by-id/' + encodeURIComponent(row.id); // ADR-027 collision-proof path
}

function csvValue(value) {
  const raw = value == null ? '' : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? "'" + raw : raw;
  if (/[",\n\r]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
  return safe;
}

function rowValue(row, key, maps) {
  if (!row) return '';
  if (key === 'branch') {
    const id = row.branch_id;
    return id == null || id === '' ? '' : (maps.branchNames[id] || String(id));
  }
  if (key === 'staff') {
    const id = row.staff_user_id;
    return id == null || id === '' ? '' : (maps.staffNames[id] || String(id));
  }
  if (key === 'receipt_type') return row.receipt_url ? receiptTypeLabel(row.receipt_url) : '';
  if (key === 'receipt_url') return receiptLink(row);
  return row[key];
}

function rowsToCsv(rows, maps, business) {
  const columns = getExportColumns(!!business);
  const header = columns.map((c) => csvValue(c.label)).join(',');
  const lines = (Array.isArray(rows) ? rows : []).map((row) => (
    columns.map((c) => csvValue(rowValue(row, c.key, maps))).join(',')
  ));
  return [header].concat(lines).join('\r\n');
}

function dateSpan(rows) {
  let first = null, last = null;
  for (const row of rows || []) {
    const d = String((row && row.expense_date) || '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(d)) continue;
    if (first === null || d < first) first = d;
    if (last === null || d > last) last = d;
  }
  if (first && last && first !== last) return first + ' to ' + last;
  return first || 'Filtered data';
}

async function lookupNames() {
  const [branches, users] = await Promise.all([
    supabase.sbSelect('branches', {}),
    supabase.sbSelect('users', {}),
  ]);
  const branchNames = {};
  for (const b of (branches || [])) branchNames[b.id] = b.office || String(b.id);
  const staffNames = {};
  for (const u of (users || [])) staffNames[u.id] = u.display_name || u.username || String(u.id);
  return { branchNames, staffNames };
}

async function scopedRowsForIds(ids, scope) {
  const all = await supabase.sbSelect('expenses', {
    extra: mergeExtra('deleted_at=is.null&status=neq.rejected', guestVisibilityExtra(scope)),
    order: 'created_at.desc',
    limit: EXPORT_ROW_LIMIT,
    scope,
  });
  const byId = new Map();
  for (const row of (all || [])) if (row && row.id != null) byId.set(String(row.id), row);
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

function branchLabel(rows, maps) {
  const names = new Set();
  for (const row of rows || []) {
    const id = row && row.branch_id;
    if (id != null && id !== '') names.add(maps.branchNames[id] || String(id));
  }
  if (names.size === 1) return Array.from(names)[0];
  if (names.size > 1) return 'All branches';
  return 'Filtered rows';
}

module.exports = function mountManageExport(app) {
  app.post('/api/manage-export', checkDash, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    const format = String(req.query.format || '').toLowerCase();
    if (format !== 'csv' && format !== 'xlsx' && format !== 'pdf') return res.status(400).json({ error: 'format must be csv, xlsx, or pdf' });
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => typeof v !== 'string' || !v)) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (ids.length > EXPORT_ROW_LIMIT) return res.status(413).json({ error: 'too many rows' });

    try {
      // business (QA 2026-07-30): gates Branch/Staff columns + the "Petty Cash" title below —
      // a personal account gets none of the business-only chrome, same reasoning as the
      // free-tier cap's own role checks elsewhere in this codebase.
      const business = getCapabilities().multiUser;
      const rows = await scopedRowsForIds(ids, req.scope);
      if (!rows.length) return res.status(400).json({ error: 'no exportable rows' });
      const [fieldSpec, maps] = await Promise.all([templates.getFieldSpec(), lookupNames()]);
      // 2026-08-19 bug fix: the title used to be derived from the exported ROWS' own
      // min/max expense_date (dateSpan below) instead of what the user actually picked in
      // the Month dropdown — when every visible row happened to share one date, dateSpan()
      // returned that single day instead of the picked month. The frontend (grid.js
      // periodLabel()) now sends a ready-made label alongside the ids; period_label is
      // optional so an older cached frontend bundle (no such field in its POST body) still
      // falls back to the old dateSpan(rows) behavior, unchanged.
      const rangeLabel = (req.body && typeof req.body.period_label === 'string'
        && req.body.period_label.trim()) || dateSpan(rows);
      const receiptLinks = {};
      for (const row of rows) {
        const link = receiptLink(row);
        if (link) receiptLinks[row.id] = link;
      }

      if (format === 'csv') {
        const csv = rowsToCsv(rows, maps, business);
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="ledger-export.csv"');
        return res.send(csv);
      }

      if (format === 'xlsx') {
        const wb = buildWorkbook(rows, fieldSpec, {
          rangeLabel,
          generatedAt: new Date().toISOString(),
          currency: cfg.DEFAULT_CURRENCY,
          branchStaff: business,
          branchNames: maps.branchNames,
          staffNames: maps.staffNames,
          categories: (fieldSpec && Array.isArray(fieldSpec.categories)) ? fieldSpec.categories : undefined,
          receiptLinks,
          embedReceipts: false,
        });
        const buf = await wb.xlsx.writeBuffer();
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', 'attachment; filename="ledger-export.xlsx"');
        return res.send(Buffer.from(buf));
      }

      const categories = (fieldSpec && Array.isArray(fieldSpec.categories) && fieldSpec.categories.length)
        ? fieldSpec.categories : CATEGORIES;
      const model = buildStatementModel({
        companyName: process.env.STATEMENT_COMPANY_NAME || 'SnapReceipt AI',
        title: business ? undefined : PERSONAL_TITLE,
        showBranchLabel: business,
        branchLabel: branchLabel(rows, maps),
        preparedBy: '',
        period: rangeLabel,
        categories,
        currency: cfg.DEFAULT_CURRENCY,
        showStaffColumn: business,
        showBranchColumn: business,
        branchNames: maps.branchNames,
        balanceBf: 0,
        cashIn: [],
        expenses: rows,
        staffNames: maps.staffNames,
        signoff: { prepared: false, checked: false, approved: false },
        padRows: 0,
      });
      const receipts = {};
      await Promise.all(rows.filter((e) => e && (e.receipt_url || e.receipt_file_id)).map(async (e) => {
        let buf = null;
        if (e.receipt_url) {
          buf = await storage.fetchReceiptObject(e.receipt_url);
        }
        if (!buf && e.receipt_file_id) {
          try {
            const file = await tgFileUrl(e.receipt_file_id);
            if (file && file.url) {
              buf = await hreq({ url: file.url, encoding: 'arraybuffer', timeout: 15000 });
              if (Buffer.isBuffer(buf) && !buf.length) buf = null;
            }
          } catch (err) { console.error('[export] telegram file fallback:', err.message); }
        }
        if (buf) receipts[e.id] = { buffer: buf, ext: storage.extOf(buf) };
      }));
      // Bug fix (2026-08-10, Barat: "i want output like this" — a reference Statement PDF
      // with the full "Receipt #N / Date / Vendor / Amount / Ref" card per photo): this call
      // was missing receiptEvidence:true, so every personal "Export PDF" silently fell back to
      // drawPlainReceiptPage (lib/statementPdf.js) — a bare, unlabeled image with no caption —
      // instead of drawEvidencePage's bordered card. routes/statement.js (the business
      // "Statement PDF" button) already passes this; personal's export never did. Confirmed via
      // a real export: before this fix the evidence page had ZERO extractable text, only the
      // photo — after, it carries the same Receipt #/Date/Vendor/Amount/Ref layout as business.
      const { buffer } = await statementToPdf(model, { receipts, receiptEvidence: true });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="ledger-evidence-pack.pdf"');
      return res.send(buffer);
    } catch (e) {
      console.error('[api/manage-export]', e.message);
      return res.status(502).json({ error: 'export failed' });
    }
  });
};

module.exports.rowsToCsv = rowsToCsv;
module.exports.receiptLink = receiptLink;
module.exports.getExportColumns = getExportColumns;
module.exports.EXPORT_ROW_LIMIT = EXPORT_ROW_LIMIT;
