// authgate.js — pure, DOM-free decision logic for the dashboard auth gate.
//
// The gate: on load we probe GET /api/config for { auth_required }. If auth is
// required and we have no usable token in sessionStorage, we must block the app
// behind a token-entry screen; otherwise we enter directly. That branch is the
// only thing worth unit-testing, so it lives here as a pure function with no DOM
// and no network — app.js wires it to the real config/storage.
//
// UMD shim: attaches window.AuthGate in the browser; require()-able in Node so
// node:test can exercise it with no jsdom (consistent with escape.js/api.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuthGate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Trim a candidate token; a blank/whitespace-only string is NOT a token, so it
  // collapses to null. Used both to sanitise stored tokens and user input.
  function normaliseToken(t) {
    if (t === null || t === undefined) return null;
    var s = String(t).trim();
    return s === '' ? null : s;
  }

  // Decide the gate outcome. Returns 'enter' (proceed into the app), 'prompt'
  // (show the token-entry screen), 'login' (business mode's username/password
  // screen — ADR-021 Phase 6), or 'signup' (personal-mode real-account onboarding
  // — 2026-07-25). Defensive: missing args default to 'enter' (auth not
  // required), and authRequired is coerced to a boolean.
  //
  // Business mode (multiUser truthy) has exactly ONE gate: the login screen. The
  // static token box never appears there (there is no static token to enter —
  // sessions replace it), so multiUser is checked FIRST, before authRequired.
  //
  // personalAuth (2026-07-25): a personal deployment with real accounts turned on
  // has exactly ONE gate too — the signup/onboarding flow — same reasoning as
  // multiUser above. The old static token box (`prompt`) must NEVER appear once
  // personalAuth is on, even as a fallback (confirmed decision, 2026-07-25: a
  // page reload losing the in-memory session used to fall back to the token box,
  // which read as a confusing bug, not a real second way in).
  function authState(opts) {
    opts = opts || {};
    if (opts.multiUser) return normaliseToken(opts.storedToken) ? 'enter' : 'login';
    if (opts.personalAuth) return normaliseToken(opts.storedToken) ? 'enter' : 'signup';
    if (!opts.authRequired) return 'enter';
    return normaliseToken(opts.storedToken) ? 'enter' : 'prompt';
  }

  return { authState: authState, normaliseToken: normaliseToken };
});
