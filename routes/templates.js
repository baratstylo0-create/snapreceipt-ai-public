'use strict';
// #12 Custom Field Template — HTTP surface. OWNER: Barat.
//   GET  /api/templates   -> the account's current FieldSpec (or the default one)
//   POST /api/templates   -> import a CSV template (text/csv body or JSON {csv}),
//                            parse + store, return the resulting FieldSpec
// Backed by the frozen lib/templates.js engine (ARCHITECTURE §3.1). CSV is
// UNTRUSTED input (SOP §7.2): body size is capped here and parseTemplate() caps
// column count / label length and rejects malformed input.

const express = require('express');
const { getFieldSpec, saveTemplate, parseExcelTemplate } = require('../lib/templates');
const { checkDash } = require('./expenses'); // reuse the optional dashboard-token gate
const { createRateLimiter } = require('../lib/ratelimit');

const BODY_LIMIT = '256kb';
// A real .xlsx is a zipped-XML binary — bigger than a CSV of the same field
// count, and it's still just a header row we read (data rows are ignored),
// so this stays well clear of the mass-upload/PDF size limits elsewhere.
const EXCEL_BODY_LIMIT = '2mb';
// Content-Types a browser/OS may report for an .xlsx: the real MIME type, plus
// generic octet-stream (some browsers omit the specific type on drag-and-drop).
const EXCEL_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];
// P6 abuse defense: cap per-IP requests on the template routes (POST parses untrusted
// CSV; both are behind the optional token, so a limiter also blunts token brute-force).
// Tune via TEMPLATES_RATE_MAX. Runs before auth/body-parsing so limited requests are cheap.
const templatesLimiter = createRateLimiter({ max: Number(process.env.TEMPLATES_RATE_MAX) || 60 });

module.exports = function mountTemplates(app) {
  // Current field spec for the account.
  app.get('/api/templates', templatesLimiter, checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      res.json(await getFieldSpec());
    } catch (e) {
      console.error('[api/templates get]', e.message);
      res.status(502).json({ error: 'load failed' });
    }
  });

  // Import a CSV OR a real Excel (.xlsx) template. Accepts a raw text/csv
  // (or text/plain) body, a JSON body { csv: "...", name?: "..." }, or a raw
  // binary .xlsx body (Content-Type: the spreadsheet MIME type, or
  // application/octet-stream). Optional ?name= to store under a name.
  app.post('/api/templates',
    templatesLimiter,
    checkDash,
    express.raw({ type: EXCEL_TYPES, limit: EXCEL_BODY_LIMIT }),
    express.text({ type: ['text/*'], limit: BODY_LIMIT }),
    express.json({ limit: BODY_LIMIT }),
    async (req, res) => {
      res.set('Access-Control-Allow-Origin', '*');
      try {
        const name = String(req.query.name || (req.body && req.body.name) || 'default').slice(0, 64);

        if (Buffer.isBuffer(req.body)) {
          if (req.body.length === 0) {
            return res.status(400).json({ error: 'provide a CSV file/text, or an Excel (.xlsx) file' });
          }
          const columns = await parseExcelTemplate(req.body);
          const spec = await saveTemplate(columns, { name });
          return res.json(spec);
        }

        const csv = typeof req.body === 'string' ? req.body : (req.body && req.body.csv);
        if (typeof csv !== 'string' || csv.trim() === '') {
          return res.status(400).json({ error: 'provide CSV text (text/csv body, or JSON {"csv": "..."}), or an Excel (.xlsx) file' });
        }
        // Optional business category set (ADR-021): only the JSON body can carry it
        // ({ csv, name?, categories? }); text/csv and .xlsx uploads never touch the
        // stored set (saveTemplate leaves it as-is when categories is undefined).
        const categories = (req.body && typeof req.body === 'object') ? req.body.categories : undefined;
        const spec = await saveTemplate(csv, { name, categories });
        res.json(spec);
      } catch (e) {
        // parseTemplate/saveTemplate throw on invalid input -> client error (400);
        // anything else is an upstream/DB failure -> 502.
        if (/^(parseTemplate|parseExcelTemplate|saveTemplate):/.test(e.message)) {
          return res.status(400).json({ error: e.message });
        }
        console.error('[api/templates post]', e.message);
        res.status(502).json({ error: 'save failed' });
      }
    },
    // express.json()/express.text() throw synchronously on malformed bodies
    // (bad JSON, unsupported charset) before the handler above ever runs.
    // Without a route-local catch, that error falls through to Express's
    // default handler, which leaks a stack trace + server file paths to the
    // client (SOP §7.2). Keep this self-contained here so the route is safe
    // regardless of what app mounts it (matches its own test harness).
    (err, req, res, next) => {
      if (res.headersSent) return next(err);
      console.error('[api/templates post] body-parser error:', err && err.message);
      res.status(400).json({ error: 'malformed request body' });
    });
};
