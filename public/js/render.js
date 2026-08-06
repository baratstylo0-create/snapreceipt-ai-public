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

  // Only one info popup open at a time — closing any previous one before a
  // new click opens another (or re-clicking the same icon toggles it shut).
  // Shared across every buildInfoIcon() instance on the page (originally
  // app.js's per-page "what is this page for" hint, ARCHITECTURE-neutral so
  // any component can reuse the same small "i" explainer affordance).
  function closeInfoPopups() {
    if (typeof document === 'undefined') return;
    var existing = document.querySelectorAll('.view-info-popup-host');
    for (var i = 0; i < existing.length; i++) {
      if (typeof existing[i]._cleanup === 'function') existing[i]._cleanup();
      if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
    }
    var buttons = document.querySelectorAll('.view-info-btn[aria-expanded="true"]');
    for (var j = 0; j < buttons.length; j++) buttons[j].setAttribute('aria-expanded', 'false');
  }

  // A small "i" button that, on click, shows a fixed-position popup with
  // `text` right under it (clamped to the viewport width). `label` (optional)
  // sets the button's aria-label; defaults to a generic "More information".
  // Returns null outside a browser (no document).
  function buildInfoIcon(text, label) {
    if (typeof document === 'undefined') return null;
    var root = typeof self !== 'undefined' ? self : this;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-info-btn';
    btn.setAttribute('aria-label', label || 'More information');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = 'i';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var wasOpen = btn.getAttribute('aria-expanded') === 'true';
      closeInfoPopups();
      if (wasOpen) return; // this click just closed it — don't reopen

      btn.setAttribute('aria-expanded', 'true');
      var host = document.createElement('div');
      host.className = 'view-info-popup-host';
      var pop = document.createElement('div');
      pop.className = 'view-info-popup';
      pop.setAttribute('role', 'tooltip');
      pop.textContent = text;
      host.appendChild(pop);
      document.body.appendChild(host);

      var rect = btn.getBoundingClientRect();
      var popW = 260;
      var left = Math.min(rect.right - popW, (root.innerWidth || 1024) - popW - 16);
      pop.style.top = (rect.bottom + 8) + 'px';
      pop.style.left = Math.max(8, left) + 'px';

      function onDocClick(e) { if (!host.contains(e.target) && e.target !== btn) closeInfoPopups(); }
      function onKeydown(e) { if (e.key === 'Escape') closeInfoPopups(); }
      // Deferred one tick so THIS click (which is still bubbling) doesn't
      // immediately trigger onDocClick and close the popup it just opened.
      root.setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
      document.addEventListener('keydown', onKeydown);
      host._cleanup = function () {
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKeydown);
      };
    });
    return btn;
  }

  return { row: row, rowEl: rowEl, buildInfoIcon: buildInfoIcon, closeInfoPopups: closeInfoPopups };
});
