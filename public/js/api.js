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
      var ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (body) {
        if (!res.ok) throw { status: res.status, body: body };
        return body;
      });
    });
  }

  return { apiFetch: apiFetch, setToken: setToken, getToken: getToken };
});
