'use strict';
// SEC-6 (ADR-025): central security-event logging. ONE middleware, mounted once, observes the
// FINAL response status and emits a structured line for the security-relevant ones — auth
// failures (401), authorization/scope denials (403), and rate-limit trips (429) — so no route
// needs its own logging call and none can be forgotten as the app grows. Hooks res 'finish'
// (after the response is sent) so it never touches the request path or adds latency.
//
// ADR-002: logs method/path/status/ip only — never bodies, tokens, query strings, or receipt
// data (path excludes the query string). The source IP IS included: investigating "who tried to
// get in" is the entire purpose of a security log, and the rate limiter already keys on it.
const { logSecurity } = require('./log');

const EVENT = { 401: 'auth_fail', 403: 'scope_deny', 429: 'rate_limit' };

module.exports = function securityEvents(req, res, next) {
  res.on('finish', () => {
    const event = EVENT[res.statusCode];
    if (event) logSecurity(event, { method: req.method, path: req.path, status: res.statusCode, ip: req.ip || '' });
  });
  next();
};
