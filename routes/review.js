'use strict';
// #5 admin review queue. New route file (kept separate from routes/expenses.js to stay
// collision-safe with concurrent feature PRs). Mounted in server.js.
const express = require('express');
const supabase = require('../lib/supabase');   // namespace so tests can stub sbSelect/sbUpdate
const { checkDash, dashOrigin } = require('./expenses'); // reuse the same auth gate + CORS policy

const DECISION_STATUS = { approve: 'approved', reject: 'rejected' };

module.exports = function mountReview(app) {
  // GET /api/review — the admin queue: expenses awaiting an accept/reject decision.
  app.get('/api/review', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const rows = await supabase.sbSelect('expenses', {
        eq: { status: 'needs_review' }, extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 500,
      });
      res.json(rows);
    } catch (e) {
      console.error('[api/review]', e.message);
      res.status(502).json({ error: 'review load failed' });
    }
  });

  // POST /api/review/:id { decision: 'approve'|'reject', note? } — admin decision.
  // Records the audit trail into the existing expenses.anomaly jsonb (no schema change needed).
  app.post('/api/review/:id', checkDash, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const decision = req.body && req.body.decision;
      const status = DECISION_STATUS[decision];
      if (!status) return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
      const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;

      const existing = await supabase.sbSelect('expenses', { eq: { id: req.params.id } });
      const cur = existing[0];
      if (!cur) return res.status(404).json({ error: 'expense not found' });
      // Status machine (saved → needs_review → approved|rejected): only a pending expense may be
      // decided. Reject re-decision of an already-approved/rejected row or a never-flagged 'saved' one.
      if (cur.status !== 'needs_review') {
        return res.status(409).json({ error: 'expense is not pending review (status=' + cur.status + ')' });
      }
      const anomaly = (cur.anomaly && typeof cur.anomaly === 'object' && !Array.isArray(cur.anomaly)) ? cur.anomaly : {};
      anomaly.review = { decision, note, at: new Date().toISOString() };

      const rows = await supabase.sbUpdate('expenses', { id: req.params.id }, { status, anomaly });
      res.json(rows[0] || { ok: true, status });
    } catch (e) {
      console.error('[api/review decision]', e.message);
      res.status(502).json({ error: 'review update failed' });
    }
  });
};
