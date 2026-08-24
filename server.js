/**
 * SnapReceipt AI — server entry (wiring only).
 * All logic lives in lib/* and routes/*. See docs/ARCHITECTURE.md.
 */
'use strict';
const express = require('express');
const { cfg, assertConfig, configSummary } = require('./lib/config');
const { registerWebhook, resolveBotUsername } = require('./lib/telegram');
const { ensureCredKey } = require('./lib/credCrypto');
const securityHeaders = require('./lib/security-headers');
const corsPreflight = require('./lib/cors-preflight');
const securityEvents = require('./lib/security-events'); // SEC-6 security-event logging (ADR-025)
const { logError } = require('./lib/log'); // #12 structured error logging
const sentry = require('./lib/sentry');

const mountWebhook = require('./routes/webhook');
const mountAuth = require('./routes/auth');       // ADR-021 business login (multiUser only)
const mountSessions = require('./routes/sessions'); // P-02a device sessions + auth timeline (#35)
const mountBranches = require('./routes/branches'); // ADR-021 Phase 2 provisioning (multiUser only)
const mountCompanies = require('./routes/companies'); // ADR-023 Phase 8 company dimension (companyDimension only)
const mountSubmissions = require('./routes/submissions'); // ADR-022 Phase 7 Send-to-Admin (branchSubmission only)
const mountPettyCash = require('./routes/pettyCash'); // ADR-023 Phase 9 petty-cash floats + claims (pettyCash only)
const mountStatement = require('./routes/statement'); // ADR-023/024 Phase 10 petty-cash statement export (pettyCash only)
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
const mountManageExport = require('./routes/manageExport'); // QA PR-F Manage/Data-editor exports (csv/xlsx/pdf-with-receipts)
const mountMetrics = require('./routes/metrics'); // R2/C4 automation-impact metrics (Overview band)
const mountGuest = require('./routes/guest'); // Guest Mode (2026-07-28) — /api/guest/start + /end (guestMode only)
const mountGoogleAuth = require('./routes/googleAuth'); // Google Sign-In (2026-07-30, personalAuth only)

assertConfig();
sentry.initSentry();

// Auto-provision the credential-encryption key (ADR-025 amendment) BEFORE serving, so the
// very first branch created has a key and its password is stored recoverably. Explicit
// CRED_ENC_KEY env wins; otherwise a key is generated once and persisted (see lib/credCrypto).
// Runs here (not in unit tests) so recoverable passwords "just work" on the live server with
// no manual config. Never logs the key value.
{
  const before = !!cfg.CRED_ENC_KEY;
  ensureCredKey();
  console.log('[receipt-saas] credential encryption key: ' + (before ? 'from env' : 'auto-provisioned (persisted)'));
}

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
// SEC-6 (ADR-025): mounted early so its res-'finish' hook observes every request's final
// status; logs auth failures / scope denials / rate-limit trips (no PII). See lib/security-events.js.
app.use(securityEvents);
mountWebhook(app);
mountAuth(app);
mountSessions(app);   // P-02a: /api/sessions* — device list, timeline, revoke (#35)
mountBranches(app);
mountCompanies(app);
mountSubmissions(app);
mountPettyCash(app);
mountStatement(app);
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
mountManageExport(app);
mountMetrics(app);
mountGuest(app);
mountGoogleAuth(app);

// Global error handler: body-parser (express.json/text) throws synchronously
// on malformed input, before any route's own try/catch runs. Without this,
// Express's default handler returns an HTML page with a full stack trace and
// server file paths to the client (SOP §7.2 — errors must never leak internals).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = (err && (err.status || err.statusCode)) || 400;
  const safe = status < 500 ? status : 400;
  // #12 structured error log — ADR-002 safe (message + scalar route context only; no body/PII).
  logError('unhandled', err, { status: safe, method: req.method, path: req.path });
  sentry.captureException(err, req, { status: safe });
  res.status(safe).json({ error: 'invalid request' });
});

if (process.argv.includes('--register-only')) {
  registerWebhook().then(() => process.exit(0));
} else {
  app.listen(cfg.PORT, () => {
    console.log('[receipt-saas] listening on :' + cfg.PORT + '  (' + configSummary() + ')');
    setTimeout(registerWebhook, 1500);
    // Auto-detect the bot's @handle from Telegram when BOT_USERNAME wasn't set, so the
    // dashboard's t.me/<bot>?start=<token> deep link is clickable (was showing the raw
    // token when the handle was blank). Non-blocking so it never delays /health; an
    // explicit BOT_USERNAME env var wins. /api/config reads cfg.BOT_USERNAME live, so the
    // real handle is served once this resolves (well before any human loads the dashboard).
    if (!cfg.BOT_USERNAME) {
      resolveBotUsername().then((u) => {
        if (u) { cfg.BOT_USERNAME = u; console.log('[receipt-saas] bot username auto-detected: @' + u); }
      });
    }
  });
}
