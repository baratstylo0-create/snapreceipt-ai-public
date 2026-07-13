'use strict';
const supabase = require('../lib/supabase');            // namespace import so tests can stub sbSelect
const { cfg } = require('../lib/config');
const { computeMetrics } = require('../lib/metrics');
const { checkDash, dashOrigin } = require('./expenses'); // reuse the same auth gate + CORS policy

// Same in-memory ceiling as reports: aggregate up to this many rows, flag if truncated
// rather than silently undercount. Move to a SQL RPC if an account ever exceeds it.
const METRICS_ROW_LIMIT = 10000;

const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);

// GET /api/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Automation-impact numbers for the Overview band (round-2 plan R2 / C4 backend). All
// aggregation lives in the pure lib/metrics.js; this route only fetches the scoped rows.
module.exports = function mountMetrics(app) {
  app.get('/api/metrics', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const from = isoDate(req.query.from);
      const to = isoDate(req.query.to);
      // Metrics measure PROCESSING throughput, so the window is on created_at (when we
      // ingested the receipt), not expense_date (the printed receipt date).
      let extra = 'deleted_at=is.null';
      if (from) extra += '&created_at=gte.' + from;
      if (to) extra += '&created_at=lte.' + to + 'T23:59:59.999Z';

      // Clerk is hard-scoped to their own branch at the DB (req.scope, business mode); admin
      // sees the whole account; personal mode (no scope) is unaffected. Unlike reports we do
      // NOT drop rejected rows — a rejected receipt was still processed (and counts as a
      // human-attention outcome), which is exactly what the automation-impact figure measures.
      const scope = req.scope;
      const rows = await supabase.sbSelect('expenses', {
        extra, order: 'created_at.desc', limit: METRICS_ROW_LIMIT, scope,
      });

      // category_corrections feeds "most-corrected categories". It has no branch_id column,
      // so it is fetched account-scoped only (no branch scope), and a failure here degrades
      // gracefully to an empty list rather than taking the whole metrics endpoint down.
      let corrections = [];
      try {
        corrections = await supabase.sbSelect('category_corrections', { limit: 1000 });
      } catch (e) {
        console.error('[api/metrics corrections]', e.message);
      }

      const metrics = computeMetrics(rows, {
        corrections,
        manualMinutesPerReceipt: cfg.MANUAL_MINUTES_PER_RECEIPT,
      });
      res.json({ ...metrics, fetched_count: rows.length, truncated: rows.length >= METRICS_ROW_LIMIT });
    } catch (e) {
      console.error('[api/metrics]', e.message);
      res.status(502).json({ error: 'metrics failed' });
    }
  });
};

module.exports.METRICS_ROW_LIMIT = METRICS_ROW_LIMIT;
