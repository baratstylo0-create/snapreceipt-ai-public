'use strict';
// routes/submissions.js (ADR-022 Phase 7): the "Send to Admin" branch hand-off.
//
// A clerk submits their branch's period (month) to the admin IN-dashboard — replacing the
// WhatsApp/chat-app file hand-off. The data never moves (rows-not-workbooks, ADR-021): a
// submission is a lightweight, audit-trailed state row (who / branch / period / when), one per
// (branch, period) — a re-submit UPDATES it, a withdraw flips status without deleting the audit.
//
// Gating (ADR-022): the whole surface 404s unless BOTH capabilities.multiUser AND
// capabilities.branchSubmission are ON — a general flag-gated feature, on for clients with a
// document-handoff culture (Premala), invisible everywhere else. Auth = the shared checkDash
// (opaque sessions → req.scope, the frozen scopeForUser bouncer): the clerk's branch comes from
// the SESSION, never the request body, so a clerk structurally cannot submit another branch
// (SEC-2). Per-route rate limiter (SEC-7); period/note server-validated (SEC-5).
const express = require('express');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { sbSelect, sbInsertReturning, sbUpdate } = require('../lib/supabase');
const { checkDash } = require('./expenses');

const submissionsLimiter = createRateLimiter({ max: Number(process.env.SUBMISSIONS_RATE_MAX) || 60 });
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // 'YYYY-MM', a real month
const NOTE_MAX = 300;

// 404 the whole surface unless the client profile turns the hand-off on.
function submissionOnly(req, res, next) {
  const caps = getCapabilities();
  if (!caps.multiUser || !caps.branchSubmission) return res.status(404).json({ error: 'not found' });
  return next();
}

const forbid = (res) => res.status(403).json({ error: 'forbidden' });

module.exports = function mountSubmissions(app) {
  const json = express.json({ limit: '16kb' });

  // POST /api/submissions { period, note? } — CLERK ONLY (the hand-off is clerk → admin; an
  // admin has nobody to send to). Branch + submitter come from the session scope. Upsert
  // semantics on (branch, period): insert the first time (201), update thereafter (200) —
  // status back to 'submitted', timestamp bumped — so a withdraw → fix → re-send just works.
  app.post('/api/submissions', submissionOnly, submissionsLimiter, checkDash, json, async (req, res) => {
    const s = req.scope;
    if (!s || s.role !== 'clerk') return forbid(res);
    const { period } = req.body || {};
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
      return res.status(400).json({ error: 'period must be YYYY-MM' });
    }
    const note = typeof (req.body || {}).note === 'string' ? req.body.note.slice(0, NOTE_MAX) : null;
    try {
      const existing = await sbSelect('submissions', { eq: { branch_id: s.branch_id, period }, limit: 1 });
      if (existing[0]) {
        const rows = await sbUpdate('submissions', { id: existing[0].id }, {
          status: 'submitted', note, submitted_by: req.user && req.user.user_id,
          submitted_at: new Date().toISOString(),
        });
        return res.json({ submission: rows[0] || { ...existing[0], status: 'submitted' } });
      }
      const submission = await sbInsertReturning('submissions', {
        branch_id: s.branch_id, period, note,
        submitted_by: req.user && req.user.user_id,
        status: 'submitted', submitted_at: new Date().toISOString(),
      });
      return res.status(201).json({ submission });
    } catch (e) {
      console.error('[submissions create]', e.message);
      return res.status(502).json({ error: 'failed to submit' });
    }
  });

  // GET /api/submissions[?period=YYYY-MM] — admin: every branch's submissions (their inbox);
  // clerk: hard-filtered to their own branch (their own send/withdraw history).
  app.get('/api/submissions', submissionOnly, submissionsLimiter, checkDash, async (req, res) => {
    const s = req.scope;
    if (!s) return forbid(res);
    const eq = {};
    const period = req.query.period;
    if (period != null) {
      if (!PERIOD_RE.test(String(period))) return res.status(400).json({ error: 'period must be YYYY-MM' });
      eq.period = String(period);
    }
    if (s.role === 'clerk') eq.branch_id = s.branch_id; // the bouncer: clerks never see other branches
    try {
      const submissions = await sbSelect('submissions', { eq, order: 'submitted_at.desc', limit: 500 });
      return res.json({ submissions });
    } catch (e) {
      console.error('[submissions list]', e.message);
      return res.status(502).json({ error: 'failed to list submissions' });
    }
  });

  // PATCH /api/submissions/:id { status: 'withdrawn' | 'submitted' } — the reversibility valve,
  // CLERK OWN-BRANCH ONLY (the submitting branch controls its submission's state; the admin's
  // side is read-only in v1 so the audit trail stays one-directional).
  app.patch('/api/submissions/:id', submissionOnly, submissionsLimiter, checkDash, json, async (req, res) => {
    const s = req.scope;
    if (!s || s.role !== 'clerk') return forbid(res);
    const { status } = req.body || {};
    if (status !== 'withdrawn' && status !== 'submitted') {
      return res.status(400).json({ error: 'status must be submitted or withdrawn' });
    }
    try {
      const rows = await sbSelect('submissions', { eq: { id: req.params.id }, limit: 1 });
      const sub = rows[0];
      if (!sub) return res.status(404).json({ error: 'not found' });
      if (String(sub.branch_id) !== String(s.branch_id)) return forbid(res);
      const updated = await sbUpdate('submissions', { id: sub.id }, {
        status, submitted_at: new Date().toISOString(),
      });
      return res.json({ submission: updated[0] || { ...sub, status } });
    } catch (e) {
      console.error('[submissions patch]', e.message);
      return res.status(502).json({ error: 'failed to update submission' });
    }
  });
};
