'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { cfg } = require('../lib/config');
const { sbSelect, sbUpdate, sbSoftDelete } = require('../lib/supabase');
const { recordCorrection } = require('../lib/categorize'); // #6 learning loop
const { createRateLimiter } = require('../lib/ratelimit');

// P6 abuse defense (§4.4): checkDash IS the auth gate for every dashboard/API route (they all
// import it from here) — without a limit it's brute-forceable (guess DASHBOARD_TOKEN). Runs
// before the token check on every gated route, so a flood of bad-token attempts gets 429'd
// regardless of which endpoint it targets. DASH_AUTH_RATE_MAX follows Barat's WEBHOOK_RATE_MAX
// naming convention; reuses the shared lib/ratelimit.js limiter.
const dashAuthLimiter = createRateLimiter({ max: Number(process.env.DASH_AUTH_RATE_MAX) || 60 });

// Constant-time token comparison (Task J security-QA F1): a plain `===` short-circuits on
// the first mismatched byte, which is theoretically timing-observable. timingSafeEqual needs
// equal-length buffers, so we length-check first (token length is not secret) and only compare
// in constant time when lengths match. Belt-and-braces with the per-IP rate limiter above.
function safeTokenEqual(presented, secret) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(secret));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// API gate. Moved from server.js:220-225; hardened P6 (§4.3 — was fail-OPEN: any request
// was let through when DASHBOARD_TOKEN was unset, on every route that reuses this gate,
// including the receipt-image proxy). Now fail-CLOSED in production:
//   - cfg.AUTH_REQUIRED (NODE_ENV=production, or AUTH_REQUIRED=true for staging/other envs)
//     + no DASHBOARD_TOKEN configured -> refuse everything with a clear "server misconfigured"
//     500, never a silent pass-through. This is deliberately NOT a 401 (401 implies "you can
//     fix this by authenticating"; here nobody can, until the operator sets a token).
//   - otherwise (local/dev, no AUTH_REQUIRED) + no token -> keep today's permissive behavior
//     so `npm start` with an empty .env still works out of the box, but log a loud warning on
//     every request that slips through unauthenticated so it's never silently forgotten.
// Production MUST set DASHBOARD_TOKEN — see README.md and .env.example.
function checkDash(req, res, next) {
  // Rate-limit the gate itself first (per-IP), before spending any work on the token
  // comparison — brute-forcing DASHBOARD_TOKEN is the threat this defends against.
  return dashAuthLimiter(req, res, () => {
    if (!cfg.DASHBOARD_TOKEN) {
      if (cfg.AUTH_REQUIRED) {
        return res.status(500).json({ error: 'server misconfigured: DASHBOARD_TOKEN is required in production' });
      }
      console.warn('[checkDash] WARNING: DASHBOARD_TOKEN is not set — request allowed unauthenticated (dev-only fallback):', req.method, req.originalUrl);
      return next();
    }
    // Header-only auth (Task J security-QA F2): the `?key=` query path was dropped — tokens in
    // URLs leak to browser history / proxy logs. The dashboard client always sends the bearer
    // header (Excel/receipt downloads use an authed blob fetch, not a query-param'd link).
    const a = req.get('Authorization') || '';
    const presented = a.startsWith('Bearer ') ? a.slice(7) : '';
    if (safeTokenEqual(presented, cfg.DASHBOARD_TOKEN)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });
}

// P6 hardening (§4.5): Access-Control-Allow-Origin was hardcoded to '*' on every token-gated
// route. With a bearer token, '*' lets ANY origin call the API cross-site. Reflect
// cfg.DASHBOARD_ORIGIN when the operator has set one (production); fall back to '*' only
// when unset, so local dev (no known origin yet) keeps working out of the box. Shared here
// since every other route file already imports checkDash from this module.
function dashOrigin() { return cfg.DASHBOARD_ORIGIN || '*'; }

module.exports = function mountExpenses(app) {
  app.get('/api/expenses', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const rows = await sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 2000 });
      res.json(rows);
    } catch (e) { console.error('[api/expenses]', e.message); res.status(502).json({ error: 'load failed' }); }
  });

  app.patch('/api/expenses/:id', checkDash, express.json({ limit: '1mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const allow = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark', 'subtotal', 'tax'];
      const body = {};
      for (const k of allow) if (req.body && k in req.body) body[k] = req.body[k];
      if (!Object.keys(body).length) return res.status(400).json({ error: 'no fields to update' });
      const rows = await sbUpdate('expenses', { id: req.params.id }, body);
      // #6 learning: a manual category edit is ground truth — remember it for future receipts
      // (best-effort, non-blocking; never fails the request).
      if ('category' in body && rows[0]) {
        recordCorrection(rows[0].merchant, rows[0].remark, body.category).catch(() => {});
      }
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error('[patch expense]', e.message); res.status(502).json({ error: 'update failed' }); }
  });

  app.delete('/api/expenses/:id', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      await sbSoftDelete('expenses', { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { console.error('[delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
  });

  app.get('/api/config', (req, res) => res.json({ auth_required: !!cfg.DASHBOARD_TOKEN, default_currency: cfg.DEFAULT_CURRENCY }));
};

module.exports.checkDash = checkDash;
module.exports.dashOrigin = dashOrigin;
