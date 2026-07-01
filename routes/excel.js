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
const { checkDash } = require('./expenses');       // reuse the same optional API gate

// Same cap philosophy as routes/reports.js's REPORT_ROW_LIMIT: never silently
// undercount a money export; signal truncation instead (via a header, since
// the response body here is a binary file, not JSON).
const EXCEL_ROW_LIMIT = 10000;

module.exports = function mountExcel(app) {
  app.get('/api/excel', checkDash, async (req, res) => {
    try {
      const from = isISO(req.query.from) ? String(req.query.from) : null;
      const to = isISO(req.query.to) ? String(req.query.to) : null;

      const rows = await supabase.sbSelect('expenses', {
        // status=neq.rejected: a rejected expense (#5 admin review queue) must
        // never appear in an exported ledger, matching the rule applied to #8.
        extra: 'deleted_at=is.null&status=neq.rejected', order: 'expense_date.desc', limit: EXCEL_ROW_LIMIT,
      });
      const truncated = rows.length >= EXCEL_ROW_LIMIT;

      const filtered = rows.filter((e) => {
        if (!e) return false;
        const date = String(e.expense_date || '');
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });

      const fieldSpec = await templates.getFieldSpec();
      const workbook = buildWorkbook(filtered, fieldSpec);
      const buf = await workbook.xlsx.writeBuffer();

      // Filenames are built ONLY from already-ISO-validated strings (or fixed
      // literals) -- never raw query input -- to avoid a header-injection vector.
      const filename = 'expenses-' + (from || 'all') + '-' + (to || new Date().toISOString().slice(0, 10)) + '.xlsx';

      res.set('Access-Control-Allow-Origin', '*');
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
