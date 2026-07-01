'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { sbSelect, sbUpdate, sbSoftDelete } = require('../lib/supabase');

// Optional API gate (enabled only when DASHBOARD_TOKEN is set). Moved from server.js:220-225.
function checkDash(req, res, next) {
  if (!cfg.DASHBOARD_TOKEN) return next();
  const a = req.get('Authorization') || '';
  if (a === 'Bearer ' + cfg.DASHBOARD_TOKEN || req.query.key === cfg.DASHBOARD_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

module.exports = function mountExpenses(app) {
  app.get('/api/expenses', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const rows = await sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 2000 });
      res.json(rows);
    } catch (e) { console.error('[api/expenses]', e.message); res.status(502).json({ error: 'load failed' }); }
  });

  app.patch('/api/expenses/:id', checkDash, express.json({ limit: '1mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const allow = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark', 'subtotal', 'tax'];
      const body = {};
      for (const k of allow) if (req.body && k in req.body) body[k] = req.body[k];
      if (!Object.keys(body).length) return res.status(400).json({ error: 'no fields to update' });
      const rows = await sbUpdate('expenses', { id: req.params.id }, body);
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error('[patch expense]', e.message); res.status(502).json({ error: 'update failed' }); }
  });

  app.delete('/api/expenses/:id', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      await sbSoftDelete('expenses', { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { console.error('[delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
  });

  app.get('/api/config', (req, res) => res.json({ auth_required: !!cfg.DASHBOARD_TOKEN, default_currency: cfg.DEFAULT_CURRENCY }));
};

module.exports.checkDash = checkDash;
