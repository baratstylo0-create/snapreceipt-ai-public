// app.js — the app-shell entrypoint. Wires config probe → auth gate → nav +
// view switching + theme toggle. Loaded last (after escape/api/render/authgate/
// nav) via a plain <script src>; no inline JS anywhere (strict CSP).
//
// Design notes:
//  - All /api/* calls go through Api.apiFetch so the bearer token is attached.
//  - The token lives in sessionStorage ONLY (cleared when the tab closes), never
//    localStorage, and is never logged.
//  - DOM is built with createElement/textContent/Escape.setText — no innerHTML
//    with any dynamic value.
//
// UMD-ish shim: exports the testable-ish helpers for Node require() (guarding
// browser-only globals so `node -e "require('./public/js/app.js')"` cannot throw),
// and auto-boots only in a real browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.App = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var TOKEN_KEY = 'dashboard_token';
  var THEME_KEY = 'theme';

  // Resolve dependencies from either CommonJS (Node) or the browser globals that
  // the earlier <script> tags attached. In Node these are only used by boot(),
  // which never runs there, so a missing global is harmless.
  function dep(name) {
    if (typeof module === 'object' && module.exports) {
      try {
        if (name === 'Escape') return require('./escape');
        if (name === 'Api') return require('./api');
        if (name === 'AuthGate') return require('./authgate');
        if (name === 'Nav') return require('./components/nav');
        if (name === 'Overview') return require('./components/overview');
        if (name === 'Activity') return require('./components/activity');
      } catch (e) { return null; }
    }
    return root && root[name] ? root[name] : null;
  }

  // --- session storage helpers (guarded — Node/private-mode safe) ---
  function ss() {
    try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (e) { return null; }
  }
  function getStoredToken() {
    var s = ss();
    try { return s ? s.getItem(TOKEN_KEY) : null; } catch (e) { return null; }
  }
  function storeToken(t) {
    var s = ss();
    try { if (s) s.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ }
  }

  // --- theme (visual only: toggle a class on <body>, persist the choice) ---
  function storedTheme() {
    var s = ss();
    try { return s ? s.getItem(THEME_KEY) : null; } catch (e) { return null; }
  }
  function applyTheme(theme) {
    if (typeof document === 'undefined' || !document.body) return;
    var light = theme === 'light';
    document.body.classList.toggle('theme-light', light);
    document.body.classList.toggle('theme-dark', !light);
  }
  function toggleTheme() {
    var next = (storedTheme() === 'light') ? 'dark' : 'light';
    var s = ss();
    try { if (s) s.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    return next;
  }

  // --- view switching: show one mount section, hide the rest ---
  function showView(id) {
    if (typeof document === 'undefined') return;
    var views = document.querySelectorAll('[data-view-section]');
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      v.hidden = (v.getAttribute('data-view-section') !== id);
    }
  }

  // Build the per-section panels inside #app. A section whose id has a registered
  // view component (see viewComponents) gets that component mounted; the rest get
  // a static "Coming soon." placeholder. Returns a map of id -> view instance
  // (those exposing load()) so the switcher can lazy-load data on first show.
  function buildViews(Nav, mount, deps) {
    var sections = (Nav && Nav.SECTIONS) || [];
    var components = viewComponents(deps);
    var instances = {};
    sections.forEach(function (s) {
      var sec = document.createElement('section');
      sec.className = 'view';
      sec.setAttribute('data-view-section', s.id);
      var h = document.createElement('h2');
      h.className = 'view-title';
      h.textContent = s.label;
      sec.appendChild(h);

      var comp = components[s.id];
      if (comp && typeof comp.mount === 'function') {
        var inst = comp.mount(sec, deps);
        if (inst) instances[s.id] = inst;
      } else {
        var p = document.createElement('p');
        p.className = 'view-placeholder muted';
        p.textContent = 'Coming soon.';
        sec.appendChild(p);
      }
      mount.appendChild(sec);
    });
    return instances;
  }

  // Registry mapping a section id to its view component module. Each component
  // exposes mount(section, deps) -> { load? }. Add future views here.
  function viewComponents(deps) {
    return {
      overview: (deps && deps.Overview) || dep('Overview'),
      activity: (deps && deps.Activity) || dep('Activity'),
    };
  }

  // Render the token-entry gate. On submit: normalise, store in sessionStorage,
  // wire Api, and enter the app. Blocks the app until a token is provided.
  function renderTokenGate(deps, onEntered) {
    var Escape = deps.Escape, Api = deps.Api, AuthGate = deps.AuthGate;
    var mount = document.getElementById('app');
    if (!mount) return;
    mount.textContent = '';

    var form = document.createElement('form');
    form.className = 'token-gate';

    var label = document.createElement('label');
    label.className = 'token-gate-label';
    label.setAttribute('for', 'token-input');
    Escape.setText(label, 'Enter dashboard access token');

    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'token-input';
    input.className = 'token-gate-input';
    input.setAttribute('autocomplete', 'off');

    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'token-gate-submit';
    submit.textContent = 'Enter';

    var msg = document.createElement('p');
    msg.className = 'token-gate-msg muted';

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(submit);
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var tok = AuthGate.normaliseToken(input.value);
      if (!tok) { Escape.setText(msg, 'Please enter a token.'); return; }
      storeToken(tok);
      Api.setToken(tok);              // never logged
      mount.textContent = '';
      onEntered();
    });

    mount.appendChild(form);
    input.focus();
  }

  // Enter the app proper: build nav + views, wire switching + theme.
  function enterApp(deps) {
    var Nav = deps.Nav;
    var header = document.getElementById('app-header');
    var mount = document.getElementById('app');
    if (mount) mount.textContent = '';

    var nav = Nav.buildNav({ onSelect: select, onToggleTheme: toggleTheme });
    if (header && nav) { header.textContent = ''; header.appendChild(nav.el); }

    var instances = mount ? buildViews(Nav, mount, deps) : {};

    function select(id) {
      showView(id);
      if (nav && nav.setActive) nav.setActive(id);
      // Lazy-load a view's data the first time it becomes visible.
      var inst = instances[id];
      if (inst && typeof inst.load === 'function') inst.load();
    }

    var first = (Nav.SECTIONS && Nav.SECTIONS[0] && Nav.SECTIONS[0].id) || 'overview';
    select(first);
  }

  // Boot sequence: apply persisted theme, probe /api/config, run the gate.
  function boot() {
    if (typeof document === 'undefined') return;
    var deps = {
      Escape: dep('Escape'), Api: dep('Api'), AuthGate: dep('AuthGate'), Nav: dep('Nav'),
      Overview: dep('Overview'), Activity: dep('Activity'),
    };
    if (!deps.Escape || !deps.Api || !deps.AuthGate || !deps.Nav) return;

    applyTheme(storedTheme() === 'light' ? 'light' : 'dark');

    // Attach any already-stored token to Api up front so config carries it too.
    var stored = getStoredToken();
    if (stored) deps.Api.setToken(stored);

    deps.Api.apiFetch('/api/config').then(function (cfg) {
      var decision = deps.AuthGate.authState({
        authRequired: cfg && cfg.auth_required,
        storedToken: getStoredToken(),
      });
      if (decision === 'prompt') {
        renderTokenGate(deps, function () { enterApp(deps); });
      } else {
        enterApp(deps);
      }
    }).catch(function () {
      // Server down / config unreachable: friendly message, never a stack.
      var mount = document.getElementById('app');
      if (mount && deps.Escape) {
        mount.textContent = '';
        var p = document.createElement('p');
        p.className = 'app-error';
        deps.Escape.setText(p, 'Could not reach the server. Please try again shortly.');
        mount.appendChild(p);
      }
    });
  }

  // Auto-boot only in a real browser (DOM present). Node require() must not boot.
  if (typeof document !== 'undefined' && root && root.addEventListener) {
    if (document.readyState === 'loading') {
      root.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  return {
    boot: boot,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    getStoredToken: getStoredToken,
    showView: showView,
  };
});
