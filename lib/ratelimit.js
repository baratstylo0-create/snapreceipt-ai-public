'use strict';
// Lightweight in-process rate limiter (P6 hardening — SOP §7.2 abuse defense).
// No new dependency: a fixed-window counter keyed by client IP, held in a Map.
//
// Shared helper — usable by ANY route (Barat wires it into routes/webhook.js and
// routes/templates.js; Jeevan can reuse the same file for server.js / his routes
// instead of writing a second one — coordinate via §0.1 of the frontend/QA/security plan).
//
// Fixed-window (not token-bucket) is deliberate: simplest correct thing, zero deps,
// good enough to blunt brute-force of the auth gate and cost-drain of the AI/upload
// endpoints. Single-process v1 (same caveat as the media-group buffer); a multi-instance
// deploy would move this to a shared store (Redis) — noted for P9.

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000; // 1 minute
// Cap the number of tracked IPs so a spray of unique source IPs can't grow the Map
// without bound (a memory-exhaustion vector in itself). When exceeded we drop expired
// entries first, then—if still over—clear the oldest. Generous default.
const MAX_TRACKED_IPS = Number(process.env.RATE_LIMIT_MAX_IPS) || 10000;

// clientKey — the IP to bucket by. Trusts Express's req.ip (server sets 'trust proxy'),
// falling back to the socket address, then a constant so a missing IP still limits
// (fail-safe: unknown clients share one bucket rather than bypassing the limit).
function clientKey(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

// createRateLimiter({ max, windowMs?, now? }) -> Express middleware.
//   max      : requests allowed per window per IP (required).
//   windowMs : window length (default RATE_LIMIT_WINDOW_MS).
//   now      : clock injection for tests (default Date.now).
// On limit: 429 + a fixed, non-identifying JSON body and a Retry-After header.
function createRateLimiter({ max, windowMs = WINDOW_MS, now = Date.now, keyFn = clientKey } = {}) {
  if (!Number.isFinite(max) || max <= 0) throw new Error('createRateLimiter: max must be a positive number');
  const hits = new Map(); // key -> { count, resetAt }

  function prune(t) {
    for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
    if (hits.size > MAX_TRACKED_IPS) { // still over after pruning expired: shed oldest
      const excess = hits.size - MAX_TRACKED_IPS;
      let i = 0;
      for (const k of hits.keys()) { if (i++ >= excess) break; hits.delete(k); }
    }
  }

  return function rateLimit(req, res, next) {
    const t = now();
    const key = keyFn(req);
    let rec = hits.get(key);
    if (!rec || t >= rec.resetAt) { rec = { count: 0, resetAt: t + windowMs }; hits.set(key, rec); }
    rec.count += 1;
    if (rec.count > max) {
      const retryS = Math.max(1, Math.ceil((rec.resetAt - t) / 1000));
      res.set('Retry-After', String(retryS));
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    if (hits.size > MAX_TRACKED_IPS) prune(t);
    return next();
  };
}

module.exports = { createRateLimiter, clientKey };
