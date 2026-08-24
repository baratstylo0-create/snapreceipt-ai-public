'use strict';
// Guest Mode (2026-07-28) — "Continue as Guest" trial accounts. 404s unless BOTH
// capabilities.guestMode AND capabilities.personalAuth are on (guest signup reuses real
// accounts' session/bot-binding machinery, and its whole pitch — "try before you sign up
// for a real account" — presumes a real account exists to sign up for). Mirrors
// routes/auth.js's POST /api/signup pattern closely; the two real differences are (1) no
// email/password, and (2) a genuine data-lifetime: a guest's account is meant to disappear,
// not persist like a real signup.
const express = require('express');
const { sbSelect, sbInsertReturning, sbInsert, sbHardDelete } = require('../lib/supabase');
const { mintSession, lookupSession } = require('../lib/auth');
const { deviceFromRequest, recordAuthEvent } = require('../lib/deviceSessions'); // P-02a (#35)
const { getCapabilities } = require('../lib/account');
const { genBindingToken, BIND_TTL_MS } = require('../lib/personalAuth');
const { createRateLimiter, clientKey } = require('../lib/ratelimit');

// A guest session lives at most 24h (matches the safety-net sweep below) — even if the
// close-tab beacon (POST /api/guest/end) never fires, the session itself can't outlive it.
const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const GUEST_STALE_MS = GUEST_SESSION_TTL_MS;

// New account creation is real DB write + email-free (no signup friction to slow abuse the
// way a password policy naturally does), so this gets its own limiter rather than reusing
// signupLimiter — deliberately tighter than /api/signup's default.
const guestStartLimiter = createRateLimiter({ max: Number(process.env.GUEST_START_RATE_MAX) || 10 });
// /api/guest/end is a fire-and-forget cleanup call (sendBeacon) — generous, since a legitimate
// guest only ever calls it once, but still bounded against abuse.
const guestEndLimiter = createRateLimiter({ max: Number(process.env.GUEST_END_RATE_MAX) || 30 });

// sweepStaleGuests() — the 24h safety net (plan: "Cleanup" section). Best-effort, opportunistic:
// runs at the start of every /api/guest/start call rather than needing a standalone cron/worker
// process (no scheduled-cleanup pattern exists anywhere else in this codebase to extend instead).
// Never throws — a sweep failure must never block a new guest from starting their trial.
async function sweepStaleGuests(deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const hardDelete = deps.sbHardDelete || sbHardDelete;
  try {
    const cutoff = new Date(Date.now() - GUEST_STALE_MS).toISOString();
    const stale = await select('users', { eq: { role: 'guest' }, extra: 'created_at=lt.' + encodeURIComponent(cutoff), limit: 200 });
    for (const row of (Array.isArray(stale) ? stale : [])) {
      if (!row || !row.id) continue;
      // Deleting the users row cascades through sessions + bot_bindings + expenses
      // (all `on delete cascade` — see the schema.sql Guest Mode migration) in one delete.
      try { await hardDelete('users', { id: row.id }); }
      catch (e) { console.error('[guest sweep] delete', row.id, e && e.message); }
    }
  } catch (e) {
    console.error('[guest sweep]', e && e.message);
  }
}

module.exports = function mountGuest(app) {
  // POST /api/guest/start -> { token, role:'guest', bind_token }
  app.post('/api/guest/start', express.json({ limit: '1kb' }), (req, res) => guestStartLimiter(req, res, async () => {
    const caps = getCapabilities();
    if (!caps.guestMode || !caps.personalAuth) return res.status(404).json({ error: 'not found' });
    await sweepStaleGuests();
    try {
      // One-guest-trial-per-device gate (2026-08-22, QA report #2): "guest mode only access
      // once ... same user want try guest mode again means pop message, tell sign up."
      // guest_ip_log (schema.sql) is NEVER touched by the sweep above or by /api/guest/end
      // below — those delete the `users` row (and cascade), which would otherwise silently
      // reset this block every time a guest's 24h-old data gets cleaned up. clientKey (same
      // helper lib/ratelimit.js's own limiter uses) trusts Express's req.ip, which server.js's
      // `trust proxy` setting resolves correctly behind the real proxy in production. Its
      // documented fallback is the single literal string 'unknown' when no IP can be
      // determined at all — that shared bucket must never gate real users against each other,
      // so it's explicitly exempted rather than trusted as a real per-device signal.
      const ip = clientKey(req);
      if (ip && ip !== 'unknown') {
        const existing = await sbSelect('guest_ip_log', { eq: { ip_address: ip }, limit: 1 });
        if (existing.length) return res.status(403).json({ error: 'guest_already_used' });
      }

      const user = await sbInsertReturning('users', {
        branch_id: null,
        company_id: null,
        role: 'guest',
        username: null,        // no login handle — a guest never signs back in with credentials
        password_hash: null,
        display_name: 'Guest',
        active: true,
      });
      if (!user) throw new Error('guest signup failed');

      const bindToken = genBindingToken();
      await sbInsert('bot_bindings', {
        user_id: user.id,
        branch_id: null,
        company_id: null,
        role: 'guest',
        bind_token: bindToken,
        token_expires_at: new Date(Date.now() + BIND_TTL_MS).toISOString(),
        active: true,
      });

      // P-02a (#35, Codex cross-lane pre-review finding on #48): guest starts previously
      // minted a session with no device metadata and no timeline entry. No new-device
      // check here -- a guest identity is single-use and ephemeral (<=24h), so "is this a
      // new device" has no meaningful prior session to compare against.
      const device = deviceFromRequest(req);
      const token = await mintSession(user, GUEST_SESSION_TTL_MS, device);
      await recordAuthEvent({ userId: user.id, event: 'login_ok', device });
      // Logged only on a CONFIRMED successful signup — a mid-flow failure above must not
      // burn the device's one trial for nothing.
      if (ip && ip !== 'unknown') {
        try { await sbInsert('guest_ip_log', { ip_address: ip }); }
        catch (e) { console.error('[guest start] ip log failed:', e.message); } // best-effort only
      }
      return res.status(201).json({ token, role: 'guest', bind_token: bindToken });
    } catch (e) {
      console.error('[guest start]', e.message);
      return res.status(502).json({ error: 'guest signup failed' });
    }
  }));

  // POST /api/guest/end { token } — the ONLY route in this app that reads its bearer from the
  // JSON body instead of the Authorization header: navigator.sendBeacon (fired on `pagehide`,
  // see public/js/app.js) cannot set custom headers cross-browser, so the token travels in the
  // body here specifically. Always 200s — a sendBeacon call never reads the response, and this
  // must never surface whether a given token existed/was a guest (no information to leak either
  // way: deleting is the only effect, not a distinguishable one from the caller's side).
  app.post('/api/guest/end', express.json({ limit: '1kb' }), (req, res) => guestEndLimiter(req, res, async () => {
    const caps = getCapabilities();
    if (!caps.guestMode) return res.status(404).json({ error: 'not found' });
    try {
      const token = req.body && req.body.token;
      if (token) {
        const sess = await lookupSession(token);
        if (sess && sess.role === 'guest') {
          await sbHardDelete('users', { id: sess.user_id }); // cascades sessions + bot_bindings + expenses
        }
      }
    } catch (e) {
      console.error('[guest end]', e.message); // never fail a fire-and-forget cleanup call
    }
    return res.status(200).json({ ok: true });
  }));
};
