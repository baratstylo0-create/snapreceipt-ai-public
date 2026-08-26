// api.js — thin same-origin fetch wrapper for the reference frontend.
//
// All calls hit our own /api/* (same origin), so no base URL is prepended and no
// Supabase key is ever exposed to the browser. A bearer token (populated by the
// auth task from sessionStorage) is attached when present. Non-2xx responses
// throw a structured { status, body } error so callers can branch on status.
//
// UMD shim: attaches window.Api in the browser; require()-able in Node. Only the
// pure surface (setToken/getToken) is exercised in Node — apiFetch needs fetch.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Api = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Module-level token. Task A wires this to sessionStorage; for now it is a
  // plain in-memory slot with get/set accessors.
  var _token = null;
  function setToken(t) { _token = t || null; }
  function getToken() { return _token; }

  // --- rate-limit visibility (reads Barat's RateLimit-* trio, PR #56) ---------
  // The shared limiter emits RateLimit-Limit/Remaining/Reset on every response of a
  // limited route (agent/upload/templates). We capture the latest here so the header
  // "% used" meter can render + warn near the edge. Routes WITHOUT the limiter (reads:
  // expenses/reports/excel) omit the headers, so we simply don't update — no false meter.
  var _rate = null;               // { limit, remaining, reset, at } | null
  var _rateSubs = [];
  function readRateHeaders(res) {
    if (!res || !res.headers || !res.headers.get) return;
    var lim = res.headers.get('RateLimit-Limit');
    var rem = res.headers.get('RateLimit-Remaining');
    if (lim == null || rem == null) return; // route not behind the limiter — ignore
    var limit = Number(lim), remaining = Number(rem), reset = Number(res.headers.get('RateLimit-Reset'));
    if (!isFinite(limit) || !isFinite(remaining)) return;
    _rate = { limit: limit, remaining: remaining, reset: isFinite(reset) ? reset : 0, at: Date.now() };
    for (var i = 0; i < _rateSubs.length; i++) { try { _rateSubs[i](_rate); } catch (e) { /* a bad subscriber never breaks fetch */ } }
  }
  function getRateLimit() { return _rate; }
  function onRateLimit(cb) { if (typeof cb === 'function') _rateSubs.push(cb); }

  // --- session-expiry notification (2026-07-11 live incident) -----------------
  // Every dashboard view calls through apiFetch/fetchBlob, so this is the ONE place
  // a dead session can be caught for every caller at once, instead of each view's own
  // .catch rendering its own generic "could not load" message with no way for the user
  // to tell "server hiccup" from "you're logged out" (that's exactly what happened live:
  // the session's 12h TTL lapsed and every panel failed identically until a manual
  // logout+login — the app gave no sign that logging in again was the fix).
  // Deliberately narrow: only notify when a bearer token was actually attached to the
  // FAILING request. That is what tells a real "your session died" 401 (a token was sent
  // and rejected) apart from an expected, unauthenticated 401 like a wrong-password
  // POST /api/login attempt (no token exists yet — that 401 is normal login-form
  // feedback, not a session death, and must not yank the login form out from under
  // someone mid-attempt).
  var _authExpiredSubs = [];
  function onAuthExpired(cb) { if (typeof cb === 'function') _authExpiredSubs.push(cb); }
  function notifyAuthExpired() {
    for (var i = 0; i < _authExpiredSubs.length; i++) { try { _authExpiredSubs[i](); } catch (e) { /* a bad subscriber never breaks fetch */ } }
  }

  // 2026-08-24 (Barat: "minimize Chrome, reopen it, logged out" — recurring): a single
  // 401 on a token-bearing request used to be treated as proof the session is dead —
  // instantly wiping storage and reloading to the login screen. Live server logs showed
  // real, unexpired sessions (still sitting valid in the sessions table) get rejected by
  // brief Supabase hiccups (request timeouts / bad-gateway responses were logged in the
  // same window) — the app was punishing users for an infra blip, not a real logout.
  // A short wait + ONE retry of the exact same request tells the two apart: a transient
  // blip clears up and the retry succeeds (nothing happens, the original caller gets its
  // real data); a genuinely dead/expired/revoked token still 401s on the retry too, and
  // THAT is what triggers the logout — same end behavior as before for a real session
  // death, just not on the very first flaky response. Exposed as a mutable export so
  // tests can drop it to 0 instead of actually waiting.
  var AUTH_RETRY_DELAY_MS = 600;
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // Fetch a same-origin /api path. opts is a standard fetch init; we layer on
  // Accept + optional Authorization and JSON body handling. Returns parsed JSON
  // (or text) on 2xx; throws { status, body } otherwise.
  //
  // opts.skipAuthExpiredNotify (2026-08-25 fix, "Google Login -> Dashboard ->
  // unexpected redirect back to Landing Page"): a caller that treats its OWN
  // 401 as non-fatal (a best-effort check with an explicit "stay silent on
  // failure" .catch — e.g. app.js's email-verification banner probe) still
  // fed into this SHARED, GLOBAL notifyAuthExpired() before this flag existed.
  // notifyAuthExpired() has an app-wide side effect (api.js has no idea the
  // caller only wanted this one optional check to fail quietly) — it wipes
  // the whole session and reloads to the login/landing screen. Live server
  // logs confirmed /api/verify-email/status legitimately 401ing shortly after
  // a fresh Google sign-in (still under investigation server-side — see the
  // handoff to the backend session) — regardless of WHY that one non-critical
  // check fails, it must never be able to nuke an otherwise-healthy session
  // out from under the user. The once-per-401 retry-for-flakiness behavior is
  // unchanged either way; only the final notifyAuthExpired() call is gated.
  function apiFetch(path, opts, _retriedAuth) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (_token) headers.Authorization = 'Bearer ' + _token;

    var init = Object.assign({}, opts, { headers: headers });
    // Serialise a plain-object body to JSON if the caller did not pre-encode it.
    // Binary bodies (ArrayBuffer/Blob — e.g. an .xlsx template upload) are left
    // exactly as-is; only a plain object gets JSON-stringified.
    var isBinaryBody = (typeof ArrayBuffer !== 'undefined' && init.body instanceof ArrayBuffer)
      || (typeof Blob !== 'undefined' && init.body instanceof Blob)
      || (typeof FormData !== 'undefined' && init.body instanceof FormData);
    if (init.body && typeof init.body === 'object' && !isBinaryBody) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    return fetch(path, init).then(function (res) {
      readRateHeaders(res); // capture RateLimit-* on BOTH ok and 429 responses
      var ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (body) {
        if (!res.ok) {
          if (res.status === 401 && headers.Authorization) {
            if (!_retriedAuth) return delay(AUTH_RETRY_DELAY_MS).then(function () { return apiFetch(path, opts, true); });
            if (!opts.skipAuthExpiredNotify) notifyAuthExpired();
          }
          throw { status: res.status, body: body };
        }
        return body;
      });
    });
  }

  // Fetch a same-origin path and resolve the raw Response body as a Blob, carrying the
  // same bearer-token attachment as apiFetch. Needed for /receipt/:fileId (P6 hardening):
  // once that route requires checkDash, a plain <a href> navigation can't carry an
  // Authorization header, so the receipt image must be fetched (blob -> object URL) and
  // rendered into a real <img>, never assigned via innerHTML/href with unescaped data.
  // Kept separate from apiFetch (which always parses JSON/text) rather than overloading
  // it, to avoid changing behavior for every existing JSON caller.
  function fetchBlob(path, opts, _retriedAuth) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (_token) headers.Authorization = 'Bearer ' + _token;
    var init = Object.assign({}, opts, { headers: headers });
    return fetch(path, init).then(function (res) {
      readRateHeaders(res);
      if (!res.ok) {
        if (res.status === 401 && headers.Authorization && !_retriedAuth) {
          return delay(AUTH_RETRY_DELAY_MS).then(function () { return fetchBlob(path, opts, true); });
        }
        if (res.status === 401 && headers.Authorization) notifyAuthExpired();
        return res.text().then(function (body) { throw { status: res.status, body: body }; }, function () {
          throw { status: res.status, body: null };
        });
      }
      return res.blob();
    });
  }

  return { apiFetch: apiFetch, fetchBlob: fetchBlob, setToken: setToken, getToken: getToken,
    getRateLimit: getRateLimit, onRateLimit: onRateLimit, onAuthExpired: onAuthExpired,
    // Test-only escape hatch: drop the retry-before-logout delay to 0 so 401 tests don't
    // actually wait. Getter/setter (not a bare property) so every module require() of
    // this UMD-shimmed file shares the SAME live value instead of each getting its own
    // frozen copy at export time.
    setAuthRetryDelayForTests: function (ms) { AUTH_RETRY_DELAY_MS = ms; } };
});
