'use strict';
// #2 Excel export — HTTP surface. OWNER: Jeevan.
//   GET /api/excel?from=&to=  -> a real .xlsx download of the account's expenses,
//                                columns driven by the customer's FieldSpec (#12).
// Mirrors routes/reports.js's fetch/filter/fail-safe pattern exactly; reuses its
// hardened toAmount()/isISO() (via lib/excel.js and lib/reports.js) instead of
// re-implementing money/date validation.

const supabase = require('../lib/supabase');       // namespace import so tests can stub sbSelect
const templates = require('../lib/templates');     // namespace import so tests can stub getFieldSpec
const { buildWorkbook } = require('../lib/excel');
const { isISO } = require('../lib/reports');
const { cfg } = require('../lib/config');
const { getCapabilities } = require('../lib/account'); // business-mode gate (multiUser)
const { checkDash, dashOrigin } = require('./expenses'); // reuse the same auth gate + CORS policy

// Same cap philosophy as routes/reports.js's REPORT_ROW_LIMIT: never silently
// undercount a money export; signal truncation instead (via a header, since
// the response body here is a binary file, not JSON).
const EXCEL_ROW_LIMIT = 10000;

module.exports = function mountExcel(app) {
  app.get('/api/excel', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const from = isISO(req.query.from) ? String(req.query.from) : null;
      const to = isISO(req.query.to) ? String(req.query.to) : null;

      const rows = await supabase.sbSelect('expenses', {
        // status=neq.rejected: a rejected expense (#5 admin review queue) must
        // never appear in an exported ledger, matching the rule applied to #8.
        extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.desc', limit: EXCEL_ROW_LIMIT,
      });
      // Truncation reflects the raw DB row cap, NOT the post-date-filter count —
      // a full-history export that hit the cap is truncated even if the date
      // window later narrows it.
      const truncated = rows.length >= EXCEL_ROW_LIMIT;

      const filtered = rows.filter((e) => {
        if (!e) return false;
        const date = String(e.expense_date || '');
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });

      // Business mode (multiUser, Phase 3): a CLERK's export is scoped to their own branch
      // (req.scope set by checkDash); an admin exports everything. Personal mode: no scope, no
      // filter (unchanged).
      const business = getCapabilities().multiUser;
      const scope = req.scope;
      const scopedRows = (business && scope && scope.role === 'clerk')
        ? filtered.filter((e) => String(e.branch_id == null ? '' : e.branch_id) === String(scope.branch_id))
        : filtered;

      const fieldSpec = await templates.getFieldSpec();
      // Human-readable heading for the Summary sheet — same from/to values
      // already validated above, just phrased for a reader instead of a URL.
      const rangeLabel = !from && !to ? 'All time'
        : from && to && from === to ? from
        : (from || '…') + ' to ' + (to || '…');
      const buildOpts = { rangeLabel, generatedAt: new Date().toISOString(), currency: cfg.DEFAULT_CURRENCY };
      // Business exports carry Branch + Staff columns; resolve the ids to names once (id→office,
      // id→display_name). Personal exports omit both (buildWorkbook leaves the sheet unchanged).
      if (business) {
        const [branches, users] = await Promise.all([
          supabase.sbSelect('branches', {}),
          supabase.sbSelect('users', {}),
        ]);
        const branchNames = {}; for (const b of (branches || [])) branchNames[b.id] = b.office;
        const staffNames = {}; for (const u of (users || [])) staffNames[u.id] = u.display_name || u.username || '';
        buildOpts.branchStaff = true;
        buildOpts.branchNames = branchNames;
        buildOpts.staffNames = staffNames;
      }
      const workbook = buildWorkbook(scopedRows, fieldSpec, buildOpts);
      const buf = await workbook.xlsx.writeBuffer();

      // Filenames are built ONLY from already-ISO-validated strings (or fixed
      // literals) -- never raw query input -- to avoid a header-injection vector.
      const filename = 'expenses-' + (from || 'all') + '-' + (to || new Date().toISOString().slice(0, 10)) + '.xlsx';

      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
      if (truncated) res.set('X-Truncated', 'true');
      res.send(buf);
    } catch (e) {
      console.error('[api/excel]', e.message);
      res.status(502).json({ error: 'export failed' });
    }
  });
};

module.exports.EXCEL_ROW_LIMIT = EXCEL_ROW_LIMIT;
