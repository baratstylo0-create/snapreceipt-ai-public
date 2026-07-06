'use strict';
const supabase = require('../lib/supabase');     // namespace import so tests can stub sbSelect
const { buildReport } = require('../lib/reports');
const { checkDash, dashOrigin } = require('./expenses'); // reuse the same auth gate + CORS policy

// Max rows pulled into memory for aggregation. If an account exceeds this, the report
// is TRUNCATED and we say so (never silently undercount a money report). For real scale,
// move aggregation into SQL (Supabase RPC) — tracked as a post-MVP improvement.
const REPORT_ROW_LIMIT = 10000;

// GET /api/reports?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
module.exports = function mountReports(app) {
  app.get('/api/reports', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const period = String(req.query.period || 'month');
      const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
      const from = iso(req.query.from);
      const to = iso(req.query.to);
      // Master-view grouping dimension (Phase 3): admin can group totals by branch/staff.
      const groupBy = (req.query.groupBy === 'branch' || req.query.groupBy === 'staff') ? req.query.groupBy : undefined;
      const staff = req.query.staff ? String(req.query.staff) : undefined;
      // Branch scope: a CLERK is hard-filtered to their own branch (they cannot pass another
      // branch via the query); an admin may drill into any branch via ?branch=. checkDash sets
      // req.scope in business mode (multiUser). In personal mode req.scope is undefined → no filter.
      const scope = req.scope;
      const branch = (scope && scope.role === 'clerk')
        ? scope.branch_id
        : (req.query.branch ? String(req.query.branch) : undefined);
      const rows = await supabase.sbSelect('expenses', {
        // status=neq.rejected: a rejected expense (#5 admin review queue) must never
        // count toward money totals, even though it isn't soft-deleted.
        extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.desc', limit: REPORT_ROW_LIMIT,
      });
      const report = buildReport(rows, period, { from, to, groupBy, branch, staff });
      const truncated = rows.length >= REPORT_ROW_LIMIT;
      res.json({ ...report, fetched_count: rows.length, truncated });
    } catch (e) {
      console.error('[api/reports]', e.message);
      res.status(502).json({ error: 'report failed' });
    }
  });
};

module.exports.REPORT_ROW_LIMIT = REPORT_ROW_LIMIT;
