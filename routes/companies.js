'use strict';
// routes/companies.js (ADR-023 Phase 8): admin company CRUD for the Group→Company→Branch→Staff
// dimension. Flag-gated by capabilities.multiUser AND capabilities.companyDimension (both 404 with
// either OFF — the single-company product has no company layer). Every handler is role-guarded
// through req.scope (the frozen scopeForUser bouncer set by checkDash: admin → all companies;
// clerk → hard-filtered to their own company) — no route hand-rolls its own scope filter. Per-IP
// rate limiter (SEC-7); name server-validated + length-capped (SEC-5); no PII in logs.
const express = require('express');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { sbSelect, sbInsertReturning, sbUpdate } = require('../lib/supabase');
const { checkDash } = require('./expenses'); // shared auth gate: sets req.scope in business mode

// Generous default — an internal provisioning surface, not a public endpoint (SEC-7).
const companiesLimiter = createRateLimiter({ max: Number(process.env.COMPANIES_RATE_MAX) || 120 });
const NAME_MAX = 120;

// companyOnly — 404 the whole surface unless BOTH multiUser AND companyDimension are ON, before any
// auth work, so a client without the dimension behaves as if these routes don't exist.
function companyOnly(req, res, next) {
  const caps = getCapabilities();
  if (!caps.multiUser || !caps.companyDimension) return res.status(404).json({ error: 'not found' });
  return next();
}

const isAdmin = (req) => !!(req.scope && req.scope.role === 'admin');
const forbid = (res) => res.status(403).json({ error: 'forbidden' });

module.exports = function mountCompanies(app) {
  const json = express.json({ limit: '16kb' });

  // GET /api/companies — admin: all active companies. Clerk: hard-filtered to their OWN company
  // (the scope's company_id); a clerk with no company sees an empty list.
  app.get('/api/companies', companyOnly, companiesLimiter, checkDash, async (req, res) => {
    const s = req.scope;
    if (!s) return forbid(res);
    try {
      if (s.role === 'clerk') {
        if (!s.company_id) return res.json({ companies: [] });
        const companies = await sbSelect('companies', { eq: { id: s.company_id, active: true }, order: 'created_at.asc' });
        return res.json({ companies });
      }
      const companies = await sbSelect('companies', { eq: { active: true }, order: 'created_at.asc' });
      return res.json({ companies });
    } catch (e) {
      console.error('[companies list]', e.message);
      return res.status(502).json({ error: 'failed to list companies' });
    }
  });

  // POST /api/companies { name, currency?, template_id? } — admin-only. name required + length-capped.
  app.post('/api/companies', companyOnly, companiesLimiter, checkDash, json, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    const { name, currency, template_id } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const company = await sbInsertReturning('companies', {
        name: name.trim().slice(0, NAME_MAX),
        currency: currency ? String(currency).slice(0, 8) : null,
        template_id: template_id || null,
        active: true,
      });
      return res.status(201).json({ company });
    } catch (e) {
      console.error('[companies create]', e.message);
      return res.status(502).json({ error: 'failed to create company' });
    }
  });

  // DELETE /api/companies/:id — admin-only soft-delete (active=false). Refuse (409) while the
  // company still owns active branches — deactivating those is a deliberate, separate admin action
  // (we never orphan live branches out from under a company).
  app.delete('/api/companies/:id', companyOnly, companiesLimiter, checkDash, async (req, res) => {
    if (!isAdmin(req)) return forbid(res);
    try {
      const branches = await sbSelect('branches', { eq: { company_id: req.params.id, active: true } });
      if (branches.length) return res.status(409).json({ error: 'company still has active branches' });
      await sbUpdate('companies', { id: req.params.id }, { active: false });
      return res.json({ ok: true, company_id: req.params.id });
    } catch (e) {
      console.error('[companies delete]', e.message);
      return res.status(502).json({ error: 'failed to delete company' });
    }
  });
};
