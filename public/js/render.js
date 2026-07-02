// render.js — small DOM-building helpers for the reference frontend.
//
// Rule: untrusted data NEVER reaches innerHTML. DOM builders use textContent
// (which cannot execute markup); the one string-returning helper (row) routes
// every cell through Escape.safeText so callers using template strings stay safe
// too. Later tasks extend this module.
//
// UMD shim: in Node it require()s ./escape; in the browser it reads the
// window.Escape global that escape.js attaches. Keep the shim consistent with
// escape.js so both load with no build step.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./escape'));
  else root.Render = factory(root.Escape);
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

  // Build a <tr> string from cells, each individually escaped. Pure string logic
  // (unit-testable in Node with no DOM). Prefer rowEl() when a real element is
  // available; this exists for template-string call sites, hence the escaping.
  function row(cells) {
    var list = Array.isArray(cells) ? cells : [cells];
    var tds = list.map(function (c) { return '<td>' + Escape.safeText(c) + '</td>'; });
    return '<tr>' + tds.join('') + '</tr>';
  }

  // DOM-safe row builder: creates a real <tr> and sets each cell via textContent
  // so no markup is ever interpreted. Returns null outside a browser (no document).
  function rowEl(cells) {
    if (typeof document === 'undefined') return null;
    var list = Array.isArray(cells) ? cells : [cells];
    var tr = document.createElement('tr');
    list.forEach(function (c) {
      var td = document.createElement('td');
      Escape.setText(td, c);
      tr.appendChild(td);
    });
    return tr;
  }

  return { row: row, rowEl: rowEl };
});
