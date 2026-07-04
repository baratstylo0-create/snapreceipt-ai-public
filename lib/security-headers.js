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
  // fonts.googleapis.com serves the Spectral/Nunito Sans stylesheet (the Treehouse design
  // system's typefaces, loaded via <link> in index.html). Specific host only — NOT
  // 'unsafe-inline', so inline styles/on*= handlers stay forbidden.
  "style-src 'self' https://fonts.googleapis.com",
  // The actual woff2 font files are served from fonts.gstatic.com.
  "font-src 'self' https://fonts.gstatic.com",
  // blob: is required for receipt images: the dashboard fetches them with an auth'd XHR
  // (the /receipt route is checkDash-gated, so a plain <img src> can't carry the bearer)
  // and renders the bytes as a browser-generated blob: object URL. blob: URLs can only
  // reference data the page itself created — not an injection vector, unlike a remote host.
  "img-src 'self' data: blob:",
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
  // Cross-Origin-Resource-Policy: nothing on another origin may embed/read our responses
  // (receipt images, API JSON) — defence-in-depth alongside the CORS origin check.
  res.set('Cross-Origin-Resource-Policy', 'same-origin');

  // HSTS (downgrade protection): only meaningful — and per spec only honoured — over HTTPS,
  // so emit it ONLY on a secure request (req.secure reflects x-forwarded-proto because
  // server.js sets 'trust proxy'). This keeps local HTTP dev untouched while a real HTTPS
  // deploy gets strict transport security. No `preload`/`includeSubDomains` yet — those are a
  // one-way commitment to add deliberately at launch once every subdomain is HTTPS-ready.
  if (req && req.secure) {
    res.set('Strict-Transport-Security', 'max-age=15552000'); // 180 days
  }

  // Data-bearing responses must never be cached. req.path excludes the query
  // string, so a startsWith check is enough.
  const p = (req && req.path) || '';
  if (p.indexOf('/api/') === 0 || p.indexOf('/receipt') === 0) {
    res.set('Cache-Control', 'no-store');
  }
  next();
}

module.exports = securityHeaders;
