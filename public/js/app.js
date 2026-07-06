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
  var AUTO_MODE_KEY = 'auto_mode';

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
        if (name === 'Upload') return require('./components/upload');
        if (name === 'Templates') return require('./components/templates');
        if (name === 'Reports') return require('./components/reports');
        if (name === 'Agent') return require('./components/agent');
        if (name === 'Settings') return require('./components/settings');
        if (name === 'Falc') return require('./components/falc');
        if (name === 'RateMeter') return require('./components/ratemeter');
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
    setTheme(next);
    return next;
  }
  // Set an explicit theme (used by the Settings view's Light/Dark picker).
  // Persists to sessionStorage and applies immediately.
  function setTheme(theme) {
    var next = theme === 'dark' ? 'dark' : 'light';
    var s = ss();
    try { if (s) s.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    return next;
  }

  // --- agent auto-mode (ADR-019: skip confirmation for edits & review decisions) ---
  // Persisted state only — unlike theme, there's nothing to "apply" to the DOM;
  // Falc/Agent re-read the current value fresh on every message submit via
  // getAutoMode (see enterApp below), so a Settings toggle flip takes effect on
  // the very next request with no remount/reload needed.
  function storedAutoMode() {
    var s = ss();
    try {
      var raw = s ? s.getItem(AUTO_MODE_KEY) : null;
      return raw === 'true';
    } catch (e) { return false; }
  }
  // Coerce to a strict boolean, persist (best-effort, never throws), and return it.
  function setAutoMode(value) {
    var next = !!value;
    var s = ss();
    try { if (s) s.setItem(AUTO_MODE_KEY, next ? 'true' : 'false'); } catch (e) { /* ignore */ }
    return next;
  }

  // Clear the dashboard token from this browser and re-run the boot flow, which
  // re-shows the token gate when auth is required. Never logs the token.
  function logout() {
    var s = ss();
    try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    try { var api = dep('Api'); if (api && api.setToken) api.setToken(null); } catch (e) { /* ignore */ }
    reloadPage();
  }
  // Best-effort full reload (guarded so Node require() can't throw).
  function reloadPage() {
    try { if (root && root.location && typeof root.location.reload === 'function') root.location.reload(); } catch (e) { /* ignore */ }
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
  // NB (Phase 2): 'agent' is no longer a nav view — the Agent chat now lives in
  // the floating Falc assistant (mounted globally in enterApp), and a Settings
  // view takes the freed nav slot.
  function viewComponents(deps) {
    return {
      overview: (deps && deps.Overview) || dep('Overview'),
      activity: (deps && deps.Activity) || dep('Activity'),
      upload: (deps && deps.Upload) || dep('Upload'),
      manage: (deps && deps.Templates) || dep('Templates'),
      reports: (deps && deps.Reports) || dep('Reports'),
      settings: (deps && deps.Settings) || dep('Settings'),
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

    // QA report #1: after a dashboard upload, the user had no way to jump to what was
    // just saved. `select` (below) is the real switcher (updates the nav pill + lazy-
    // loads the target view's data) — shared with every mounted view via `deps` so e.g.
    // Upload's "View in Activity" button can call deps.switchView('activity').
    deps.switchView = select;

    // Rate-limit "% used" meter — a header chip that reads Barat's RateLimit-* trip
    // (via Api.onRateLimit) and warns near the edge. Hidden until the first limited
    // response arrives. Optional (older cached bundles may lack it) so it never blocks boot.
    var RateMeter = deps.RateMeter;
    if (header && RateMeter && typeof RateMeter.mount === 'function') RateMeter.mount(header, deps);

    // Expose the real theme setter / logout / clear-local to view components
    // (the Settings view uses these) via the shared deps object.
    deps.setTheme = setTheme;
    deps.logout = logout;
    deps.onClearLocal = reloadPage;
    deps.autoMode = storedAutoMode();
    deps.setAutoMode = setAutoMode;

    var instances = mount ? buildViews(Nav, mount, deps) : {};

    // Falc — the floating expense assistant (Phase 2). Mounted once, globally,
    // so it floats over every view. It reuses the Agent chat module internally.
    // Optional (older cached bundles may lack it) so it never blocks boot.
    var Falc = deps.Falc;
    if (Falc && typeof Falc.mount === 'function') {
      Falc.mount({
        Agent: deps.Agent, Api: deps.Api, apiFetch: deps.Api && deps.Api.apiFetch,
        // Pass the FUNCTION itself (not a snapshotted call) so every fresh
        // Agent.mount() readAutoMode() picks up the current persisted value —
        // a Settings toggle flip is visible on the very next request, no
        // remount/reload needed (ADR-019).
        getAutoMode: storedAutoMode,
      });
    }

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
      Overview: dep('Overview'), Activity: dep('Activity'), Upload: dep('Upload'),
      Templates: dep('Templates'), Reports: dep('Reports'), Agent: dep('Agent'),
      Settings: dep('Settings'), Falc: dep('Falc'),
      RateMeter: dep('RateMeter'),
    };
    if (!deps.Escape || !deps.Api || !deps.AuthGate || !deps.Nav) return;

    applyTheme(storedTheme() === 'dark' ? 'dark' : 'light');

    // Attach any already-stored token to Api up front so config carries it too.
    var stored = getStoredToken();
    if (stored) deps.Api.setToken(stored);

    deps.Api.apiFetch('/api/config').then(function (cfg) {
      // Share the already-fetched config (incl. `categories`) with mounted view
      // components — e.g. activity.js's category dropdowns/pill colours — so
      // they don't issue a second, redundant /api/config call at boot.
      deps.config = cfg;
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
    storedAutoMode: storedAutoMode,
    setAutoMode: setAutoMode,
  };
});
