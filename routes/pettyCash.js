'use strict';
// routes/pettyCash.js (ADR-023 Phase 9): petty-cash floats + the claim summary.
//
// The Premala deliverable's data surface. The admin sets a monthly opening float per branch
// (balance_bf) and adds Section-A top-ups (cash_in); the summary endpoint returns the running
// balance + the reimbursement claim set, all COMPUTED on read by lib/pettyCash.js (never stored,
// so it can't drift from the numbers).
//
// Gating (ADR-023): the whole surface 404s unless BOTH capabilities.multiUser AND
// capabilities.pettyCash are ON — invisible on the product without petty-cash. Auth = the shared
// checkDash (opaque sessions → req.scope, the frozen scopeForUser bouncer). The Owner's rule: only
// the ADMIN sets floats and cash-in (incl. Head Office); a clerk may only READ, and only ever their
// OWN branch (the branch comes from the session scope, a query/body branch is ignored — SEC-2).
// Per-route rate limiter (SEC-7); period/amount/branch server-validated (SEC-5); no PII in logs.
const express = require('express');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { getPeriodSummary, upsertFloat, addCashIn, deleteCashIn } = require('../lib/pettyCash');
const { checkDash } = require('./expenses');

const pettyCashLimiter = createRateLimiter({ max: Number(process.env.PETTYCASH_RATE_MAX) || 60 });
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // 'YYYY-MM', a real month
const DESC_MAX = 300;
const DATE_MAX = 40;
const CURRENCY_MAX = 10;

// 404 the whole surface unless the client profile turns the petty-cash engine on.
function pettyCashOnly(req, res, next) {
  const caps = getCapabilities();
  if (!caps.multiUser || !caps.pettyCash) return res.status(404).json({ error: 'not found' });
  return next();
}

const forbid = (res) => res.status(403).json({ error: 'forbidden' });
// A finite number that isn't a boolean/null/'' (Number(true)/Number(null)/Number('') are all finite
// but are never a valid money input). Accepts numeric strings (coerced by the caller).
const isFiniteNum = (v) => typeof v !== 'boolean' && v !== null && v !== '' && Number.isFinite(Number(v));

module.exports = function mountPettyCash(app) {
  const json = express.json({ limit: '16kb' });

  // Specific paths first (gotcha #2), though these never collide (distinct method+path).

  // PUT /api/petty-cash/float { branchId, period, balanceBf, currency? } — ADMIN ONLY. Upsert on
  // (branch, period) via select-then-insert/update (there's no multi-eq update helper, gotcha #4).
  app.put('/api/petty-cash/float', pettyCashOnly, pettyCashLimiter, checkDash, json, async (req, res) => {
    const s = req.scope;
    if (!s || s.role !== 'admin') return forbid(res);
    const { branchId, period, balanceBf, currency } = req.body || {};
    if (typeof branchId !== 'string' || !branchId) return res.status(400).json({ error: 'branchId is required' });
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    if (!isFiniteNum(balanceBf) || Number(balanceBf) < 0) return res.status(400).json({ error: 'balanceBf must be a finite number >= 0' });
    const cur = typeof currency === 'string' ? currency.slice(0, CURRENCY_MAX) : null;
    try {
      const float = await upsertFloat({
        branchId, period, balanceBf: Number(balanceBf), currency: cur,
        updatedBy: req.user && req.user.user_id,
      });
      return res.json({ float });
    } catch (e) {
      console.error('[petty-cash float]', e.message);
      return res.status(502).json({ error: 'failed to set float' });
    }
  });

  // POST /api/petty-cash/cash-in { branchId, period, date?, description?, amount } — ADMIN ONLY.
  app.post('/api/petty-cash/cash-in', pettyCashOnly, pettyCashLimiter, checkDash, json, async (req, res) => {
    const s = req.scope;
    if (!s || s.role !== 'admin') return forbid(res);
    const { branchId, period, date, description, amount } = req.body || {};
    if (typeof branchId !== 'string' || !branchId) return res.status(400).json({ error: 'branchId is required' });
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    if (!isFiniteNum(amount) || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be a finite number > 0' });
    const d = typeof date === 'string' ? date.slice(0, DATE_MAX) : null;
    const desc = typeof description === 'string' ? description.slice(0, DESC_MAX) : null;
    try {
      const cashIn = await addCashIn({
        branchId, period, date: d, description: desc, amount: Number(amount),
        createdBy: req.user && req.user.user_id,
      });
      return res.status(201).json({ cashIn });
    } catch (e) {
      console.error('[petty-cash cash-in]', e.message);
      return res.status(502).json({ error: 'failed to add cash-in' });
    }
  });

  // DELETE /api/petty-cash/cash-in/:id — ADMIN ONLY. Hard delete (it's a ledger the admin owns).
  app.delete('/api/petty-cash/cash-in/:id', pettyCashOnly, pettyCashLimiter, checkDash, async (req, res) => {
    const s = req.scope;
    if (!s || s.role !== 'admin') return forbid(res);
    try {
      await deleteCashIn(req.params.id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[petty-cash cash-in delete]', e.message);
      return res.status(502).json({ error: 'failed to delete cash-in' });
    }
  });

  // GET /api/petty-cash?branch=&period= — the period summary
  // { float, cashIn, cashInHand, expenditure, balance, excluded, claims:{ ids, total } }.
  // Admin: any branch (branch param REQUIRED). Clerk: forced to their OWN branch (param ignored).
  app.get('/api/petty-cash', pettyCashOnly, pettyCashLimiter, checkDash, async (req, res) => {
    const s = req.scope;
    if (!s) return forbid(res);
    const period = req.query.period;
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    let branchId;
    if (s.role === 'clerk') {
      branchId = s.branch_id; // the bouncer: a clerk never reads another branch, param ignored
    } else {
      branchId = req.query.branch;
      if (typeof branchId !== 'string' || !branchId) return res.status(400).json({ error: 'branch is required' });
    }
    try {
      const summary = await getPeriodSummary({ branchId, period });
      return res.json(summary);
    } catch (e) {
      console.error('[petty-cash summary]', e.message);
      return res.status(502).json({ error: 'failed to load petty cash' });
    }
  });
};
