'use strict';
// Device sessions and the authentication timeline (P-02a, 2026-08-24 —
// docs/FULL_APP_EXECUTION_PLAN.md Gate 1, issue #35).
//
// SCOPE, stated up front so nobody mistakes this for all of P-02: this file adds the
// durable record behind "which devices are signed in as me, when did someone last sign in,
// and let me kick one off." It does NOT change how a session is resolved. The bearer
// contract in lib/auth.js is untouched, so every existing web and native client keeps
// working unchanged. The HttpOnly-cookie + CSRF transport switch is P-02b, and it needs
// W-01 and M-02 to agree the shared session contract before it lands.
//
// Why a separate file rather than growing lib/auth.js: lib/auth.js holds the frozen
// isolation contract (scopeForUser) that every route funnels through. Device management is
// a feature ON TOP of sessions, not part of resolving one, and keeping it out of the hot
// path means a bug here can never break authentication itself.
//
// PRIVACY (PDPA / C-02): the raw client IP is never stored or logged by this module. It is
// salted and hashed on the way in. That is enough to answer "same network as last time?"
// for new-device detection while retaining nothing that locates a person.
const crypto = require('node:crypto');
const { cfg } = require('./config');
const { hreq } = require('./http');
const { sbSelect, sbInsert } = require('./supabase');

const enc = encodeURIComponent;

// A device list is only useful if it says "Chrome on Windows", but a raw UA header is
// attacker-controlled free text that ends up rendered in a browser. Cap it hard and strip
// control characters; the frontend still escapes on render (defence in depth, not instead of).
const UA_MAX = 200;

// The salt that makes ip_hash non-reversible. SESSION_IP_SALT if set; otherwise derived from
// the Supabase service key, which every deployment already has and never ships to a client.
// Deriving rather than defaulting to a constant matters: a fixed salt would make the hashes
// comparable across every deployment and rainbow-table-able back to an IP in seconds.
function ipSalt() {
  return process.env.SESSION_IP_SALT || cfg.SB_KEY || 'snapreceipt-local-dev-salt';
}

// hashIp(ip) -> salted sha-256 hex, or null. Never returns anything reversible to an address.
function hashIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(ipSalt() + '|' + raw).digest('hex');
}

function cleanUserAgent(ua) {
  const raw = String(ua || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!raw) return null;
  return raw.slice(0, UA_MAX);
}

// deviceFromRequest(req) -> { ip_hash, user_agent }. The one place request metadata is
// turned into storable form, so no route hand-rolls it and forgets to hash the IP.
function deviceFromRequest(req) {
  return {
    ip_hash: hashIp(req && (req.ip || (req.socket && req.socket.remoteAddress))),
    user_agent: cleanUserAgent(req && req.get && req.get('User-Agent')),
  };
}

// ---- the authentication timeline -------------------------------------------

const EVENTS = new Set(['login_ok', 'login_fail', 'logout', 'session_revoked', 'password_changed', 'new_device']);

// recordAuthEvent({ userId, event, req }) — fire-and-forget by contract: it NEVER throws and
// never rejects. An auth event is observability, and observability must not be able to fail a
// login. Callers may await it without a try/catch.
//
// `userId` is null for a failure against an address with no account — deliberately recorded,
// because "someone is spraying logins at addresses that do not exist" is exactly the pattern
// an incident review needs, and it stores no account-existence claim either way.
async function recordAuthEvent({ userId = null, event, req, device } = {}) {
  try {
    if (!EVENTS.has(event)) return;
    const d = device || deviceFromRequest(req);
    await sbInsert('auth_events', {
      user_id: userId || null,
      event,
      ip_hash: d.ip_hash,
      user_agent: d.user_agent,
    });
  } catch (e) {
    // Log, never propagate. See the contract note above.
    console.error('[deviceSessions] recordAuthEvent failed:', e.message);
  }
}

// recentEvents(userId, limit) -> the account's own security timeline, newest first.
async function recentEvents(userId, limit = 20) {
  if (!userId) return [];
  return sbSelect('auth_events', {
    eq: { user_id: userId },
    order: 'created_at.desc',
    limit: Math.min(Number(limit) || 20, 100),
  });
}

// ---- device sessions --------------------------------------------------------
// These go through hreq rather than the generic lib/supabase helpers for the same reason
// lib/auth.js does: the sessions table's primary key is token_hash, not id, so the id-keyed
// helpers do not address it. Every query is still account-scoped to cfg.ACCOUNT_ID.

function sessionsUrl(filters) {
  return cfg.SB_REST + '/sessions?account_id=eq.' + enc(cfg.ACCOUNT_ID) + (filters ? '&' + filters : '');
}

// listDevices(userId, currentToken) -> [{ id, current, created_at, last_seen_at, user_agent, expires_at }]
//
// NOTE what is NOT returned: token_hash never leaves this function, and neither does ip_hash.
// The row's handle is the surrogate `id`. Returning the token hash would put a value derived
// from a live credential into a browser, a URL and eventually a log.
//
// `current` is computed HERE by comparing hashes server-side, so the caller never has to send
// or match a token to work out which row is the device it is sitting on.
async function listDevices(userId, currentTokenHash) {
  if (!userId) return [];
  const url = sessionsUrl('user_id=eq.' + enc(userId) + '&order=created_at.desc&limit=100');
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  const now = Date.now();
  return (Array.isArray(rows) ? rows : [])
    .filter((s) => s.expires_at && new Date(s.expires_at).getTime() > now)  // live sessions only
    .map((s) => ({
      id: s.id,
      current: Boolean(currentTokenHash && s.token_hash === currentTokenHash),
      created_at: s.created_at,
      last_seen_at: s.last_seen_at || null,
      user_agent: s.user_agent || null,
      expires_at: s.expires_at,
    }));
}

