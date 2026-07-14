'use strict';
// routes/statement.js (ADR-023/024 Phase 10; all-branches export follow-up; Receipt Evidence
// follow-up): the client-facing deliverable — the Petty Cash Monthly Statement of Account, one
// per branch (OR, for an admin, all branches combined) × month, in BOTH .xlsx and .pdf. The PDF
// keeps the summary table on page 1 unchanged, then appends a numbered "Receipt Evidence" page
// per expense line item (receipt image + Date/Merchant/Amount/Staff/Branch/Receipt ID captions,
// or "Receipt Not Available" when no usable receipt exists), in DATE order (not statement-line
// order — see lib/statementPdf.js). Downloaded as Expense_Report_<today>.pdf. Excel is data-only
// (receipt LINKS, never embedded images — the xlsx is meant to be opened/edited, the PDF is the
// evidence pack).
//
// Gating: 404 unless BOTH multiUser AND pettyCash. Auth = shared checkDash (opaque sessions →
// req.scope). Admin exports any branch OR `branch=all` (every branch combined — the query drops
// the branch_id filter entirely; admin scope already adds none); a clerk is hard-forced to their
// OWN branch (SEC-2) and can never request `all`. Exports are heavy → its own generous limiter
// (SEC-7). period + format server-validated; the download filename is built ONLY from validated
// tokens (no header-injection vector, same rule as routes/excel.js). One model (lib/statement.js),
// two renderers (xlsx/pdf).
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
const ALL_BRANCHES = 'all';

function statementOnly(req, res, next) {
  const caps = getCapabilities();
  if (!caps.multiUser || !caps.pettyCash) return res.status(404).json({ error: 'not found' });
  return next();
}

// xlsx is data-only (no embedded images, ever — just a receipt LINK per row): build the id->link
// map directly, no byte fetch needed. (The pdf branch below still fetches bytes to append pages.)
function receiptLinksOf(expenses) {
  const links = {};
  for (const e of expenses) if (e && e.id && e.receipt_url) links[e.id] = '/api/receipt/by-id/' + e.id; // ADR-027 collision-proof path
  return links;
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
    let allBranches = false;
    if (s.role === 'clerk') branchId = s.branch_id;          // the bouncer: own branch only — never 'all'
    else {
      branchId = req.query.branch;
      if (typeof branchId !== 'string' || !branchId) return res.status(400).json({ error: 'branch is required' });
      allBranches = branchId === ALL_BRANCHES;
    }

    try {
      // ---- assemble the data (period-filtered, not deleted/rejected) ----
      // scope (#131): defense-in-depth — a clerk's `s` re-asserts branch_id at the DB even though
      // branchId is already forced to their own branch above; admin scope adds no filter either way.
      // All-branches (admin only): skip the float/cash-in lookup entirely (those are a PER-BRANCH
      // ledger, meaningless combined) and drop the branch_id filter on expenses so every branch's
      // rows for the period come back.
      const float = allBranches ? null : (await supabase.sbSelect('petty_cash_floats', { eq: { branch_id: branchId, period }, limit: 1, scope: s }))[0] || null;
      const cashInRows = allBranches ? [] : await supabase.sbSelect('cash_in', { eq: { branch_id: branchId, period }, order: 'created_at.asc', limit: 1000, scope: s });
      const allExp = await supabase.sbSelect('expenses', {
        eq: allBranches ? {} : { branch_id: branchId },
        extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.asc', limit: 5000, scope: s,
      });
      const expenses = allExp.filter((e) => e && typeof e.expense_date === 'string' && e.expense_date.slice(0, 7) === period);

      const [branches, users] = await Promise.all([
        supabase.sbSelect('branches', {}),
        supabase.sbSelect('users', {}),
      ]);
      const branch = allBranches ? null : branches.find((b) => String(b.id) === String(branchId)) || null;
      const branchLabel = allBranches ? 'All branches' : (branch ? (branch.office || String(branchId)) : String(branchId));
      const branchNames = {};
      for (const b of branches) branchNames[b.id] = b.office || String(b.id);
      const staffNames = {};
      for (const u of users) staffNames[u.id] = u.display_name || u.username || '';

      // Company name + statement currency: from the company row when the company dimension is on,
      // else the account default. Never fatal if the lookup is empty. All-branches has no single
      // branch/company to look up — stays on the account default (a combined export spans them all).
      let companyName = process.env.STATEMENT_COMPANY_NAME || '';
      let currency = (float && float.currency) || cfg.DEFAULT_CURRENCY || '';
      if (!allBranches && getCapabilities().companyDimension && branch && branch.company_id) {
        const comps = await supabase.sbSelect('companies', { eq: { id: branch.company_id }, limit: 1 });
        if (comps[0]) { companyName = comps[0].name || companyName; currency = comps[0].currency || currency; }
      }

      const fieldSpec = await templates.getFieldSpec();
      const categories = (fieldSpec && Array.isArray(fieldSpec.categories) && fieldSpec.categories.length)
        ? fieldSpec.categories : CATEGORIES;

      const model = buildStatementModel({
        companyName, branchLabel, preparedBy: '', period,
        categories, currency, showStaffColumn: true,
        showBranchColumn: allBranches, branchNames,
        balanceBf: float ? float.balance_bf : 0,
        cashIn: cashInRows.map((c) => ({ date: c.date, description: c.description, amount: c.amount })),
        expenses, staffNames,
        signoff: { prepared: true, checked: false, approved: true },
      });

      // Filename tokens are validated-only (period matches YYYY-MM; branch sanitised) — no header
      // injection possible. The PDF (the audit-ready evidence pack) uses the client-specified
      // Expense_Report_<generated-date> naming; the xlsx keeps its existing petty-cash- naming.
      const safeBranch = allBranches ? 'all-branches' : (String(branchId).replace(/[^A-Za-z0-9_-]/g, '') || 'branch');
      const filename = format === 'pdf'
        ? 'Expense_Report_' + new Date().toISOString().slice(0, 10) + '.pdf'
        : 'petty-cash-' + safeBranch + '-' + period + '.' + format;

      if (format === 'xlsx') {
        // Excel is ALWAYS data-only (a receipt LINK per row, never an embedded image) — the PDF is
        // the evidence pack with every photo appended, so xlsx doesn't need to also carry the bytes.
        const wb = statementToWorkbook(model, { receiptLinks: receiptLinksOf(expenses), embedReceipts: false });
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
      const { buffer } = await statementToPdf(model, { receipts, receiptEvidence: true });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
      return res.send(buffer);
    } catch (e) {
      console.error('[api/statement]', e.message); // message only — no PII/bytes
      return res.status(502).json({ error: 'statement export failed' });
    }
  });
};
