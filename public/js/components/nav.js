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
  // Phase 2 (Mugi's Treehouse concept): the Agent is no longer a nav tab — it
  // lives in the floating "Falc" assistant (components/falc.js), so it's dropped
  // here. A dedicated Settings view takes its place.
  var SECTIONS = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'upload', label: 'Upload' },
    { id: 'manage', label: 'Manage' },
    { id: 'reports', label: 'Reports' },
    { id: 'settings', label: 'Settings' },
  ];

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Build Mugi's "Treehouse" brand emblem (a leaf mark) as inline SVG via
  // createElementNS — never innerHTML — so the strict no-inline CSP holds.
  // Returns the emblem <span> wrapper (or null outside a browser).
  function buildEmblem() {
    if (typeof document === 'undefined') return null;
    var wrap = document.createElement('span');
    wrap.className = 'nav-emblem';
    wrap.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    var leaf = document.createElementNS(SVG_NS, 'path');
    leaf.setAttribute('d', 'M12 3C8 8 5 11 5 15a7 7 0 0014 0c0-4-3-7-7-12z');
    leaf.setAttribute('fill', 'var(--accent-contrast)');
    var vein = document.createElementNS(SVG_NS, 'path');
    vein.setAttribute('d', 'M12 9v9');
    vein.setAttribute('stroke', 'var(--accent)');
    vein.setAttribute('stroke-width', '1.4');
    vein.setAttribute('stroke-linecap', 'round');
    svg.appendChild(leaf);
    svg.appendChild(vein);
    wrap.appendChild(svg);
    return wrap;
  }

  // Owner request 2026-07-06: match Mugi's reference mockup's TWO-tier header
  // — a big brand block (badge + title + tagline + icon actions) sitting
  // above a separate pill-shaped nav bar — instead of the one combined row
  // this used to build. Split into buildBrandHeader() (the big block) and
  // buildNav() (now just the pill bar of section links). Personal-only:
  // no "Team" tab, no mascot illustration — those are business-mockup extras,
  // out of scope here.

  // Build the big top block: logo badge + "AutoReceipt Dashboard" title +
  // tagline, plus 3 icon actions (settings shortcut, theme toggle, refresh).
  // onSettings/onToggleTheme/onRefresh are called on their respective button
  // clicks. Returns { el } or null outside a browser.
  function buildBrandHeader(opts) {
    if (typeof document === 'undefined') return null;
    opts = opts || {};
    var onSettings = typeof opts.onSettings === 'function' ? opts.onSettings : function () {};
    var onToggleTheme = typeof opts.onToggleTheme === 'function' ? opts.onToggleTheme : function () {};
    var onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : function () {};

    var top = document.createElement('div');
    top.className = 'app-header-top';

    var brand = document.createElement('div');
    brand.className = 'brand';
    var badge = document.createElement('div');
    badge.className = 'emblem';
    badge.setAttribute('aria-hidden', 'true');
    var emblem = buildEmblem();
    if (emblem) badge.appendChild(emblem);
    brand.appendChild(badge);

    var titleWrap = document.createElement('div');
    var h1 = document.createElement('h1');
    h1.className = 'brand-title';
    h1.textContent = 'AutoReceipt Dashboard (Personal)';
    var sub = document.createElement('div');
    sub.className = 'brand-sub';
    sub.textContent = 'snap a receipt · auto-extract · auto-categorize';
    titleWrap.appendChild(h1);
    titleWrap.appendChild(sub);
    brand.appendChild(titleWrap);
    top.appendChild(brand);

    var actions = document.createElement('div');
    actions.className = 'header-actions';

    var settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'icon-btn';
    settingsBtn.title = 'Settings';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', function () { onSettings(); });
    actions.appendChild(settingsBtn);

    var themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'icon-btn';
    themeBtn.title = 'Toggle dark/light theme';
    themeBtn.setAttribute('aria-label', 'Toggle dark/light theme');
    themeBtn.textContent = '☾';
    themeBtn.addEventListener('click', function () { onToggleTheme(); });
    actions.appendChild(themeBtn);

    var refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'icon-btn';
    refreshBtn.title = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', function () { onRefresh(); });
    actions.appendChild(refreshBtn);

    top.appendChild(actions);
    return { el: top, actionsEl: actions };
  }

  // Build the pill-shaped nav bar (just the section links now — brand/theme
  // moved to buildBrandHeader above). onSelect(id) fires when a section
  // button is clicked. Returns the <nav> element, or null outside a browser.
  function buildNav(opts) {
    if (typeof document === 'undefined') return null;
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};

    var nav = document.createElement('nav');
    nav.className = 'nav';

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

    // Mark the active button so app.js can reflect the current view.
    function setActive(id) {
      SECTIONS.forEach(function (s) {
        if (buttons[s.id]) buttons[s.id].classList.toggle('is-active', s.id === id);
      });
    }

    return { el: nav, setActive: setActive };
  }

  return { buildNav: buildNav, buildBrandHeader: buildBrandHeader, buildEmblem: buildEmblem, SECTIONS: SECTIONS };
});
