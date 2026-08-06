'use strict';
// Business-account login/logout (ADR-021 Phase 1). Only mounted-behaviour when
// capabilities.multiUser is ON; with the flag OFF both routes 404 (the personal
// product has no login concept — it uses the static DASHBOARD_TOKEN). Admin/clerk
// exchange username+password for an opaque session bearer; staff never log in.
const express = require('express');
const { sbSelect, sbSoftDelete, sbHardDelete } = require('../lib/supabase');
const { verifyPassword, mintSession, lookupSession, revokeSessionsForUser } = require('../lib/auth');
const { getCapabilities } = require('../lib/account');
const { signupOwner } = require('../lib/personalAuth');
const { requestPasswordReset, resetPassword } = require('../lib/passwordReset');
const { sendResetEmail } = require('../lib/mailer');
const { createRateLimiter } = require('../lib/ratelimit');
const { cfg } = require('../lib/config');

// Brute-force defense on the credential endpoint (§7.2). Per-IP fixed window.
const loginLimiter = createRateLimiter({ max: Number(process.env.LOGIN_RATE_MAX) || 20 });
// POST /api/signup is public/unauthenticated (unlike everything else in routes/branches.js,
// which requires an already-authenticated admin) — rate-limited the same way login is, to
// blunt automated account-creation abuse.
const signupLimiter = createRateLimiter({ max: Number(process.env.SIGNUP_RATE_MAX) || 10 });
// Password-reset endpoints (2026-07-27) — public/unauthenticated by nature (that's the
// whole point), so both get their own per-IP limits, same pattern as login/signup.
// forgot-password is tighter (it triggers an email send, an external side-effect with its
// own cost/abuse surface); reset-password matches login's brute-force budget since it's
// effectively "try to guess a token," structurally the same threat as guessing a password.
const forgotPasswordLimiter = createRateLimiter({ max: Number(process.env.FORGOT_PASSWORD_RATE_MAX) || 6 });
const resetPasswordLimiter = createRateLimiter({ max: Number(process.env.RESET_PASSWORD_RATE_MAX) || 20 });
// Delete-account (2026-08-06) — irreversible, so worth throttling the same way login guesses
// are: a wrong-password attempt here is structurally the same brute-force surface as login.
const deleteAccountLimiter = createRateLimiter({ max: Number(process.env.DELETE_ACCOUNT_RATE_MAX) || 10 });

// A constant, well-formed scrypt hash for the unknown-user path so verifyPassword does
// real work (equal-ish timing) whether or not the username exists — no user enumeration
// via response timing. The password is unknowable, so this never authenticates anyone.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$'
  + '0000000000000000000000000000000000000000000000000000000000000000';

