'use strict';
// routes/branches.js (ADR-021 Phase 2): admin branch CRUD + clerk-manages-own-branch-staff.
// Flag-gated by capabilities.multiUser (both 404 with the flag OFF — the personal product has no
// branches). Every handler is role-guarded through req.scope — the frozen scopeForUser bouncer set
// by checkDash (admin → all branches; clerk → hard-filtered to their own branch) — so no route
// hand-rolls its own scope filter. Each route carries a generous per-IP rate limiter (SEC-7). All
// provisioning logic lives in lib/branches.js; this file is only HTTP glue + authorization.
const express = require('express');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { sbSelect } = require('../lib/supabase');
const { logSecurity } = require('../lib/log');
const { checkDash } = require('./expenses'); // shared auth gate: sets req.scope in business mode
const {
  createBranch, listBranches, softDeleteBranch, addStaff, listStaff, removeStaff,
  getBranchCredentials, resetBranchPassword,
} = require('../lib/branches');

// Generous default — this is an internal provisioning surface, not a public endpoint (SEC-7).
const branchesLimiter = createRateLimiter({ max: Number(process.env.BRANCHES_RATE_MAX) || 120 });
// Cap on how many branches an account may hold; overridable per-account via an account_settings
// row (key 'max_branches', value {limit:N}); falls back to a generous default.
const DEFAULT_MAX_BRANCHES = Number(process.env.MAX_BRANCHES_DEFAULT) || 50;

// businessOnly — 404 the whole surface when multiUser is OFF (before any auth work), so the
// personal product behaves as if these routes don't exist.
function businessOnly(req, res, next) {
  if (!getCapabilities().multiUser) return res.status(404).json({ error: 'not found' });
  return next();
}

const isAdmin = (req) => !!(req.scope && req.scope.role === 'admin');
// A clerk may act only on their own branch; an admin may act on any branch.
function canManageBranch(req, branchId) {
  const s = req.scope;
  if (!s) return false;
  if (s.role === 'admin') return true;
  if (s.role === 'clerk') return String(s.branch_id) === String(branchId);
  return false;
}
const forbid = (res) => res.status(403).json({ error: 'forbidden' });

async function getMaxBranches() {
  try {
    const rows = await sbSelect('account_settings', { eq: { key: 'max_branches' }, limit: 1 });
    const v = rows[0] && rows[0].value;
    const lim = typeof v === 'number' ? v : (v && Number(v.limit));
    if (Number.isFinite(lim) && lim > 0) return lim;
  } catch { /* fall through to the default */ }
  return DEFAULT_MAX_BRANCHES;
}

