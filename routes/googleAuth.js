'use strict';
// Google Sign-In (2026-07-30) — GET /api/auth/google (start) + GET /api/auth/google/callback
// (finish). Personal (personalAuth) only, same as routes/auth.js's /api/signup — 404s
// otherwise. A full-page redirect flow (not a popup/JS SDK): simpler, and keeps the
// existing strict CSP (no inline scripts) untouched. The session token is handed back to
// the browser in the URL FRAGMENT (`#...`), never the query string — a fragment is never
// sent to the server in a request, never logged in access logs, never included in a
// Referer header, unlike a query param (see the project's own "never put sensitive data
// in a URL query string" rule). public/js/app.js's boot() reads it once and scrubs it via
// history.replaceState.
const crypto = require('node:crypto');
const { cfg } = require('../lib/config');
const { getCapabilities } = require('../lib/account');
const { sbSelectGlobal, sbInsertReturning, sbInsert } = require('../lib/supabase');
const { mintSession } = require('../lib/auth');
const { normaliseEmail, genBindingToken, genAccountId, BIND_TTL_MS } = require('../lib/personalAuth');
const { isConfigured, buildAuthUrl, exchangeCode, verifyIdToken } = require('../lib/googleAuth');
const { createRateLimiter } = require('../lib/ratelimit');

const STATE_COOKIE = 'g_oauth_state';
const STATE_TTL_S = 600; // 10 minutes — plenty for a real consent flow, short enough to limit replay

const startLimiter = createRateLimiter({ max: Number(process.env.GOOGLE_AUTH_RATE_MAX) || 20 });
const callbackLimiter = createRateLimiter({ max: Number(process.env.GOOGLE_AUTH_RATE_MAX) || 20 });

function baseUrl(req) {
  return cfg.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
}

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setStateCookie(req, res, value) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', STATE_COOKIE + '=' + encodeURIComponent(value)
    + '; Max-Age=' + STATE_TTL_S + '; Path=/; HttpOnly; SameSite=Lax' + secure);
}

function clearStateCookie(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', STATE_COOKIE + '=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' + secure);
}

function failRedirect(req, res, code) {
  res.redirect(302, baseUrl(req) + '/#gauth_error=' + encodeURIComponent(code));
}

module.exports = function mountGoogleAuth(app) {
  // GET /api/auth/google — kicks off the redirect to Google's consent screen.
  app.get('/api/auth/google', (req, res) => startLimiter(req, res, () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    if (!isConfigured()) return failRedirect(req, res, 'not_configured');
    const state = crypto.randomBytes(16).toString('base64url');
    setStateCookie(req, res, state);
    const redirectUri = baseUrl(req) + '/api/auth/google/callback';
    return res.redirect(302, buildAuthUrl({ redirectUri, state }));
  }));

  // GET /api/auth/google/callback — Google redirects here with ?code&state (or ?error).
  app.get('/api/auth/google/callback', (req, res) => callbackLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const cookieState = readCookie(req, STATE_COOKIE);
    clearStateCookie(req, res);
    if (req.query.error) return failRedirect(req, res, 'denied');
    if (!isConfigured()) return failRedirect(req, res, 'not_configured');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || !state || !cookieState || state !== cookieState) return failRedirect(req, res, 'state_mismatch');

    try {
      const redirectUri = baseUrl(req) + '/api/auth/google/callback';
      const { idToken } = await exchangeCode({ code, redirectUri });
      const { email, name } = await verifyIdToken(idToken);
      const username = normaliseEmail(email);

      // sbSelectGlobal (2026-08-22): see lib/supabase.js's doc comment — a Google-login
      // "does this email already exist" check must be tenant-independent, or it goes blind
      // to any already-migrated owner and creates a fresh duplicate account on every re-login.
      // CAUGHT LIVE: exactly this happened to baratstylo0@gmail.com right after the 2026-08-22
      // account-isolation backfill — his real 4-receipt account has account_id=p_0a0b1781...,
      // but the OLD scoped lookup here only ever matched cfg.ACCOUNT_ID, so it never found him.
      const existing = await sbSelectGlobal('users', { eq: { username }, limit: 1 });
      let user = existing[0];
      let bindToken = null;
      let isNew = false;

      if (user) {
        // An email that's already tied to a non-owner role (admin/clerk/guest) is a
        // collision this flow must never resolve silently — Google sign-in is
        // personal-owner only, same boundary lib/auth.js's scopeForUser enforces.
        if (user.role !== 'owner') return failRedirect(req, res, 'account_type');
      } else {
        isNew = true;
        // 2026-08-14 SECURITY FIX (mirrors lib/personalAuth.js signupOwner's same-day fix):
        // this used to leave account_id unset, so every Google-signed-up owner fell back to
        // the same shared 'default' account_id as every other personal user — full
        // cross-account receipt read/write. genAccountId() gives this new owner their own.
        const account_id = genAccountId();
        user = await sbInsertReturning('users', {
          account_id,
          branch_id: null,
          company_id: null,
          role: 'owner',
          username,
          password_hash: null, // Google-only account — no password to verify against
          display_name: name || username,
          active: true,
        });
        if (!user) return failRedirect(req, res, 'failed');
        bindToken = genBindingToken();
        await sbInsert('bot_bindings', {
          account_id, // must match the user row — lib/bot.js's bindingMeta() reads it from here
          user_id: user.id,
          branch_id: null,
          company_id: null,
          role: 'owner',
          bind_token: bindToken,
          token_expires_at: new Date(Date.now() + BIND_TTL_MS).toISOString(),
          active: true,
        });
      }

      const token = await mintSession(user);
      const params = new URLSearchParams({
        gauth_token: token,
        gauth_role: 'owner',
        gauth_name: user.display_name || username,
      });
      if (isNew) { params.set('gauth_new', '1'); params.set('gauth_bind', bindToken); }
      return res.redirect(302, baseUrl(req) + '/#' + params.toString());
    } catch (e) {
      console.error('[api/auth/google/callback]', e.message);
      return failRedirect(req, res, 'failed');
    }
  }));
};