module.exports = function mountAuth(app) {
  // POST /api/signup { email, password } -> { token, role:'owner', bind_token, display_name }
  // Web-exposed (unlike business's CLI-only setup/provision.js) — a personal user has no
  // operator to run a bootstrap command for them. 404s unless capabilities.personalAuth is on.
  app.post('/api/signup', express.json({ limit: '4kb' }), (req, res) => signupLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const { email, password } = req.body || {};
    try {
      const { user, bindToken } = await signupOwner({ email, password });
      const token = await mintSession(user);
      return res.status(201).json({ token, role: 'owner', bind_token: bindToken, display_name: user.username });
    } catch (e) {
      // signupOwner's messages are already user-safe (validation/conflict wording); anything
      // else (a DB error) is logged and returned generically, never leaking internals.
      const known = /required|already exists|password|email/i.test(e.message);
      if (!known) console.error('[signup]', e.message);
      return res.status(known ? 400 : 502).json({ error: known ? e.message : 'signup failed' });
    }
  }));

  // POST /api/login { username, password } -> { token, role, branch_id, display_name }
  app.post('/api/login', express.json({ limit: '16kb' }), (req, res) => loginLimiter(req, res, async () => {
    const caps = getCapabilities();
    if (!caps.multiUser && !caps.personalAuth) return res.status(404).json({ error: 'not found' });
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password are required' });
    }
    try {
      const rows = await sbSelect('users', { eq: { username, active: true }, limit: 1 });
      const user = rows[0];
      // Always verify (dummy hash for unknown user) to keep timing uniform.
      const ok = await verifyPassword(password, user && user.password_hash ? user.password_hash : DUMMY_HASH);
      // staff never log in (no username/hash), and a null-hash row can't authenticate.
      if (!user || !ok || user.role === 'staff') return res.status(401).json({ error: 'invalid credentials' });
      const token = await mintSession(user);
      return res.json({
        token,
        role: user.role,
        branch_id: user.branch_id || null,
        display_name: user.display_name || '',
      });
    } catch (e) {
      console.error('[login]', e.message);
      return res.status(502).json({ error: 'login failed' });
    }
  }));

  // POST /api/logout — revokes ALL sessions for the bearer's user (logs out every
  // device; the safe default for v1). Idempotent: unknown/absent token still 200s.
  app.post('/api/logout', express.json({ limit: '4kb' }), async (req, res) => {
    const caps = getCapabilities();
    if (!caps.multiUser && !caps.personalAuth) return res.status(404).json({ error: 'not found' });
    const a = req.get('Authorization') || '';
    const token = a.startsWith('Bearer ') ? a.slice(7) : '';
    try {
      const sess = await lookupSession(token);
      if (sess) await revokeSessionsForUser(sess.user_id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[logout]', e.message);
      return res.status(502).json({ error: 'logout failed' });
    }
  });

  // DELETE /api/account { password } -> { ok:true } | { error }
  // Real, irreversible account deletion (2026-08-06) — personal (personalAuth) owner accounts
  // only; business/staff/guest sessions never reach the frontend button that calls this, but
  // the role check below is the actual enforcement, not just UI hiding. Requires password
  // re-entry (no other destructive endpoint in this codebase does — deliberate extra friction
  // for something this irreversible). Reuses sbHardDelete('users', {id}) — the exact mechanism
  // routes/guest.js already relies on for guest cleanup — which cascades sessions,
  // bot_bindings, password_resets, subscriptions, and any owner_user_id-tagged rows (schema.sql).
  // owner_user_id is guest-only though (see the per-user-cap work earlier) — a real owner's OWN
  // captured receipts are tagged created_by_user_id instead, which is `on delete set null`, NOT
  // cascade, so they'd survive as invisible orphans unless explicitly cleaned up first below.
  app.delete('/api/account', express.json({ limit: '4kb' }), (req, res) => deleteAccountLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const a = req.get('Authorization') || '';
    const token = a.startsWith('Bearer ') ? a.slice(7) : '';
    const { password } = req.body || {};
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required' });
    try {
      const sess = await lookupSession(token);
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const rows = await sbSelect('users', { eq: { id: sess.user_id }, limit: 1 });
      const user = rows[0];
      if (!user || user.role !== 'owner') return res.status(403).json({ error: 'forbidden' });
      // 400, NOT 401: the session token itself is still valid — only the re-entered
      // password is wrong. A 401 here would wrongly trip Api.js's global
      // notifyAuthExpired() (any 401 with a valid Authorization header = "session
      // expired, log in again"), which would confusingly boot the user out of the
      // whole app just for mistyping their password during delete confirmation.
      const ok = await verifyPassword(password, user.password_hash || DUMMY_HASH);
      if (!ok) return res.status(400).json({ error: 'wrong password' });
      // Close the cascade gap: soft-delete every expense this owner personally captured
      // (created_by_user_id) BEFORE hard-deleting the user row — on delete set null would
      // otherwise leave them intact but permanently unowned/invisible.
      const owned = await sbSelect('expenses', { eq: { created_by_user_id: sess.user_id }, extra: 'deleted_at=is.null' });
      for (const row of owned) {
        try { await sbSoftDelete('expenses', { id: row.id }); } catch (e) { console.error('[delete-account] soft-delete expense failed:', row.id, e.message); }
      }
      await sbHardDelete('users', { id: sess.user_id });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[delete-account]', e.message);
      return res.status(502).json({ error: 'delete failed' });
    }
  }));

  // POST /api/forgot-password { email } -> { ok:true, message } — ALWAYS the exact same
  // response, whether or not the email has an account (no user enumeration). Personal
  // (personalAuth) only — business accounts are operator-provisioned, out of scope; 404s
  // otherwise, same guard shape as /api/signup.
  app.post('/api/forgot-password', express.json({ limit: '4kb' }), (req, res) => forgotPasswordLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const email = req.body && req.body.email;
    const GENERIC = { ok: true, message: 'If that email has an account, a reset link has been sent.' };
    try {
      const result = await requestPasswordReset(email);
      if (result) {
        // PUBLIC_URL is the correct base once deployed; falls back to the request's own
        // origin so this also works untouched on a local/dev box with PUBLIC_URL unset.
        const base = cfg.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
        const resetUrl = base + '/?reset_token=' + encodeURIComponent(result.token);
        // Fire-and-forget-ish, but awaited so a real send failure is logged server-side —
        // sendResetEmail itself never throws, so this can never turn into a 502 either way.
        await sendResetEmail(result.user.username, resetUrl);
      }
    } catch (e) {
      console.error('[forgot-password]', e.message);
      // Still fall through to the generic response — a DB hiccup must not leak via a
      // different response shape than "no such account."
    }
    return res.json(GENERIC);
  }));

  // POST /api/reset-password { token, password } -> { ok:true } | { error }
  app.post('/api/reset-password', express.json({ limit: '4kb' }), (req, res) => resetPasswordLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const { token, password } = req.body || {};
    try {
      const result = await resetPassword(token, password);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[reset-password]', e.message);
      return res.status(502).json({ error: 'reset failed' });
    }
  }));
};
