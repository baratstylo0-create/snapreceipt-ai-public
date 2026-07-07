/**
 * Receipt Analyser SaaS — server entry (wiring only).
 * All logic lives in lib/* and routes/*. See docs/ARCHITECTURE.md.
 */
'use strict';
const express = require('express');
const { cfg, assertConfig, configSummary } = require('./lib/config');
const { registerWebhook } = require('./lib/telegram');
const securityHeaders = require('./lib/security-headers');
const corsPreflight = require('./lib/cors-preflight');

const mountWebhook = require('./routes/webhook');
const mountAuth = require('./routes/auth');       // ADR-021 business login (multiUser only)
const mountBranches = require('./routes/branches'); // ADR-021 Phase 2 provisioning (multiUser only)
const mountCompanies = require('./routes/companies'); // ADR-023 Phase 8 company dimension (companyDimension only)
const mountSubmissions = require('./routes/submissions'); // ADR-022 Phase 7 Send-to-Admin (branchSubmission only)
const mountExpenses = require('./routes/expenses');
const mountReceipt = require('./routes/receipt');
const mountReports = require('./routes/reports');
const mountTemplates = require('./routes/templates');
const mountExcel = require('./routes/excel');
const mountMisc = require('./routes/misc');
const mountReview = require('./routes/review'); // #5 admin review queue
const mountAgent = require('./routes/agent');   // #9 dashboard agent
const mountUpload = require('./routes/upload'); // #7 mass upload
const mountSettings = require('./routes/settings'); // per-account UI settings (category colours)

assertConfig();

const app = express();
app.set('trust proxy', true);
// Security headers (CSP + hardening) on every response, before any route mounts.
// Adds Cache-Control: no-store on data-bearing paths (/api/*, /receipt). Keeps a
// strict no-inline CSP that the external-only frontend (css/app.css + js/*.js)
// is built to satisfy. See lib/security-headers.js.
app.use(securityHeaders);
// CORS preflight (issue #53) — answers OPTIONS on /api/* + /receipt before any route/auth
// runs, so a cross-origin dashboard deploy (DASHBOARD_ORIGIN set) actually works.
app.use(corsPreflight);
mountWebhook(app);
mountAuth(app);
mountBranches(app);
mountCompanies(app);
mountSubmissions(app);
mountExpenses(app);
mountReceipt(app);
mountReports(app);
mountTemplates(app);
mountExcel(app);
mountMisc(app);
mountReview(app);
mountAgent(app);
mountUpload(app);
mountSettings(app);

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
    console.log('[receipt-saas] listening on :' + cfg.PORT + '  (' + configSummary() + ')');
    setTimeout(registerWebhook, 1500);
  });
}
