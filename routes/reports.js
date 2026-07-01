'use strict';
const { sbSelect } = require('../lib/supabase');
const { buildReport } = require('../lib/reports');
const { checkDash } = require('./expenses'); // reuse the same optional API gate

// GET /api/reports?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
module.exports = function mountReports(app) {
  app.get('/api/reports', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const period = String(req.query.period || 'month');
      const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
      const from = iso(req.query.from);
      const to = iso(req.query.to);
      const rows = await sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'expense_date.desc', limit: 5000 });
      res.json(buildReport(rows, period, { from, to }));
    } catch (e) {
      console.error('[api/reports]', e.message);
      res.status(502).json({ error: 'report failed' });
    }
  });
};
