'use strict';
// Shared (multi-instance) rate limiting — P-04a, 2026-08-24, issue #37.
//
// THE PROBLEM. lib/ratelimit.js is a per-process Map. Its own header said so honestly
// ("Single-process v1 ... a multi-instance deploy would move this to a shared store"), but
// that gap is now load-bearing: two instances behind a load balancer hand an attacker twice
// the budget, and a restart silently resets every counter. The 2026-08-24 gap audit lists
// single-process limiting as a P0 launch blocker, and both P-01's OTP endpoints and P-02a's
// revoke endpoints lean on rate limiting to mean something.
//
// THE DESIGN: a two-layer limiter, not a replacement.
//
//   Layer 1 — the existing in-memory limiter, unchanged, checked FIRST. It costs nothing and
//             it stops an obvious flood before the request ever reaches the database. Letting
//             a flood spend a DB round-trip per request would turn the limiter itself into
//             the amplification vector.
//   Layer 2 — an atomic Postgres counter shared by every instance. This is the one that
//             actually enforces a global budget.
//
// FAILURE POSTURE, stated explicitly because it is a real security decision and not an
// accident: if the shared store is unreachable, this FAILS OPEN — but layer 1 still applies.
// So a database outage degrades protection to exactly today's behaviour, never to none. The
// alternative (fail closed) would mean a Supabase blip locks every user out of logging in,
// converting a availability problem into a total outage. For a limiter that is the wrong
// trade; for an authorization check it would be the right one, which is why this reasoning
// does not generalise beyond this file.
//
// PRIVACY (PDPA / C-02): the bucket key is a salted hash. A rate limiter is not a reason to
// begin retaining IP addresses.
const crypto = require('node:crypto');
const { cfg } = require('./config');
const { sbRpc } = require('./supabase');
const { createRateLimiter, clientKey } = require('./ratelimit');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

// Whether the shared layer is used at all. Defaults ON, but an operator running a single
// process who wants zero extra latency (or a deployment whose database predates the
// migration) can turn it off and fall back to exactly the previous behaviour.
function sharedEnabled() {
  const v = process.env.SHARED_RATE_LIMIT;
  if (v == null || v === '') return true;
  return /^(1|true|yes|on)$/i.test(String(v));
}

// Same salt reasoning as lib/deviceSessions.js: never a shared constant, because an unsalted
// hash of an IPv4 address is brute-forceable back to the address in seconds.
//
// (Yes, this duplicates three lines from deviceSessions. Deliberately: that module hashes for
// device fingerprinting and this one for bucket keying — folding them into one shared helper
// would couple two unrelated concerns across two in-flight branches. Worth consolidating once
// both have landed.)
function bucketKey(name, client) {
  const salt = process.env.SESSION_IP_SALT || cfg.SB_KEY || 'snapreceipt-local-dev-salt';
  return crypto.createHash('sha256').update(salt + '|' + name + '|' + String(client)).digest('hex');
}

// bumpShared(name, client, windowMs) -> the count including this request, or null when the
// shared store could not answer. null means "unknown", NOT "zero" — the caller must treat it
// as fail-open rather than as a fresh budget.
async function bumpShared(name, client, windowMs = WINDOW_MS) {
  try {
    const count = await sbRpc('bump_rate_limit', {
      p_key: bucketKey(name, client),
      p_window_ms: Math.max(1000, Number(windowMs) || WINDOW_MS),
    });
    const raw = Array.isArray(count) ? count[0] : count;
    // Type-check BEFORE Number(). `Number(null) === 0`, so a null response body — which
    // PostgREST can legitimately return, and hreq hands back as null — would otherwise read
    // as a real count of zero: a full budget advertised on every malformed answer, and a
    // value indistinguishable from "first request in the window" to anyone debugging it.
    // Found by a test written after mutation testing exposed this path as uncovered.
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    // Logged once per failure, not silently swallowed: an operator needs to know the shared
    // layer has stopped enforcing. The request still proceeds through layer 1.
    console.error('[sharedLimit] shared store unavailable, falling back to in-process only:', e.message);
    return null;
  }
}

// createAbuseLimiter({ name, max, windowMs, localMax, keyFn }) -> Express middleware.
//
//   name     : identifies the bucket. MUST be unique per endpoint, or two endpoints share a
//              budget and one can starve the other.
//   max      : requests per window per client, enforced GLOBALLY across instances.
//   localMax : the per-process layer-1 ceiling. Defaults to `max`, which is the safe choice:
//              a single instance can then never exceed the global budget on its own.
//
// Drop-in compatible with createRateLimiter's call shape, so wiring an endpoint is a one-line
// change and the 429 body/headers stay identical to what clients already handle.
function createAbuseLimiter({ name, max, windowMs = WINDOW_MS, localMax, keyFn = clientKey } = {}) {
  if (!name) throw new Error('createAbuseLimiter: a unique name is required');
  if (!Number.isFinite(max) || max <= 0) throw new Error('createAbuseLimiter: max must be a positive number');

  const local = createRateLimiter({ max: Number.isFinite(localMax) ? localMax : max, windowMs, keyFn });

  return function abuseLimit(req, res, next) {
    // Layer 1 first. If it rejects, it has already sent its own 429 and `next` never runs —
    // so a flood is cut off without touching the database.
    return local(req, res, async () => {
      if (!sharedEnabled()) return next();
      const count = await bumpShared(name, keyFn(req), windowMs);
      if (count === null) return next();          // fail open; layer 1 already applied
      if (count > max) {
        const retry = Math.max(1, Math.ceil(windowMs / 1000));
        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', '0');
        res.set('Retry-After', String(retry));
        // Identical body to lib/ratelimit.js so a client cannot tell which layer refused it,
        // and so existing 429 handling keeps working unchanged.
        return res.status(429).json({ error: 'rate limit exceeded' });
      }
      res.set('RateLimit-Limit', String(max));
      res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
      return next();
    });
  };
}

module.exports = { createAbuseLimiter, bumpShared, bucketKey, sharedEnabled, WINDOW_MS };