module.exports = function mountBranches(app) {
  const json = express.json({ limit: '16kb' });

  // GET /api/branches — admin: list all active branches.
  app.get('/api/branches', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    try {
      const branches = await listBranches({});
      return res.json({ branches });
    } catch (e) {
      console.error('[branches list]', e.message);
      return res.status(502).json({ error: 'failed to list branches' });
    }
  });

  // POST /api/branches — admin: create a branch (+ auto-provisioned clerk creds shown ONCE +
  // one-time bot-binding token). Enforces max_branches.
  app.post('/api/branches', businessOnly, branchesLimiter, checkDash, json, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    const { office, state, clerkName, companyId } = req.body || {};
    if (!office || typeof office !== 'string') return res.status(400).json({ error: 'office is required' });
    try {
      const [max, existing] = await Promise.all([getMaxBranches(), listBranches({})]);
      if (existing.length >= max) return res.status(403).json({ error: 'branch limit reached (' + max + ')' });
      // ADR-023 Phase 8: an admin may attach the new branch to a company (companyDimension clients);
      // omitted → null (single-company / pre-Phase-8 behaviour unchanged). createBranch stamps it.
      const r = await createBranch({ office, state, clerkName, companyId: companyId || null });
      // credentials.password is the ONLY place the plaintext appears — the client shows it once.
      return res.status(201).json({ branch: r.branch, credentials: r.credentials, bindToken: r.bindToken });
    } catch (e) {
      console.error('[branches create]', e.message);
      return res.status(502).json({ error: 'failed to create branch' });
    }
  });

  // DELETE /api/branches/:id — admin: soft-delete (deactivate + revoke sessions + kill bindings).
  app.delete('/api/branches/:id', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    try {
      const r = await softDeleteBranch(req.params.id);
      return res.json(r);
    } catch (e) {
      console.error('[branches delete]', e.message);
      return res.status(502).json({ error: 'failed to delete branch' });
    }
  });

  // GET /api/branches/:id/credentials — admin: view a branch's login AGAIN (ADR-025
  // amendment, Owner-approved). `password` is null for a legacy branch (no encrypted
  // copy on file) — the client shows "no password on file, use Reset" for that case.
  // Every access is logged (who/when/which branch) via the security-event channel —
  // this is real sensitive-data re-display, not a one-time show.
  app.get('/api/branches/:id/credentials', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    try {
      const creds = await getBranchCredentials(req.params.id);
      if (!creds) return res.status(404).json({ error: 'not found' });
      logSecurity('cred_view', { branch_id: String(req.params.id), admin_user_id: String((req.user && req.user.user_id) || '') });
      return res.json(creds);
    } catch (e) {
      console.error('[branches credentials]', e.message);
      return res.status(502).json({ error: 'failed to load credentials' });
    }
  });

  // POST /api/branches/:id/reset-password — admin: issue a fresh password (revokes the
  // clerk's existing sessions). Covers the legacy-branch case above and lets an admin
  // rotate a credential on suspicion of compromise, same "show once" contract as create.
  app.post('/api/branches/:id/reset-password', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    try {
      const credentials = await resetBranchPassword(req.params.id);
      logSecurity('cred_reset', { branch_id: String(req.params.id), admin_user_id: String((req.user && req.user.user_id) || '') });
      return res.json({ credentials });
    } catch (e) {
      console.error('[branches reset-password]', e.message);
      return res.status(502).json({ error: 'failed to reset password' });
    }
  });

  // GET /api/branches/:id/staff — admin (any) or clerk (own branch): list the branch's staff.
  app.get('/api/branches/:id/staff', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    if (!canManageBranch(req, req.params.id)) return forbid(res);
    try {
      const staff = await listStaff(req.params.id);
      return res.json({ staff });
    } catch (e) {
      console.error('[staff list]', e.message);
      return res.status(502).json({ error: 'failed to list staff' });
    }
  });

  // POST /api/branches/:id/staff — admin (any) or clerk (own branch): add a name-only staff row.
  app.post('/api/branches/:id/staff', businessOnly, branchesLimiter, checkDash, json, async (req, res) => {
    if (!canManageBranch(req, req.params.id)) return forbid(res);
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    try {
      const staff = await addStaff({ branchId: req.params.id, name });
      return res.status(201).json({ staff });
    } catch (e) {
      console.error('[staff add]', e.message);
      return res.status(502).json({ error: 'failed to add staff' });
    }
  });

  // DELETE /api/staff/:id — admin (any) or clerk (own branch): soft-remove a staff row. The clerk
  // check needs the staff row's branch, so we look it up first (admins skip the branch check).
  app.delete('/api/staff/:id', businessOnly, branchesLimiter, checkDash, async (req, res) => {
    try {
      if (!isAdmin(req)) {
        const rows = await sbSelect('users', { eq: { id: req.params.id }, limit: 1 });
        const staff = rows[0];
        if (!staff) return res.status(404).json({ error: 'not found' });
        if (!canManageBranch(req, staff.branch_id)) return forbid(res);
      }
      const r = await removeStaff(req.params.id);
      return res.json(r);
    } catch (e) {
      console.error('[staff remove]', e.message);
      return res.status(502).json({ error: 'failed to remove staff' });
    }
  });
};
