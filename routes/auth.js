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
const { sendResetEmail, sendFeedbackEmail, sendEmailVerification } = require('../lib/mailer');
const { createRateLimiter } = require('../lib/ratelimit');
const { cfg } = require('../lib/config');
const {
  requestVerification, confirmByCode, confirmByToken, verificationState, issueChallenge,
} = require('../lib/emailChallenge');

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
// In-app feedback (2026-08-09) — an authenticated action (only reachable from inside the
// dashboard header, personal accounts only), but still worth throttling: it triggers a real
// outbound email send per request, an external cost/abuse surface same as forgot-password.
const feedbackLimiter = createRateLimiter({ max: Number(process.env.FEEDBACK_RATE_MAX) || 10 });
// Email verification (P-01, 2026-08-24). Two different threats, so two different budgets:
//   request — triggers an outbound send, so it is an inbox-flooding/cost surface. Matched to
//             forgot-password's tighter budget for exactly that reason. lib/emailChallenge.js
//             adds a SECOND, per-account cooldown underneath, because a per-IP limit alone
//             does nothing against an attacker who rotates IPs at one victim's inbox.
//   confirm — structurally "guess a 6-digit code," i.e. the same brute-force shape as login,
//             so it gets login's budget. The per-challenge attempt counter is the real cap;
//             this limiter just stops the noise before it reaches the database.
const verifyEmailRequestLimiter = createRateLimiter({ max: Number(process.env.VERIFY_EMAIL_REQUEST_RATE_MAX) || 6 });
const verifyEmailConfirmLimiter = createRateLimiter({ max: Number(process.env.VERIFY_EMAIL_CONFIRM_RATE_MAX) || 20 });

// A constant, well-formed scrypt hash for the unknown-user path so verifyPassword does
// real work (equal-ish timing) whether or not the username exists — no user enumeration
// via response timing. The password is unknowable, so this never authenticates anyone.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$'
  + '0000000000000000000000000000000000000000000000000000000000000000';

// verifyUrlFor(token) -> an absolute confirm link, or null when no absolute base is
// configured (the email then ships code-only, which is fully sufficient — the code and the
// link consume the same challenge).
//
// cfg.PUBLIC_URL is the ONLY accepted base. There is deliberately NO fallback to
// `req.protocol + req.get('host')` here, even though /api/forgot-password directly above
// does exactly that: deriving a mailed link from a request Header the client controls is
// the reset-link-poisoning finding (High) recorded in docs/FULL_APP_GAP_AUDIT_2026-08-24.md.
// Fixing that existing route is NOT in this change — governance rule 8 says security
// behaviour and cleanup do not travel in one PR — but the new path must not inherit the bug.
function verifyUrlFor(token) {
  const base = String(cfg.PUBLIC_URL || '').trim();
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/?verify_token=' + encodeURIComponent(token);
}

