'use strict';
// routes/statement.js (ADR-023/024 Phase 10): the client-facing deliverable — the Petty Cash
// Monthly Statement of Account, one per branch × month, in BOTH .xlsx and .pdf (the PDF appends the
// receipts, one per page, in statement-line order).
//
// Gating: 404 unless BOTH multiUser AND pettyCash. Auth = shared checkDash (opaque sessions →
// req.scope). Admin exports any branch; a clerk is hard-forced to their OWN branch (SEC-2). Exports
// are heavy → its own generous limiter (SEC-7). period + format server-validated; the download
// filename is built ONLY from validated tokens (no header-injection vector, same rule as
// routes/excel.js). One model (lib/statement.js), two renderers (xlsx/pdf).
const express = require('express');
const supabase = require('../lib/supabase');       // namespace import so tests can stub sbSelect
const templates = require('../lib/templates');     // namespace import (Barat's — import only)
const { CATEGORIES } = require('../lib/categorize');
const storage = require('../lib/storage');         // namespace import so tests can stub fetchReceiptObject
const { cfg } = require('../lib/config');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { buildStatementModel } = require('../lib/statement');
const { statementToWorkbook } = require('../lib/statementXlsx');
const { statementToPdf } = require('../lib/statementPdf');
const { checkDash, dashOrigin } = require('./expenses');

const statementLimiter = createRateLimiter({ max: Number(process.env.STATEMENT_RATE_MAX) || 30 });
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Above this many receipted rows the xlsx embeds links only (keep the file/time sane) — same knob
// and philosophy as routes/excel.js.
const RECEIPT_EMBED_LIMIT = Number(process.env.EXCEL_EMBED_LIMIT) || 300;

function statementOnly(req, res, next) {
  const caps = getCapabilities();
  if (!caps.multiUser || !caps.pettyCash) return res.status(404).json({ error: 'not found' });
  return next();
}

// Fetch the receipt bytes for the rows that have one (fail-safe: a null buffer just skips that
// receipt). Returns { receipts: {id:{buffer,ext}}, links: {id:url} }.
async function gatherReceipts(expenses) {
  const withReceipt = expenses.filter((e) => e && e.id && e.receipt_url);
  const links = {};
  for (const e of withReceipt) links[e.id] = '/receipt/by-id/' + e.id;
  const receipts = {};
  if (withReceipt.length && withReceipt.length <= RECEIPT_EMBED_LIMIT) {
    await Promise.all(withReceipt.map(async (e) => {
      const buf = await storage.fetchReceiptObject(e.receipt_url);
      if (buf) receipts[e.id] = { buffer: buf, ext: storage.extOf(buf) };
    }));
  }
  return { receipts, links, over: withReceipt.length > RECEIPT_EMBED_LIMIT };
}

module.exports = function mountStatement(app) {
  app.get('/api/statement', statementOnly, statementLimiter, checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    const s = req.scope;
    if (!s) return res.status(403).json({ error: 'forbidden' });

    const period = req.query.period;
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    const format = String(req.query.format || '').toLowerCase();
    if (format !== 'xlsx' && format !== 'pdf') return res.status(400).json({ error: 'format must be xlsx or pdf' });

    let branchId;
    if (s.role === 'clerk') branchId = s.branch_id;          // the bouncer: own branch only
    else {
      branchId = req.query.branch;
      if (typeof branchId !== 'string' || !branchId) return res.status(400).json({ error: 'branch is required' });
    }

    try {
      // ---- assemble the data (branch-scoped, period-filtered, not deleted/rejected) ----
      const floats = await supabase.sbSelect('petty_cash_floats', { eq: { branch_id: branchId, period }, limit: 1 });
      const float = floats[0] || null;
      const cashInRows = await supabase.sbSelect('cash_in', { eq: { branch_id: branchId, period }, order: 'created_at.asc', limit: 1000 });
      const allExp = await supabase.sbSelect('expenses', { eq: { branch_id: branchId }, extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.asc', limit: 5000 });
      const expenses = allExp.filter((e) => e && typeof e.expense_date === 'string' && e.expense_date.slice(0, 7) === period);

      const [branches, users] = await Promise.all([
        supabase.sbSelect('branches', {}),
        supabase.sbSelect('users', {}),
      ]);
      const branch = branches.find((b) => String(b.id) === String(branchId)) || null;
      const branchLabel = branch ? (branch.office || String(branchId)) : String(branchId);
      const staffNames = {};
      for (const u of users) staffNames[u.id] = u.display_name || u.username || '';

      // Company name + statement currency: from the company row when the company dimension is on,
      // else the account default. Never fatal if the lookup is empty.
      let companyName = process.env.STATEMENT_COMPANY_NAME || '';
      let currency = (float && float.currency) || cfg.DEFAULT_CURRENCY || '';
      if (getCapabilities().companyDimension && branch && branch.company_id) {
        const comps = await supabase.sbSelect('companies', { eq: { id: branch.company_id }, limit: 1 });
        if (comps[0]) { companyName = comps[0].name || companyName; currency = comps[0].currency || currency; }
      }

      const fieldSpec = await templates.getFieldSpec();
      const categories = (fieldSpec && Array.isArray(fieldSpec.categories) && fieldSpec.categories.length)
        ? fieldSpec.categories : CATEGORIES;

      const model = buildStatementModel({
        companyName, branchLabel, preparedBy: '', period,
        categories, currency, showStaffColumn: true,
        balanceBf: float ? float.balance_bf : 0,
        cashIn: cashInRows.map((c) => ({ date: c.date, description: c.description, amount: c.amount })),
        expenses, staffNames,
        signoff: { prepared: true, checked: false, approved: true },
      });

      // Filename tokens are validated-only (period matches YYYY-MM; branch sanitised) — no header
      // injection possible.
      const safeBranch = String(branchId).replace(/[^A-Za-z0-9_-]/g, '') || 'branch';
      const filename = 'petty-cash-' + safeBranch + '-' + period + '.' + format;

      if (format === 'xlsx') {
        const { receipts, links, over } = await gatherReceipts(expenses);
        const opts = { receiptLinks: links };
        if (over) opts.embedReceipts = false; else opts.receipts = receipts;
        const wb = statementToWorkbook(model, opts);
        const buf = await wb.xlsx.writeBuffer();
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
        return res.send(Buffer.from(buf));
      }

      // pdf: fetch receipt bytes (uncapped — the PDF is meant to carry every receipt page)
      const withReceipt = expenses.filter((e) => e && e.id && e.receipt_url);
      const receipts = {};
      await Promise.all(withReceipt.map(async (e) => {
        const buf = await storage.fetchReceiptObject(e.receipt_url);
        if (buf) receipts[e.id] = { buffer: buf, ext: storage.extOf(buf) };
      }));
      const { buffer } = await statementToPdf(model, { receipts });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
      return res.send(buffer);
    } catch (e) {
      console.error('[api/statement]', e.message); // message only — no PII/bytes
      return res.status(502).json({ error: 'statement export failed' });
    }
  });
};