// touchDevice(tokenHash, device) — refresh last_seen_at (and backfill device metadata for
// sessions minted before this shipped). Best-effort: never throws, because a failed
// bookkeeping write must not fail the request that triggered it.
//
// Throttled to once per TOUCH_INTERVAL_MS per session so a busy dashboard's many fetches do
// not turn into one database write each. The cache is per-process and purely an optimisation
// — losing it on restart costs one extra write, nothing more.
const TOUCH_INTERVAL_MS = Number(process.env.SESSION_TOUCH_INTERVAL_MS) || 5 * 60 * 1000;
const lastTouched = new Map();

async function touchDevice(tokenHash, device, now = Date.now()) {
  try {
    if (!tokenHash) return false;
    const prev = lastTouched.get(tokenHash);
    if (prev && (now - prev) < TOUCH_INTERVAL_MS) return false;
    lastTouched.set(tokenHash, now);
    if (lastTouched.size > 5000) lastTouched.clear();   // bounded; see note above

    const patch = { last_seen_at: new Date(now).toISOString() };
    if (device && device.user_agent) patch.user_agent = device.user_agent;
    if (device && device.ip_hash) patch.ip_hash = device.ip_hash;
    await hreq({
      method: 'PATCH',
      url: sessionsUrl('token_hash=eq.' + enc(tokenHash)),
      headers: { ...cfg.sbH, Prefer: 'return=minimal' },
      body: patch,
      json: true,
    });
    return true;
  } catch (e) {
    console.error('[deviceSessions] touchDevice failed:', e.message);
    return false;
  }
}

// revokeDevice(userId, sessionId) -> true if a row was actually removed.
//
// The `user_id` filter is the authorization boundary and is NOT optional: it is what stops
// one account revoking another account's device by guessing an id. It is folded into the
// DELETE itself rather than checked in a preceding SELECT, so there is no window between the
// check and the delete. Returns false when nothing matched, so the caller can answer 404
// instead of a false success (the same "matched nothing is not success" lesson recorded
// against sbSoftDelete after the 2026-07-22 incident).
async function revokeDevice(userId, sessionId) {
  if (!userId || !sessionId) return false;
  const rows = await hreq({
    method: 'DELETE',
    url: sessionsUrl('user_id=eq.' + enc(userId) + '&id=eq.' + enc(sessionId)),
    headers: { ...cfg.sbH, Prefer: 'return=representation' },
    json: true,
  });
  return Array.isArray(rows) && rows.length > 0;
}

// revokeOtherDevices(userId, keepTokenHash) -> number removed. "Sign out everywhere else":
// keeps the caller's own session so the person is not logged out by their own click.
async function revokeOtherDevices(userId, keepTokenHash) {
  if (!userId) return 0;
  let filters = 'user_id=eq.' + enc(userId);
  if (keepTokenHash) filters += '&token_hash=neq.' + enc(keepTokenHash);
  const rows = await hreq({
    method: 'DELETE',
    url: sessionsUrl(filters),
    headers: { ...cfg.sbH, Prefer: 'return=representation' },
    json: true,
  });
  return Array.isArray(rows) ? rows.length : 0;
}

// isNewDevice(userId, device) -> true when this user has no LIVE session already carrying
// the same user-agent + ip_hash pair.
//
// Honest about what it is: a heuristic for "worth telling the user about", not a security
// control. It is checked BEFORE the new session row is written, or it would always find
// itself and never fire.
async function isNewDevice(userId, device) {
  try {
    if (!userId || !device || (!device.ip_hash && !device.user_agent)) return false;
    const url = sessionsUrl('user_id=eq.' + enc(userId) + '&limit=100');
    const rows = await hreq({ url, headers: cfg.sbH, json: true });
    if (!Array.isArray(rows) || rows.length === 0) return false;   // first ever session is not "new device"
    return !rows.some((s) => s.user_agent === device.user_agent && s.ip_hash === device.ip_hash);
  } catch (e) {
    console.error('[deviceSessions] isNewDevice failed:', e.message);
    return false;   // fail quiet: a broken heuristic must not invent alarming notifications
  }
}

// stampPasswordChanged(userId) — audit answer to "when did this account's credentials last
// change?". Revocation itself remains lib/auth.js's hard DELETE, unchanged.
async function stampPasswordChanged(userId, now = Date.now()) {
  try {
    if (!userId) return;
    await hreq({
      method: 'PATCH',
      url: cfg.SB_REST + '/users?id=eq.' + enc(userId) + '&account_id=eq.' + enc(cfg.ACCOUNT_ID),
      headers: { ...cfg.sbH, Prefer: 'return=minimal' },
      body: { password_changed_at: new Date(now).toISOString() },
      json: true,
    });
  } catch (e) {
    console.error('[deviceSessions] stampPasswordChanged failed:', e.message);
  }
}

module.exports = {
  deviceFromRequest, hashIp, cleanUserAgent,
  recordAuthEvent, recentEvents,
  listDevices, touchDevice, revokeDevice, revokeOtherDevices, isNewDevice,
  stampPasswordChanged,
  TOUCH_INTERVAL_MS, UA_MAX,
};
