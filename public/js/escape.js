// escape.js — THE single output-escaping utility for the reference frontend.
//
// Every renderer that puts untrusted data (OCR text, merchant names, ai_raw,
// AI-agent output, filenames) into the DOM MUST route it through here. A strict
// Content-Security-Policy (no inline JS/CSS) is added later; this module is the
// last line of defense against markup injection at render time.
//
// UMD shim: loadable both as a browser <script> (attaches window.Escape) and as
// a CommonJS module (require('./escape')) so it can be unit-tested under
// node:test with no build step and no jsdom.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Escape = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Order matters: '&' first (via the character class + map), so entities
  // produced below are not re-escaped.
  var HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  // Coerce anything to a display string. null/undefined -> '' (never the words
  // "null"/"undefined" leaking into the UI); everything else via String().
  function coerce(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  // Replace the five HTML-significant characters with entities. Safe for any
  // input type (numbers, booleans, objects, null, undefined).
  function escapeHtml(value) {
    return coerce(value).replace(/[&<>"']/g, function (ch) { return HTML_ENTITIES[ch]; });
  }

  // Strip C0/C1 control characters (NUL etc.). Matches lib/templates.js so the
  // frontend and backend agree on what a "control byte" is.
  // eslint-disable-next-line no-control-regex
  var CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
  function stripControls(value) {
    return coerce(value).replace(CONTROL_RE, '');
  }

  // The convenience every renderer calls for untrusted text destined for the DOM:
  // strip control bytes, then HTML-escape.
  function safeText(value) {
    return escapeHtml(stripControls(value));
  }

  // Preferred DOM-safe path when you have an element: textContent never
  // interprets markup, so we only need control-byte stripping.
  function setText(el, value) {
    if (el) el.textContent = stripControls(value);
    return el;
  }

  return { escapeHtml: escapeHtml, stripControls: stripControls, safeText: safeText, setText: setText };
});
