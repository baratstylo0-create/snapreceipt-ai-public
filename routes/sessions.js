'use strict';
// Device-session management (P-02a, 2026-08-24 — issue #35).
//   GET    /api/sessions                 -> the devices currently signed in as you
//   GET    /api/sessions/events          -> your recent authentication timeline
//   DELETE /api/sessions/:id             -> sign one device out
//   POST   /api/sessions/revoke-others   -> sign every OTHER device out
//
// All four require a live session; there is no unauthenticated surface here. Gated behind
// personalAuth OR multiUser, matching /api/logout — a deployment with neither has no session
// concept at all (it uses the static DASHBOARD_TOKEN), so these would be meaningless.
//
// This does NOT change how a session is resolved. Reading the bearer here is the existing
// contract; the HttpOnly-cookie switch is P-02b.
const express = require('express');
const { lookupSession, tokenHash, revokeSessionsForUser } = require('../lib/auth');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const {
  listDevices, revokeDevice, revokeOtherDevices, recentEvents,
  recordAuthEvent, deviceFromRequest,
} = require('../lib/deviceSessions');

// Revocation is a state-changing action reachable with a stolen-but-valid session, and a
// script that spams it could churn the sessions table. Reads are cheap and used by a polling
// UI, so they get a much wider budget than writes.
const readLimiter = createRateLimiter({ max: Number(process.env.SESSIONS_READ_RATE_MAX) || 60 });
const revokeLimiter = createRateLimiter({ max: Number(process.env.SESSIONS_REVOKE_RATE_MAX) || 20 });

// Resolve the caller once. Returns { sess, hash } or null. The token hash is needed so
// listDevices can mark the caller's own row `current` and revoke-others can spare it —
// computed here so no handler below ever holds the raw token longer than it must.
async function resolveCaller(req) {
  const a = req.get('Authorization') || '';
  const bearer = a.startsWith('Bearer ') ? a.slice(7) : '';
  if (!bearer) return null;
  const sess = await lookupSession(bearer);
  if (!sess) return null;
  return { sess, hash: tokenHash(bearer) };
}

module.exports = function mountSessions(app) {
  function gate(req, res) {
    const caps = getCapabilities();
    if (!caps.multiUser && !caps.personalAuth) {
      res.status(404).json({ error: 'not found' });
      return false;
    }
    return true;
  }

  // GET /api/sessions -> { devices: [{ id, current, created_at, last_seen_at, user_agent, expires_at }] }
  // Never returns token_hash or ip_hash — see the note in lib/deviceSessions.js listDevices.
  app.get('/api/sessions', (req, res) => readLimiter(req, res, async () => {
    if (!gate(req, res)) return undefined;
    try {
      const caller = await resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      const devices = await listDevices(caller.sess.user_id, caller.hash);
      return res.json({ devices });
    } catch (e) {
      console.error('[sessions list]', e.message);
      return res.status(502).json({ error: 'could not load devices' });
    }
  }));

  // GET /api/sessions/events -> { events: [{ event, created_at, user_agent }] }
  // The "was this you?" timeline. ip_hash is deliberately withheld: it is useless to a reader
  // and, being stable per network, it is a correlatable identifier once it leaves the server.
  app.get('/api/sessions/events', (req, res) => readLimiter(req, res, async () => {
    if (!gate(req, res)) return undefined;
    try {
      const caller = await resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      const rows = await recentEvents(caller.sess.user_id, req.query && req.query.limit);
      return res.json({
        events: rows.map((r) => ({ event: r.event, created_at: r.created_at, user_agent: r.user_agent || null })),
      });
    } catch (e) {
      console.error('[sessions events]', e.message);
      return res.status(502).json({ error: 'could not load activity' });
    }
  }));

  // DELETE /api/sessions/:id -> { ok:true } | 404
  // The authorization boundary is inside revokeDevice: the caller's user_id is folded into the
  // DELETE's own WHERE clause, so one account can never revoke another's device by guessing an
  // id, and there is no check-then-act window. A miss is a plain 404 — it does not distinguish
  // "no such session" from "not yours", which would confirm the existence of someone else's id.
  app.delete('/api/sessions/:id', (req, res) => revokeLimiter(req, res, async () => {
    if (!gate(req, res)) return undefined;
    try {
      const caller = await resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      const removed = await revokeDevice(caller.sess.user_id, req.params.id);
      if (!removed) return res.status(404).json({ error: 'not found' });
      await recordAuthEvent({ userId: caller.sess.user_id, event: 'session_revoked', req });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[sessions revoke]', e.message);
      return res.status(502).json({ error: 'could not sign that device out' });
    }
  }));

  // POST /api/sessions/revoke-others -> { ok:true, revoked:<n> }
  // "Sign out everywhere else" — the one action a person reaches for when they think they have
  // been compromised. Keeps the caller's own session deliberately: logging someone out of the
  // device they are currently using, at the exact moment they are trying to secure the account,
  // would be actively harmful.
  app.post('/api/sessions/revoke-others', express.json({ limit: '4kb' }), (req, res) => revokeLimiter(req, res, async () => {
    if (!gate(req, res)) return undefined;
    try {
      const caller = await resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      const revoked = await revokeOtherDevices(caller.sess.user_id, caller.hash);
      await recordAuthEvent({ userId: caller.sess.user_id, event: 'session_revoked', req });
      return res.json({ ok: true, revoked });
    } catch (e) {
      console.error('[sessions revoke-others]', e.message);
      return res.status(502).json({ error: 'could not sign other devices out' });
    }
  }));
};

// Re-exported for the tests and for routes/auth.js's logout path, so neither reimplements the
// bearer-resolution shape this file already settled on.
module.exports.resolveCaller = resolveCaller;
module.exports.deviceFromRequest = deviceFromRequest;
module.exports.revokeSessionsForUser = revokeSessionsForUser;
