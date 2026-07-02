// components/nav.js — the top navigation bar for the app shell.
//
// Pure DOM construction: every element is built with createElement + textContent
// (never innerHTML), so no untrusted value can ever inject markup and the strict
// no-inline CSP is satisfied. The section list is the single source of truth for
// both the nav buttons and the view-switching in app.js.
//
// UMD shim: window.Nav in the browser; require()-able in Node. Node has no DOM,
// so buildNav() no-ops (returns null) there — the SECTIONS list is still exported
// so it stays unit-inspectable without a DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Nav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical section order. id is used as the view key; label is display text.
  var SECTIONS = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'upload', label: 'Upload' },
    { id: 'manage', label: 'Manage' },
    { id: 'reports', label: 'Reports' },
    { id: 'agent', label: 'Agent' },
  ];

  // Build the nav bar. onSelect(id) fires when a section button is clicked;
  // onToggleTheme() fires when the dark/light toggle is clicked. Returns the
  // <nav> element, or null outside a browser. Static text only via textContent.
  function buildNav(opts) {
    if (typeof document === 'undefined') return null;
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    var onToggleTheme = typeof opts.onToggleTheme === 'function' ? opts.onToggleTheme : function () {};

    var nav = document.createElement('nav');
    nav.className = 'nav';

    var brand = document.createElement('span');
    brand.className = 'nav-brand';
    brand.textContent = 'Receipt Analyser';
    nav.appendChild(brand);

    var links = document.createElement('div');
    links.className = 'nav-links';
    var buttons = {};
    SECTIONS.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-link';
      btn.setAttribute('data-view', s.id);
      btn.textContent = s.label;
      // addEventListener (not on*=) keeps us CSP-clean.
      btn.addEventListener('click', function () { onSelect(s.id); });
      links.appendChild(btn);
      buttons[s.id] = btn;
    });
    nav.appendChild(links);

    var greeting = document.createElement('span');
    greeting.className = 'nav-greeting';
    greeting.textContent = 'Welcome back';
    nav.appendChild(greeting);

    var theme = document.createElement('button');
    theme.type = 'button';
    theme.className = 'nav-theme';
    theme.textContent = 'Theme';
    theme.setAttribute('aria-label', 'Toggle dark/light theme');
    theme.addEventListener('click', function () { onToggleTheme(); });
    nav.appendChild(theme);

    // Mark the active button so app.js can reflect the current view.
    function setActive(id) {
      SECTIONS.forEach(function (s) {
        if (buttons[s.id]) buttons[s.id].classList.toggle('is-active', s.id === id);
      });
    }

    return { el: nav, setActive: setActive };
  }

  return { buildNav: buildNav, SECTIONS: SECTIONS };
});
