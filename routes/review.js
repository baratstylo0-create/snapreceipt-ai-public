'use strict';
// #5 admin review queue. New route file (kept separate from routes/expenses.js to stay
// collision-safe with concurrent feature PRs). Mounted in server.js.
const express = require('express');
const supabase = require('../lib/supabase');   // namespace so tests can stub sbSelect/sbUpdate
const { checkDash, dashOrigin } = require('./expenses'); // reuse the same auth gate + CORS policy
const { resolveDecision, canRoleDecide, buildReviewAudit } = require('../lib/reviewDecision');

// Phase 4 (ADR-021): how long a flagged item waits for its branch clerk before the admin may
// force-decide it (the safety valve). Business mode only; personal mode never consults it.
const ANOMALY_VALVE_DAYS = Number(process.env.ANOMALY_VALVE_DAYS) || 7;

module.exports = function mountReview(app) {
  // GET /api/review — the review queue: expenses awaiting an accept/reject decision.
  // Business mode: a clerk sees only their own branch's queue (req.scope, the frozen bouncer);
  // the admin sees all. Personal mode: unchanged (no scope → no filter).
  app.get('/api/review', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const rows = await supabase.sbSelect('expenses', {
        eq: { status: 'needs_review' }, extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 500,
        scope: req.scope, // #131: clerk queue hard-filtered to their branch at the DB (the in-memory filter below is the belt)
      });
      const scope = req.scope;
      const visible = (scope && scope.role === 'clerk')
        ? rows.filter((e) => String(e.branch_id == null ? '' : e.branch_id) === String(scope.branch_id))
        : rows;
      res.json(visible);
    } catch (e) {
      console.error('[api/review]', e.message);
      res.status(502).json({ error: 'review load failed' });
    }
  });

  // POST /api/review/:id { decision: 'approve'|'reject', note? } — a decision.
  // Records the audit trail into the existing expenses.anomaly jsonb (no schema change needed).
  // Business mode (Phase 4): staff-first — the branch clerk decides first; the admin may override
  // an existing decision any time but may originate only after ANOMALY_VALVE_DAYS (Head-Office /
  // untagged rows are admin-first). Personal mode: the old pending-only rule, unchanged.
  app.post('/api/review/:id', checkDash, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const decision = req.body && req.body.decision;
      const resolved = resolveDecision(decision);
      if (!resolved.ok) return res.status(400).json({ error: resolved.error });
      const status = resolved.status;
      const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;

      const existing = await supabase.sbSelect('expenses', { eq: { id: req.params.id } });
      const cur = existing[0];
      const decidable = canRoleDecide(cur, req.scope || null, { valveDays: ANOMALY_VALVE_DAYS });
      if (!decidable.ok) return res.status(decidable.code).json({ error: decidable.error });
      const who = req.scope && req.scope.role
        ? { role: req.scope.role, override: !!decidable.override } : null;
      const anomaly = buildReviewAudit(cur.anomaly, decision, note, who);

      const rows = await supabase.sbUpdate('expenses', { id: req.params.id, scope: req.scope }, { status, anomaly });
      res.json(rows[0] || { ok: true, status });
    } catch (e) {
      console.error('[api/review decision]', e.message);
      res.status(502).json({ error: 'review update failed' });
    }
  });
};
