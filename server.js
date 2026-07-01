/**
 * Receipt Analyser SaaS — server entry (wiring only).
 * All logic lives in lib/* and routes/*. See docs/ARCHITECTURE.md.
 */
'use strict';
const express = require('express');
const { cfg, assertConfig } = require('./lib/config');
const { registerWebhook } = require('./lib/telegram');

const mountWebhook = require('./routes/webhook');
const mountExpenses = require('./routes/expenses');
const mountReceipt = require('./routes/receipt');
const mountReports = require('./routes/reports');
const mountTemplates = require('./routes/templates');
const mountMisc = require('./routes/misc');
const mountReview = require('./routes/review'); // #5 admin review queue

assertConfig();

const app = express();
app.set('trust proxy', true);
mountWebhook(app);
mountExpenses(app);
mountReceipt(app);
mountReports(app);
mountTemplates(app);
mountMisc(app);
mountReview(app);

// Global error handler: body-parser (express.json/text) throws synchronously
// on malformed input, before any route's own try/catch runs. Without this,
// Express's default handler returns an HTML page with a full stack trace and
// server file paths to the client (SOP §7.2 — errors must never leak internals).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[unhandled]', err && err.message);
  const status = (err && (err.status || err.statusCode)) || 400;
  res.status(status < 500 ? status : 400).json({ error: 'invalid request' });
});

if (process.argv.includes('--register-only')) {
  registerWebhook().then(() => process.exit(0));
} else {
  app.listen(cfg.PORT, () => {
    console.log('[receipt-saas] listening on :' + cfg.PORT + '  (account: ' + cfg.ACCOUNT_ID + ')');
    setTimeout(registerWebhook, 1500);
  });
}
