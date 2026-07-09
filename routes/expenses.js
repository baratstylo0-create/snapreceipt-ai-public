'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { cfg } = require('../lib/config');
const { sbSelect, sbUpdate, sbSoftDelete, sbHardDelete } = require('../lib/supabase');
const { hreq } = require('../lib/http'); // Phase 4 bulk-pay: chunked id=in.(…) PATCH (multi-row, unlike sbUpdate)
const { recordCorrection, CATEGORIES } = require('../lib/categorize'); // #6 learning loop
const { getFieldSpec } = require('../lib/templates'); // read-only: the account's own chart of accounts
const { createRateLimiter } = require('../lib/ratelimit');
const { sanitizeExpensePatch } = require('../lib/expenseValidation');
const { getCapabilities } = require('../lib/account'); // ADR-010 flags (multiUser)
const { lookupSession, scopeForUser } = require('../lib/auth'); // ADR-021 business identity

// P6 abuse defense (§4.4): checkDash IS the auth gate for every dashboard/API route (they all
// import it from here) — without a limit it's brute-forceable (guess DASHBOARD_TOKEN). Runs
// before the token check on every gated route, so a flood of bad-token attempts gets 429'd
// regardless of which endpoint it targets. DASH_AUTH_RATE_MAX follows Barat's WEBHOOK_RATE_MAX
// naming convention; reuses the shared lib/ratelimit.js limiter.
const dashAuthLimiter = createRateLimiter({ max: Number(process.env.DASH_AUTH_RATE_MAX) || 60 });

// Phase 4 (ADR-021) payments knobs. BULK_PAY_CHUNK bounds each PostgREST id=in.(…) PATCH (URL
// length + row-lock scope); BULK_PAY_MAX_IDS bounds one request's total work (DoS-adjacent).
// The M2 route carries its own generous rate limiter (SEC-7).
const BULK_PAY_CHUNK = Number(process.env.BULK_PAY_CHUNK) || 100;
const BULK_PAY_MAX_IDS = Number(process.env.BULK_PAY_MAX_IDS) || 1000;
const paymentsLimiter = createRateLimiter({ max: Number(process.env.PAYMENTS_RATE_MAX) || 60 });

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
//
// Business mode (ADR-021): when capabilities.multiUser is ON, the single static
// DASHBOARD_TOKEN is replaced by per-user opaque SESSIONS. The bearer is resolved via
// lookupSession → { account_id, branch_id, role }, attached to req as req.user/req.scope
// (the frozen scopeForUser contract) for downstream branch-scoped queries. The personal
// path below is left byte-for-byte unchanged when the flag is OFF, so all existing
// (~1104) personal tests are unaffected.
function checkDash(req, res, next) {
  if (getCapabilities().multiUser) return checkDashSession(req, res, next);
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
  // A VALID token is never brute-force — let it straight through, NOT through the limiter.
  // (Review finding A#1: the shared per-IP dashAuthLimiter previously counted EVERY gated
  // request, so the card view's ~20 receipt-thumbnail fetches per page could 429 a legit
  // user. The brute-force threat is *failed* guesses, so only those are rate-limited.)
  if (safeTokenEqual(presented, cfg.DASHBOARD_TOKEN)) return next();
  // Failed auth → rate-limit the attempts (per-IP) to blunt token brute-force, then 401.
  return dashAuthLimiter(req, res, () => res.status(401).json({ error: 'unauthorized' }));
}

// Business-mode gate (multiUser ON): resolve an opaque session bearer to a scoped
// identity. A VALID session bypasses the limiter (like the valid-token path above —
// only FAILED auth is rate-limited, so a busy dashboard's many fetches never 429 a
// legit user). On success, req.user + req.scope are set for downstream scoping.
async function checkDashSession(req, res, next) {
  const a = req.get('Authorization') || '';
  const presented = a.startsWith('Bearer ') ? a.slice(7) : '';
  const deny = () => dashAuthLimiter(req, res, () => res.status(401).json({ error: 'unauthorized' }));
  if (!presented) return deny();
  try {
    const sess = await lookupSession(presented);
    if (!sess) return deny();
    req.user = sess;
    req.scope = scopeForUser(sess); // frozen contract; throws only on a corrupt session row
    return next();
  } catch (e) {
    console.error('[checkDash session]', e.message);
    return res.status(502).json({ error: 'auth check failed' });
  }
}

// P6 hardening (§4.5): Access-Control-Allow-Origin was hardcoded to '*' on every token-gated
// route. With a bearer token, '*' lets ANY origin call the API cross-site. Reflect
// cfg.DASHBOARD_ORIGIN when the operator has set one (production); fall back to '*' only
// when unset, so local dev (no known origin yet) keeps working out of the box. Shared here
// since every other route file already imports checkDash from this module.
function dashOrigin() { return cfg.DASHBOARD_ORIGIN || '*'; }

