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

  // Fetch a same-origin /api path. opts is a standard fetch init; we layer on
  // Accept + optional Authorization and JSON body handling. Returns parsed JSON
  // (or text) on 2xx; throws { status, body } otherwise.
  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (_token) headers.Authorization = 'Bearer ' + _token;

    var init = Object.assign({}, opts, { headers: headers });
    // Serialise a plain-object body to JSON if the caller did not pre-encode it.
    if (init.body && typeof init.body === 'object' && !(init.body instanceof FormData)) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    return fetch(path, init).then(function (res) {
      readRateHeaders(res); // capture RateLimit-* on BOTH ok and 429 responses
      var ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (body) {
        if (!res.ok) throw { status: res.status, body: body };
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
  function fetchBlob(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (_token) headers.Authorization = 'Bearer ' + _token;
    var init = Object.assign({}, opts, { headers: headers });
    return fetch(path, init).then(function (res) {
      readRateHeaders(res);
      if (!res.ok) {
        return res.text().then(function (body) { throw { status: res.status, body: body }; }, function () {
          throw { status: res.status, body: null };
        });
      }
      return res.blob();
    });
  }

  return { apiFetch: apiFetch, fetchBlob: fetchBlob, setToken: setToken, getToken: getToken,
    getRateLimit: getRateLimit, onRateLimit: onRateLimit };
});
