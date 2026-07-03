// format.js — pure money/number formatting for the reference frontend.
//
// Numbers rendered in the UI (KPI cards, chart values, tooltips) go through here
// so they are readable (thousands separators, fixed money decimals) AND safe:
// junk / non-finite input degrades to a boring 0 instead of leaking "NaN" or
// "Infinity" into the dashboard. Pure + I/O-free, so it is unit-testable under
// node:test with no DOM and no build step.
//
// UMD shim: attaches window.Format in the browser; require()-able in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Format = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Coerce anything to a finite number, or 0. Rejects NaN/±Infinity/objects so
  // no non-finite value can ever reach the display string.
  function toFinite(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  // Insert thousands separators into the integer part of an already-formatted
  // (sign-stripped) numeric string. Works without Intl so it behaves identically
  // in Node tests and every browser.
  function groupThousands(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Money: always two decimals, grouped thousands, negative sign preserved.
  function formatMoney(v) {
    var n = toFinite(v);
    var neg = n < 0;
    var fixed = Math.abs(n).toFixed(2);        // "1234.50"
    var parts = fixed.split('.');
    return (neg ? '-' : '') + groupThousands(parts[0]) + '.' + parts[1];
  }

  // Count: whole number (floored), grouped thousands, no decimals.
  function formatCount(v) {
    var n = Math.floor(Math.abs(toFinite(v)));
    var neg = toFinite(v) < 0 && n !== 0;
    return (neg ? '-' : '') + groupThousands(String(n));
  }

  return { formatMoney: formatMoney, formatCount: formatCount, toFinite: toFinite };
});
