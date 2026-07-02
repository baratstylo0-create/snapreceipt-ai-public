'use strict';
// security-headers.js — one dependency-free express middleware that stamps the
// security headers on EVERY response (Task A §4.2). Mounted in server.js before
// the route mounts so it covers pages, static assets and API responses alike.
//
// The CSP is strict on purpose: only same-origin scripts/styles are allowed and
// inline is forbidden. That is why the frontend uses external css/app.css and
// external js/*.js exclusively — no inline <script>, no inline style, no on*=.
//
// Cache-Control: no-store is added ONLY on data-bearing paths (/api/*, /receipt)
// so dynamic expense/receipt data is never cached by a browser or proxy; static
// assets keep their default caching.

// Assembled once at module load — the value never changes per request.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Data-bearing responses must never be cached. req.path excludes the query
  // string, so a startsWith check is enough.
  const p = (req && req.path) || '';
  if (p.indexOf('/api/') === 0 || p.indexOf('/receipt') === 0) {
    res.set('Cache-Control', 'no-store');
  }
  next();
}

module.exports = securityHeaders;