// Clerk isolation on the expense surface itself (Phase 6, SEC-2). A clerk only ever sees or
// touches their own branch's rows; admin + personal mode (no scope) are unchanged. In-memory
// until Barat's lib/supabase scope hook (#107 B1) also filters at fetch — defense-in-depth.
function clerkVisible(rows, scope) {
  if (!scope || scope.role !== 'clerk') return rows;
  return rows.filter((e) => e && String(e.branch_id == null ? '' : e.branch_id) === String(scope.branch_id));
}
// canTouchExpense(req, id) -> { ok:true } | { ok:false, code, error }. For a clerk, look the
// row up and require it to be on their branch BEFORE any write (PATCH/DELETE) happens.
async function canTouchExpense(req, id) {
  const scope = req.scope;
  if (!scope || scope.role !== 'clerk') return { ok: true };
  const rows = await sbSelect('expenses', { eq: { id } });
  const row = rows[0];
  if (!row) return { ok: false, code: 404, error: 'expense not found' };
  if (String(row.branch_id == null ? '' : row.branch_id) !== String(scope.branch_id)) {
    return { ok: false, code: 403, error: 'not your branch' };
  }
  return { ok: true };
}

module.exports = function mountExpenses(app) {
  app.get('/api/expenses', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      // scope (issue #131): the DB layer hard-filters a clerk to their own branch; clerkVisible
      // stays as the in-memory belt (defense-in-depth). Admin/personal (no scope) = no filter.
      const rows = await sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 2000, scope: req.scope });
      res.json(clerkVisible(rows, req.scope));
    } catch (e) { console.error('[api/expenses]', e.message); res.status(502).json({ error: 'load failed' }); }
  });

  // PATCH /api/expenses/payments { ids, paid, note? } — Phase 4 (ADR-021) bulk mark-paid.
  // Business ADMIN only (clerk 403 — clerks read payment_status like any field, never write it);
  // 404 with the flag OFF. Registered BEFORE the :id route so Express doesn't swallow the path
  // as :id='payments'. Reversible: paid:false resets to pending and clears paid_at/paid_note.
  // Chunked id=in.(…) PATCHes so one request can't take a giant row lock or blow the URL length.
  app.patch('/api/expenses/payments',
    (req, res, next) => (getCapabilities().multiUser ? next() : res.status(404).json({ error: 'not found' })),
    paymentsLimiter, checkDash, express.json({ limit: '256kb' }), async (req, res) => {
      res.set('Access-Control-Allow-Origin', dashOrigin());
      if (!req.scope || req.scope.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      const { ids, paid, note } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => typeof v !== 'string' || !v)) {
        return res.status(400).json({ error: 'ids must be a non-empty array of expense ids' });
      }
      if (ids.length > BULK_PAY_MAX_IDS) return res.status(413).json({ error: 'too many ids (max ' + BULK_PAY_MAX_IDS + ')' });
      if (typeof paid !== 'boolean') return res.status(400).json({ error: 'paid must be true or false' });
      const patch = paid
        ? { payment_status: 'paid', paid_at: new Date().toISOString(), paid_note: note ? String(note).slice(0, 500) : null }
        : { payment_status: 'pending', paid_at: null, paid_note: null };
      try {
        let updated = 0;
        for (let i = 0; i < ids.length; i += BULK_PAY_CHUNK) {
          const chunk = ids.slice(i, i + BULK_PAY_CHUNK);
          const url = cfg.SB_REST + '/expenses?id=in.(' + chunk.map(encodeURIComponent).join(',') + ')'
            + '&account_id=eq.' + encodeURIComponent(cfg.ACCOUNT_ID) + '&deleted_at=is.null';
          const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
          updated += Array.isArray(rows) ? rows.length : 0;
        }
        res.json({ ok: true, requested: ids.length, updated, payment_status: patch.payment_status });
      } catch (e) {
        console.error('[bulk pay]', e.message);
        res.status(502).json({ error: 'payment update failed' });
      }
    });

  app.patch('/api/expenses/:id', checkDash, express.json({ limit: '1mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const touch = await canTouchExpense(req, req.params.id);
      if (!touch.ok) return res.status(touch.code).json({ error: touch.error });
      // Optimistic concurrency (Phase 4, opt-in): a client that echoes the updated_at it loaded
      // gets a 409 (with the fresh value) instead of silently clobbering a newer edit — the
      // excel-lite grid's autosave depends on this. Clients that don't send it are unchanged.
      const expected = req.body && typeof req.body.expected_updated_at === 'string'
        ? req.body.expected_updated_at : null;
      if (expected) {
        const curRows = await sbSelect('expenses', { eq: { id: req.params.id }, scope: req.scope });
        const cur = curRows[0];
        if (!cur) return res.status(404).json({ error: 'expense not found' });
        if (String(cur.updated_at || '') !== expected) {
          return res.status(409).json({ error: 'stale edit — the expense changed since you loaded it', updated_at: cur.updated_at || null });
        }
      }
      const clean = sanitizeExpensePatch(req.body);
      if (!clean.ok) return res.status(400).json({ error: clean.error });
      const body = clean.body;
      if (!Object.keys(body).length) return res.status(400).json({ error: 'no fields to update' });
      const rows = await sbUpdate('expenses', { id: req.params.id, scope: req.scope }, body);
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
      const touch = await canTouchExpense(req, req.params.id);
      if (!touch.ok) return res.status(touch.code).json({ error: touch.error });
      await sbSoftDelete('expenses', { id: req.params.id, scope: req.scope });
      res.json({ ok: true });
    } catch (e) { console.error('[delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
  });

  // DELETE /api/expenses/:id/permanent — QA B8 (docs/qa/2026-07-09-qa-round.md PR-B): the
  // dashboard's "Rejected" view gets a one-click, NO-CONFIRMATION hard delete (Owner explicit —
  // do not add a confirm step here, unlike the soft-delete drawer above). Registered as a
  // distinct path (not a query flag on the existing DELETE) so the soft-delete route above stays
  // byte-for-byte unchanged. Scoped exactly like every other write here: canTouchExpense gates a
  // clerk to their own branch BEFORE anything is read or written. Restricted to status='rejected'
  // rows only — an admin/clerk can't hard-delete a live 'saved'/'needs_review'/'approved' row
  // through this door; that would defeat the whole point of a reviewable soft-delete elsewhere.
  app.delete('/api/expenses/:id/permanent', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const touch = await canTouchExpense(req, req.params.id);
      if (!touch.ok) return res.status(touch.code).json({ error: touch.error });
      const rows = await sbSelect('expenses', { eq: { id: req.params.id }, scope: req.scope });
      const cur = rows[0];
      if (!cur) return res.status(404).json({ error: 'expense not found' });
      if (cur.status !== 'rejected') {
        return res.status(409).json({ error: 'only a rejected bill can be permanently deleted (status=' + cur.status + ')' });
      }
      await sbHardDelete('expenses', { id: req.params.id, scope: req.scope });
      res.json({ ok: true });
    } catch (e) { console.error('[permanent delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
  });

  // `categories` — the frontend's filter/edit dropdowns + pill colours. Prefers the
  // ACCOUNT'S OWN chart of accounts (field_templates.categories, set via template
  // import — the mechanism docs/clients/premala.md points to: "categories via
  // template import", never hand-coded per client) over lib/categorize.js's generic
  // CATEGORIES default. This was previously always the generic list regardless of
  // what a client imported — a real gap: a client's own categories (e.g. Premala's
  // "Touch n Go") could be imported and used for OCR categorisation (lib/categorize.js
  // ALREADY preferred fieldSpec.categories there) but never actually showed up
  // anywhere in the dashboard UI. getFieldSpec() failures fall back to the generic
  // list rather than ever breaking /api/config, which most of the app depends on to boot.
  // multi_user (ADR-021 Phase 6): tells the frontend to show the username/password
  // login instead of the static token gate. Read per-request (not at mount) so a
  // flag flip takes effect on the next page load without a server rebuild.
  // excel_lite_grid / branch_submission (ADR-022 Phase 7): per-client profile flags the
  // frontend uses to include/exclude the Ledger section and the Send-to-Admin controls.
  // Display shaping only — the server enforces each capability on its own routes.
  app.get('/api/config', async (req, res) => {
    const caps = getCapabilities();
    let categories = CATEGORIES;
    try {
      const spec = await getFieldSpec();
      if (spec && Array.isArray(spec.categories) && spec.categories.length) categories = spec.categories;
    } catch (e) { console.error('[api/config] getFieldSpec failed, using default categories:', e.message); }
    res.json({
      auth_required: !!cfg.DASHBOARD_TOKEN, default_currency: cfg.DEFAULT_CURRENCY, categories,
      multi_user: !!caps.multiUser,
      excel_lite_grid: !!caps.excelLiteGrid,
      branch_submission: !!caps.branchSubmission,
      // Public @handle, not a secret (BOT_TOKEN itself is never exposed here) — lets the
      // Team view render a clickable t.me/<bot>?start=<code> bot-binding link. Empty when
      // unset; the frontend falls back to showing the raw code.
      bot_username: cfg.BOT_USERNAME || '',
    });
  });
};

module.exports.checkDash = checkDash;
module.exports.dashOrigin = dashOrigin;
module.exports.sanitizeExpensePatch = sanitizeExpensePatch;