module.exports = function mountAuth(app) {
  // POST /api/signup { email, password }
  //   -> { token, role:'owner', bind_token, display_name, email_verified:false, verification_required }
  // Web-exposed (unlike business's CLI-only setup/provision.js) — a personal user has no
  // operator to run a bootstrap command for them. 404s unless capabilities.personalAuth is on.
  //
  // P-01: a fresh account now gets a verification challenge issued and mailed. The session is
  // still minted exactly as before — signup does NOT become a blocking wall — because
  // enforcing verification retroactively would lock out every account created before this
  // shipped. `email_verified` and `verification_required` are ADDITIVE response fields that
  // tell W-01/M-02 whether to show the "confirm your email" step; the decision to make it
  // blocking is CAP_REQUIRE_EMAIL_VERIFICATION (lib/account.js), default off.
  app.post('/api/signup', express.json({ limit: '4kb' }), (req, res) => signupLimiter(req, res, async () => {
    const caps = getCapabilities();
    if (!caps.personalAuth) return res.status(404).json({ error: 'not found' });
    const { email, password } = req.body || {};
    try {
      const { user, bindToken } = await signupOwner({ email, password });
      const token = await mintSession(user);
      // Issue + mail the challenge. Wrapped so a mail/DB hiccup here can NEVER fail a signup
      // that already succeeded — the account exists and the session is valid; the user can
      // always ask for a fresh code via /api/verify-email/request.
      // issueChallenge (not requestVerification) because the account was created one line
      // ago: its "already verified" and resend-cooldown checks are both vacuous here, and
      // skipping them avoids a needless re-read of a row we already hold.
      try {
        const issued = await issueChallenge(user);
        await sendEmailVerification(user.username, issued.code, verifyUrlFor(issued.token));
      } catch (e) {
        console.error('[signup] verification challenge failed:', e.message);
      }
      return res.status(201).json({
        token, role: 'owner', bind_token: bindToken, display_name: user.username,
        email_verified: false,
        verification_required: Boolean(caps.requireEmailVerification),
      });
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
        // P-01, additive. Reported for owner accounts only: business admin/clerk identities
        // are operator-provisioned and have no self-serve email flow, so claiming anything
        // about their verification state would be meaningless. `verification_required`
        // mirrors CAP_REQUIRE_EMAIL_VERIFICATION so the client knows whether the flag is a
        // hint or a gate without hard-coding policy of its own.
        ...(user.role === 'owner' ? {
          email_verified: Boolean(user.email_verified_at),
          verification_required: Boolean(caps.requireEmailVerification),
        } : {}),
      });
    } catch (e) {
      console.error('[login]', e.message);
      return res.status(502).json({ error: 'login failed' });
    }
  }));

  // POST /api/verify-email/request { email } -> { ok:true, message } — ALWAYS the exact
  // same response, whatever the truth is (no account, wrong role, already verified, inside
  // the resend cooldown, or a code genuinely sent). Same no-enumeration contract as
  // /api/forgot-password, and the same reasoning: the response is the attacker's only
  // oracle, so it must carry no signal.
  app.post('/api/verify-email/request', express.json({ limit: '4kb' }), (req, res) => verifyEmailRequestLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const email = req.body && req.body.email;
    const GENERIC = { ok: true, message: 'If that email needs confirming, a code is on its way.' };
    try {
      const issued = await requestVerification(email);
      if (issued) await sendEmailVerification(issued.user.username, issued.code, verifyUrlFor(issued.token));
    } catch (e) {
      console.error('[verify-email/request]', e.message);
      // Deliberately fall through to the SAME generic response — a DB or mail failure must
      // not become a distinguishable answer.
    }
    return res.json(GENERIC);
  }));

  // POST /api/verify-email/confirm { email, code } | { token } -> { ok:true, email_verified:true }
  //                                                             | 400 { error }
  // Accepts either proof of the one challenge: the 6-digit code (needs the email to scope
  // the lookup to a single account — a bare 10^6 code space must never be searchable
  // account-wide) or the magic-link token (self-identifying, 256 bits).
  // Unauthenticated on purpose: the link lands in a mail client that may not carry the
  // session, and the challenge itself is the credential being presented.
  app.post('/api/verify-email/confirm', express.json({ limit: '4kb' }), (req, res) => verifyEmailConfirmLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const { email, code, token } = req.body || {};
    try {
      const result = token ? await confirmByToken(token) : await confirmByCode(email, code);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, email_verified: true });
    } catch (e) {
      console.error('[verify-email/confirm]', e.message);
      return res.status(502).json({ error: 'verification failed' });
    }
  }));

  // GET /api/verify-email/status -> { email, verified, verified_at, verification_required }
  // Authenticated. The single source W-01 (web) and M-02 (Android) both render their
  // "confirm your email" banner from, so the two clients cannot drift on what verified means.
  app.get('/api/verify-email/status', async (req, res) => {
    const caps = getCapabilities();
    if (!caps.personalAuth) return res.status(404).json({ error: 'not found' });
    const a = req.get('Authorization') || '';
    const bearer = a.startsWith('Bearer ') ? a.slice(7) : '';
    if (!bearer) return res.status(401).json({ error: 'unauthorized' });
    try {
      const sess = await lookupSession(bearer);
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const rows = await sbSelect('users', { eq: { id: sess.user_id }, limit: 1 });
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      return res.json({
        ...verificationState(user),
        verification_required: Boolean(caps.requireEmailVerification),
      });
    } catch (e) {
      console.error('[verify-email/status]', e.message);
      return res.status(502).json({ error: 'status failed' });
    }
  });

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

  // POST /api/feedback { message } -> { ok:true } | { error }
  // In-app "Contact us" (2026-08-09) — reached from the header feedback icon (nav.js,
  // personal accounts only). Requires an authenticated session (so we know who to reply to
  // without asking them to type their own email) but does NOT require the personalAuth/owner
  // role check the account-deletion route above has — any signed-in user on a personalAuth
  // deployment can send feedback, matching the header icon's own visibility. Reuses
  // sendFeedbackEmail's real Resend send (unlike sendResetEmail/sendVerificationCode, this
  // one does NOT swallow a failure — the user gets a real "try again" if the send failed).
  app.post('/api/feedback', express.json({ limit: '8kb' }), (req, res) => feedbackLimiter(req, res, async () => {
    if (!getCapabilities().personalAuth) return res.status(404).json({ error: 'not found' });
    const a = req.get('Authorization') || '';
    const token = a.startsWith('Bearer ') ? a.slice(7) : '';
    const message = req.body && req.body.message;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > 4000) return res.status(400).json({ error: 'message is too long' });
    try {
      const sess = await lookupSession(token);
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const rows = await sbSelect('users', { eq: { id: sess.user_id }, limit: 1 });
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      const result = await sendFeedbackEmail(user.username, message.trim());
      if (!result.ok) return res.status(502).json({ error: 'Could not send your message. Please try again.' });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[feedback]', e.message);
      return res.status(502).json({ error: 'Could not send your message. Please try again.' });
    }
  }));
};
