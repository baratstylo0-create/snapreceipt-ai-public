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
  var DEFAULT_VIEW_KEY = 'default_view';
  var SESSION_KEY = 'session_info'; // ADR-021 Phase 6: { role, branch_id, display_name } — identity only, NEVER the token
  var AUTH_EXPIRED_KEY = 'auth_expired_notice'; // one-shot flag: set before the reload in handleAuthExpired, read+cleared in boot()
  var CONFIG_CACHE_KEY = 'cached_config'; // instant-render: store last /api/config so returning users skip the wait

  // Resolve dependencies from either CommonJS (Node) or the browser globals that
  // the earlier <script> tags attached. In Node these are only used by boot(),
  // which never runs there, so a missing global is harmless.
  function dep(name) {
    if (typeof module === 'object' && module.exports) {
      try {
        if (name === 'Escape') return require('./escape');
        if (name === 'I18n') return require('./i18n');
        if (name === 'Api') return require('./api');
        if (name === 'Render') return require('./render');
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
        if (name === 'Login') return require('./components/login');
        if (name === 'Payments') return require('./components/payments');
        if (name === 'Grid') return require('./components/grid');
        if (name === 'Team') return require('./components/team');
        if (name === 'Manage') return require('./components/manage');
        if (name === 'Landing') return require('./components/landing');
        if (name === 'ResetPassword') return require('./components/resetpassword');
        if (name === 'EmailVerify') return require('./components/emailverify');
        if (name === 'Tour') return require('./components/tour');
      } catch (e) { return null; }
    }
    return root && root[name] ? root[name] : null;
  }

  // --- session storage helpers (guarded — Node/private-mode safe) ---
  function ss() {
    try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (e) { return null; }
  }
  // localStorage counterpart — used ONLY for a "remember me" personal (personalAuth)
  // login (see storeToken's `persistent` param below). sessionStorage is cleared the
  // moment a tab/renderer goes away, which Windows Chrome does surprisingly often for a
  // background/minimized tab (memory-saver tab discard, or a full Chrome relaunch after
  // an update/OS reclaim) — none of those are a real "close" from the user's point of
  // view, but they all wiped the sessionStorage-only token and forced a full re-login
  // (bug reported 2026-08-14: "minimize Chrome, reopen it, logged out"). localStorage
  // survives all of those, at the cost of the token outliving the tab — acceptable for a
  // single-user personal account (already gated by the user's own Google login), NOT
  // used for the shared static DASHBOARD_TOKEN box or business (multiUser)/guest logins,
  // which keep the original sessionStorage-only, shared-computer-safe behavior.
  function ls() {
    try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; }
  }
  function getStoredToken() {
    var l = ls();
    try { var fromLocal = l ? l.getItem(TOKEN_KEY) : null; if (fromLocal) return fromLocal; } catch (e) { /* ignore */ }
    var s = ss();
    try { return s ? s.getItem(TOKEN_KEY) : null; } catch (e) { return null; }
  }
  function storeToken(t, persistent) {
    var s = ss(), l = ls();
    if (persistent) {
      try { if (l) l.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ }
      try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } // avoid a stale sessionStorage copy
    } else {
      try { if (s) s.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ }
      try { if (l) l.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } // avoid a stale localStorage copy
    }
  }

  // --- business session identity (ADR-021 Phase 6) ---
  // The identity ({ role, branch_id, display_name }) is stored SEPARATELY from the
  // token so a page refresh keeps the role-aware shell without re-login. It is
  // identity metadata only — authorization always happens server-side per request
  // (a tampered role here changes labels, never data access). Mirrors storeToken's
  // localStorage/sessionStorage split so a persistent personal login also keeps its
  // role-aware shell across a full browser restart.
  function getStoredSession() {
    var l = ls();
    try { var fromLocal = l ? l.getItem(SESSION_KEY) : null; if (fromLocal) { var pl = JSON.parse(fromLocal); if (pl && typeof pl === 'object') return pl; } } catch (e) { /* ignore */ }
    var s = ss();
    try {
      var raw = s ? s.getItem(SESSION_KEY) : null;
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) { return null; }
  }
  // isBusinessSession(session) -> true only for a REAL business (admin/clerk) session.
  // 2026-07-25: personal-mode signup means a session can now ALSO mean 'owner' (a personal
  // account), which must NOT trigger business-only UI (Team/Payments tabs, the business
  // brand header, petty-cash grid chrome — see components/grid.js's own role!=='owner'
  // guard). Every call site that used to test bare `!!session` as a business proxy must use
  // this helper instead — kept in ONE place so a future new call site can't miss the guard.
  // 2026-07-28 (Guest Mode): 'guest' is a SECOND single-user, non-business role (lib/auth.js's
  // scopeForUser) — without this, `role !== 'owner'` alone would evaluate true for a guest and
  // incorrectly show business Team/Payments chrome to a trial user. An allow-list of the real
  // business roles (admin/clerk) is used instead of a deny-list, so a future third role can't
  // silently fall on the wrong side of this check the way 'guest' would have.
  function isBusinessSession(session) { return !!(session && (session.role === 'admin' || session.role === 'clerk')); }

  function storeSession(sess, persistent) {
    var s = ss(), l = ls();
    var store = persistent ? l : s;
    var other = persistent ? s : l;
    try { if (other) other.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } // avoid a stale copy in the other store
    try {
      if (!store) return;
      if (sess) store.setItem(SESSION_KEY, JSON.stringify({
        role: sess.role || '', branch_id: sess.branch_id || null, display_name: sess.display_name || '',
      }));
      else store.removeItem(SESSION_KEY);
    } catch (e) { /* ignore */ }
  }

  // --- config cache (instant-render for returning users) ---
  function getCachedConfig() {
    var l = ls();
    try {
      var raw = l ? l.getItem(CONFIG_CACHE_KEY) : null;
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) { return null; }
  }
  function cacheConfig(cfg) {
    var l = ls();
    try { if (l && cfg) l.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function clearCachedConfig() {
    var l = ls();
    try { if (l) l.removeItem(CONFIG_CACHE_KEY); } catch (e) { /* ignore */ }
  }

  // --- theme (visual only: toggle a class on <body>, persist the choice) ---
  // Owner request 2026-07-07: a 3rd "Warm" theme alongside Light/Dark (the
  // sepia-toned body.theme-warm CSS block). "Ocean" (2026-07-27): a blue/white
  // palette — the existing Light/Warm/Dark theme blocks (shared with the
  // business dashboard) are completely untouched, so this carries zero risk to
  // Premala's look.
  //
  // 2026-07-27 (Barat: "only dark mode and light mode, remove other modes"):
  // personal accounts now cycle/pick between just TWO options — 'ocean' (shown
  // to them as "Light", matching Landing/Login/Onboarding's blue/white identity)
  // and 'ocean-dark'. 'warm' and a separate moss-green 'light'/'dark' are dropped
  // from the personal UI entirely. Business (multiUser) is UNCHANGED — same three
  // options as before Ocean ever existed (light/warm/dark) — this file is shared
  // with the live Premala dashboard, which never asked for any of this.
  //
  // Follow-up, same day (Barat: "dark mode must be based on light theme colour"):
  // personal's dark option is 'ocean-dark' — a dark NAVY variant of Ocean (see
  // app.css's body.theme-ocean-dark) — NOT the green-based theme-dark block,
  // which was tuned to pair with the old moss-green light theme and stays
  // exactly as-is for business.
  //
  // ALL_THEMES stays the full validity list (any of the 5 CSS-class-backed
  // values is a legal thing to apply) — the CYCLE lists below are just which
  // subset a given deployment's UI offers/steps through.
  var ALL_THEMES = ['light', 'warm', 'dark', 'ocean', 'ocean-dark'];
  var PERSONAL_THEME_CYCLE = ['ocean', 'ocean-dark'];
  var BUSINESS_THEME_CYCLE = ['light', 'warm', 'dark'];
  function themeCycleFor(personalAuth) { return personalAuth ? PERSONAL_THEME_CYCLE : BUSINESS_THEME_CYCLE; }
  function storedTheme() {
    var s = ss();
    try { return s ? s.getItem(THEME_KEY) : null; } catch (e) { return null; }
  }
  function applyTheme(theme) {
    if (typeof document === 'undefined' || !document.body) return;
    var t = ALL_THEMES.indexOf(theme) !== -1 ? theme : 'light';
    document.body.classList.toggle('theme-light', t === 'light');
    document.body.classList.toggle('theme-warm', t === 'warm');
    document.body.classList.toggle('theme-dark', t === 'dark');
    document.body.classList.toggle('theme-ocean', t === 'ocean');
    document.body.classList.toggle('theme-ocean-dark', t === 'ocean-dark');
  }
  // Set an explicit theme (used by the Settings view's theme picker).
  // Persists to sessionStorage and applies immediately.
  function setTheme(theme) {
    var next = ALL_THEMES.indexOf(theme) !== -1 ? theme : 'light';
    var s = ss();
    try { if (s) s.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    return next;
  }
  // Header icon: cycles through themeCycleFor(personalAuth). No stored value yet
  // means the visual baseline is that cycle's first entry, so an unrecognised/
  // missing stored value is treated as index 0 BEFORE advancing -- not as "the
  // answer" -- otherwise the very first click would silently no-op instead of
  // moving to the next option.
  // Default page (Settings' "which page opens when you launch the dashboard
  // fresh" picker). Same sessionStorage convention as theme/auto-mode (never
  // localStorage — matches the file's own token-storage rule above). Validated
  // against the CURRENT section list at read time in enterApp, since a stored
  // id from a personal-mode session (e.g. 'team') would be meaningless/absent
  // if that same browser later opens a personal-only instance.
  function storedDefaultView() {
    var s = ss();
    try { return s ? s.getItem(DEFAULT_VIEW_KEY) : null; } catch (e) { return null; }
  }
  function setDefaultView(id) {
    var s = ss();
    try { if (s) s.setItem(DEFAULT_VIEW_KEY, String(id || '')); } catch (e) { /* ignore */ }
  }

  function toggleTheme(personalAuth) {
    var cycle = themeCycleFor(personalAuth);
    var idx = cycle.indexOf(storedTheme());
    var next = cycle[((idx === -1 ? 0 : idx) + 1) % cycle.length];
    setTheme(next);
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
  // re-shows the token gate (or the business login) when auth is required. Never
  // logs the token. Business mode (a stored session identity exists): best-effort
  // POST /api/logout FIRST so the server revokes every session for this user —
  // clearing only the browser copy would leave a live token server-side.
  function logout() {
    var finish = function () {
      var s = ss(), l = ls();
      try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
      try { if (l) l.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } // clear the persistent copy too (personal "remember me")
      storeSession(null);
      clearCachedConfig();
      try { var api = dep('Api'); if (api && api.setToken) api.setToken(null); } catch (e) { /* ignore */ }
      reloadPage();
    };
    if (getStoredSession()) {
      try {
        var api = dep('Api');
        if (api && api.apiFetch) { api.apiFetch('/api/logout', { method: 'POST' }).then(finish, finish); return; }
      } catch (e) { /* fall through */ }
    }
    finish();
  }
  // Best-effort full reload (guarded so Node require() can't throw).
  function reloadPage() {
    try { if (root && root.location && typeof root.location.reload === 'function') root.location.reload(); } catch (e) { /* ignore */ }
  }

  // Bug fix (2026-08-19, Barat: "screen popup like this when I wait for see the
  // dashboard after logging in" — a screenshot of the bare header+footer shell with
  // NOTHING in between): #app starts completely empty in index.html and stays that
  // way for as long as boot()'s /api/config call (and, for a returning Google
  // sign-in, enterApp()'s SECOND back-to-back config re-fetch) takes to resolve —
  // there was never any visible sign that something was happening. On a slow
  // connection that gap reads as a broken/frozen app, not a loading one. Fixes:
  // (1) an immediate, synchronous "Loading…" placeholder the instant boot() starts,
  // before any network call — the very first thing painted. (2) withTimeout below,
  // wrapped around both boot-time config fetches, so a hung/never-resolving request
  // (rare, but `fetch()` has no built-in timeout) surfaces a real "try again"
  // message instead of leaving the placeholder up forever with no way out.
  function showBootLoading(deps) {
    if (typeof document === 'undefined') return;
    var mount = document.getElementById('app');
    if (!mount) return;
    mount.textContent = '';
    var p = document.createElement('p');
    p.className = 'app-boot-loading muted';
    p.textContent = (deps && deps.t) ? deps.t('app.boot_loading') : 'Loading your dashboard…';
    mount.appendChild(p);
  }

  // withTimeout(promise, ms) -> a promise that rejects with a plain Error if
  // `promise` hasn't settled within `ms`. The original promise is never cancelled
  // (fetch() has no reliable cross-browser abort story worth the added risk here) —
  // this only stops the CALLER waiting forever; a very late response is simply
  // ignored. Never throws synchronously.
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('timeout'));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // Shown when the boot-time config fetch times out or fails outright (server
  // unreachable) — a real "try again" button, never a permanent blank screen.
  function showBootError(deps, messageKey) {
    if (typeof document === 'undefined') return;
    var mount = document.getElementById('app');
    if (!mount) return;
    mount.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'app-boot-error';
    var p = document.createElement('p');
    p.className = 'app-error';
    p.textContent = (deps && deps.t) ? deps.t(messageKey) : 'Could not reach the server. Please try again shortly.';
    wrap.appendChild(p);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-boot-retry';
    btn.textContent = (deps && deps.t) ? deps.t('app.boot_retry') : 'Try again';
    btn.addEventListener('click', reloadPage);
    wrap.appendChild(btn);
    mount.appendChild(wrap);
  }

  // Live incident, 2026-07-11: the Owner's session hit its 12h TTL and EVERY panel
  // (Overview/Activity/review queue) failed identically with a dead-end "could not
  // load, please try again shortly" — no indication that logging in again was the fix.
  // Only a manual logout+login recovered it. Api.onAuthExpired (api.js) notifies here
  // the first time any call gets a real 401 (a token was attached and rejected), so the
  // WHOLE app reacts once instead of every view quietly failing its own way: clear the
  // dead token/session (mirrors logout()'s own cleanup, minus the /api/logout call —
  // that request would just 401 again since the session is already gone) and reload.
  // AUTH_EXPIRED_KEY survives the reload so boot() can show a clear "log in again"
  // message instead of a blank gate. Guarded to fire once — multiple panels can all
  // 401 around the same moment and would otherwise race to reload repeatedly.
  var authExpiredHandled = false;
  function handleAuthExpired() {
    if (authExpiredHandled) return;
    authExpiredHandled = true;
    var s = ss(), l = ls();
    try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    try { if (l) l.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } // clear the persistent copy too (personal "remember me")
    storeSession(null);
    clearCachedConfig();
    try { var api = dep('Api'); if (api && api.setToken) api.setToken(null); } catch (e) { /* ignore */ }
    try { if (s) s.setItem(AUTH_EXPIRED_KEY, '1'); } catch (e) { /* ignore */ }
    reloadPage();
  }

  // Owner request 2026-07-06: a small "what is this page for" hint on every
  // page, so a non-technical user always has a one-line explanation on hand
  // without having to ask. Plain, static strings (never user input), so a
  // direct .textContent assignment is safe — same convention this file
  // already uses for s.label below.
  // Personal-mode entries route through deps.t (i18n.js); business-only entries
  // (team/payments, ADR-021 Phase 6/8, only ever shown via Nav.sectionsFor(business))
  // stay hardcoded English — out of scope for this i18n pass (M2/business files).
  function viewInfoFor(deps) {
    var t = deps.t || function (k) { return k; };
    return {
      overview: t('view_info.overview'),
      activity: t('view_info.activity'),
      upload: t('view_info.upload'),
      manage: t('view_info.manage'),
      settings: t('view_info.settings'),
      team: 'Manage your branches and each branch’s staff directory. Admins can also add branches and companies.',
      payments: 'Track which expenses are pending vs paid. Admins can select several and mark them paid at once.',
    };
  }

  // The "i" button + popup logic itself now lives in Render.buildInfoIcon
  // (shared with components that want the same per-section explainer, e.g.
  // Templates' visual field builder) — this map just supplies the per-page text.

  // --- view switching: show one mount section, hide the rest ---
  // Bug fix (2026-08-19, Barat: "the row reset still not work"): buildViews() mounts
  // every section's DOM ONCE per app session (renderApp), then showView() only ever
  // toggles `hidden` on the same persistent nodes — it never rebuilds anything. So a
  // Settings collapsible you clicked open stays open in the DOM (just hidden, not
  // destroyed) and is still open the next time you come back, no matter what
  // collapsible()'s own defaultOpen says — that only ever ran once, at first mount.
  // The earlier "always start closed" fix (settings.js's defaultOpen=false + removing
  // sessionStorage persistence) addressed a DIFFERENT, non-existent bug (this app has
  // no cross-session memory to begin with) and left the real cause untouched. Fixed
  // here instead, generically: whenever the Settings panel is the one being HIDDEN
  // (i.e. the user is navigating away from it), snap every one of its collapsibles
  // back to closed right then — so by the time showView('settings') is called again,
  // they're already closed, matching "go another page -> comes back closed" exactly.
  function showView(id) {
    if (typeof document === 'undefined') return;
    var views = document.querySelectorAll('[data-view-section]');
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var willHide = (v.getAttribute('data-view-section') !== id);
      if (willHide && !v.hidden && v.getAttribute('data-view-section') === 'settings') {
        var openSections = v.querySelectorAll('.collapsible.is-open');
        for (var j = 0; j < openSections.length; j++) openSections[j].classList.remove('is-open');
      }
      v.hidden = willHide;
    }
  }

  // Build the per-section panels inside #app. A section whose id has a registered
  // view component (see viewComponents) gets that component mounted; the rest get
  // a static "Coming soon." placeholder. Returns a map of id -> view instance
  // (those exposing load()) so the switcher can lazy-load data on first show.
  // `sections` is the SAME list enterApp already computed for Nav.buildNav (single
  // source of truth — see enterApp) so the nav buttons and the mounted panels can
  // never disagree about what's in business vs personal mode.
  function buildViews(sections, mount, deps) {
    sections = sections || [];
    var components = viewComponents(deps);
    var VIEW_INFO = viewInfoFor(deps);
    var instances = {};
    sections.forEach(function (s) {
      var sec = document.createElement('section');
      sec.className = 'view';
      sec.setAttribute('data-view-section', s.id);

      var headRow = document.createElement('div');
      headRow.className = 'view-title-row';
      var h = document.createElement('h2');
      h.className = 'view-title';
      h.textContent = s.label;
      headRow.appendChild(h);
      if (VIEW_INFO[s.id] && deps.Render) {
        var icon = deps.Render.buildInfoIcon(VIEW_INFO[s.id], 'What is this page for?');
        if (icon) headRow.appendChild(icon);
      }
      sec.appendChild(headRow);

      var comp = components[s.id];
      if (comp && typeof comp.mount === 'function') {
        var inst = comp.mount(sec, deps);
        if (inst) instances[s.id] = inst;
      } else {
        var p = document.createElement('p');
        p.className = 'view-placeholder muted';
        p.textContent = deps.t ? deps.t('app.coming_soon') : 'Coming soon.';
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
      // Manage is a shell hosting sub-pages (template/category editor + the excel-lite Data
      // editor) — it mounts Templates and Grid itself, reading deps.Templates/deps.Grid.
      manage: (deps && deps.Manage) || dep('Manage'),
      settings: (deps && deps.Settings) || dep('Settings'),
      // Business-only sections (ADR-021 Phase 6/8). Registered unconditionally — they
      // simply never appear in `sections` (buildViews) unless Nav.sectionsFor({business:true}) ran.
      team: (deps && deps.Team) || dep('Team'),
      payments: (deps && deps.Payments) || dep('Payments'),
    };
  }

  // Render the token-entry gate. On submit: normalise, store in sessionStorage,
  // wire Api, and enter the app. `onCancel` is OPTIONAL: at boot, when auth is
  // actually required, there is nowhere valid to cancel back to (the app can't
  // be entered without a token), so it's omitted and the gate blocks the app.
  // When opened from Settings' "Log in" on a dashboard that does NOT require a
  // token, there's nothing to wait for — `onCancel` (a "Cancel" button) lets the
  // user back out instead of being stuck on a token box they have no token for.
  // `initialMessage` is OPTIONAL — shown up front (e.g. "Your session expired.
  // Please log in again." after handleAuthExpired's reload) instead of the blank
  // message paragraph a plain boot leaves until the first submit attempt.
  function renderTokenGate(deps, onEntered, onCancel, initialMessage) {
    var Escape = deps.Escape, Api = deps.Api, AuthGate = deps.AuthGate;
    var t = deps.t || function (k) { return k; };
    var mount = document.getElementById('app');
    if (!mount) return;
    mount.textContent = '';

    var form = document.createElement('form');
    form.className = 'token-gate';

    var label = document.createElement('label');
    label.className = 'token-gate-label';
    label.setAttribute('for', 'token-input');
    Escape.setText(label, t('app.token_gate_label'));

    var input = document.createElement('input');
    input.type = 'password';
    input.id = 'token-input';
    input.className = 'token-gate-input';
    input.setAttribute('autocomplete', 'off');

    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'token-gate-submit';
    submit.textContent = t('app.token_gate_submit');

    var msg = document.createElement('p');
    msg.className = 'token-gate-msg muted';
    if (initialMessage) Escape.setText(msg, initialMessage);

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(submit);
    if (typeof onCancel === 'function') {
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'token-gate-cancel';
      cancel.textContent = t('app.token_gate_cancel');
      cancel.addEventListener('click', function () {
        mount.textContent = '';
        onCancel();
      });
      form.appendChild(cancel);
    }
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var tok = AuthGate.normaliseToken(input.value);
      if (!tok) { Escape.setText(msg, t('app.token_gate_missing')); return; }
      storeToken(tok);
      Api.setToken(tok);              // never logged
      mount.textContent = '';
      onEntered();
    });

    mount.appendChild(form);
    input.focus();
  }

  // Enter the app proper: build the brand header + nav + views, wire switching + theme.
  // enterApp(deps) — thin wrapper around renderApp(deps) (2026-08-09 fix). Every login/
  // signup/reconnect path stores the token then calls this BEFORE deps.config has ever
  // been fetched WITH that token — deps.config is still the one unauthenticated /api/config
  // response from boot() (account_info/plan_usage/telegram_connected always null there,
  // per routes/expenses.js's own owner-only gating). That made Settings' "Account settings"
  // panel (email/member-since/plan/Telegram row) permanently blank for a real signed-in
  // session, since it reads opts.config straight off this same stale object — a page reload
  // "fixed" it only because reload re-runs boot() with the token already stored. Refetching
  // here (now authenticated, since every call site stores the token first) fixes every entry
  // path in one place instead of patching each of the 9 enterApp() call sites individually.
  function enterApp(deps) {
    if (deps.Api && typeof deps.Api.apiFetch === 'function') {
      // Bounded (2026-08-19): this refetch already degrades gracefully to the stale
      // config on a normal failure, but a request that never resolves at all (rare,
      // fetch() has no built-in timeout) would otherwise leave the boot-loading
      // placeholder up forever with no way out — withTimeout caps the wait.
      withTimeout(deps.Api.apiFetch('/api/config'), 15000).then(function (freshCfg) {
        if (freshCfg) { deps.config = freshCfg; cacheConfig(freshCfg); }
      }).catch(function () {
        // Never block entering the app on this refresh — fall back to the stale
        // pre-login config (same behavior as before this fix existed).
      }).then(function () { renderApp(deps); });
    } else {
      renderApp(deps);
    }
  }

  function renderApp(deps) {
    // Defensive: strip the pre-login entry screens' body classes (landing-mode,
    // onboard-mode) no matter which path got us here, so the real dashboard theme
    // (Light/Warm/Dark/Ocean) is never seen through a leftover override.
    if (document.body) document.body.classList.remove('landing-mode', 'onboard-mode');
    var Nav = deps.Nav;
    var header = document.getElementById('app-header');
    var mount = document.getElementById('app');
    if (mount) mount.textContent = '';
    if (header) header.textContent = '';

    // Role-aware shell (ADR-021 Phase 6): the signed-in identity (business mode only)
    // is shared with every view via deps.session — views branch on session.role for
    // admin-vs-clerk affordances. Personal mode: null, everything renders as before.
    deps.session = getStoredSession();
    // Lets app.css scope dashboard-only layout tweaks (2026-07-27: wider content
    // width, "fit the page like a real SaaS app") to personal accounts without
    // touching the shared business (Premala) dashboard's layout at all.
    if (document.body) document.body.classList.toggle('personal-mode', !!(deps.config && deps.config.personal_auth));

    // The ONE section list for this boot — drives BOTH the nav buttons (buildNav below)
    // and the mounted view panels (buildViews below). Business mode (deps.session set)
    // inserts Payments/Ledger before Settings; personal mode is the classic SECTIONS,
    // byte-identical. Computed once so the two can never drift apart.
    // The excel-lite grid is no longer a top-level section — it's a sub-page of Manage
    // (components/manage.js), which reads config.excel_lite_grid itself. So the nav list no
    // longer depends on that flag; business mode just adds Team + Payments.
    var sections = Nav && Nav.sectionsFor
      ? Nav.sectionsFor({ business: isBusinessSession(deps.session) })
      : (Nav && Nav.SECTIONS) || [];

    // Owner request 2026-07-06: two-tier header (big brand block above the
    // pill nav), matching Mugi's reference mockup. Refresh re-loads the page
    // (simplest, safest "get me current data" action — mirrors a normal
    // browser refresh, no separate per-view refetch plumbing needed).
    var brandHeader = Nav.buildBrandHeader && Nav.buildBrandHeader({
      // Same signal `sections` above already uses — the nav and the header title
      // must never disagree about which mode this boot is in.
      business: isBusinessSession(deps.session),
      // Telegram bot link (2026-07-14): already-fetched /api/config carries the
      // bot's public @handle; no second round-trip needed. Same value for every
      // role (one bot per account) — Nav.buildBrandHeader omits the icon entirely
      // when this is blank (BOT_USERNAME not configured/auto-detected yet).
      botUsername: deps.config && deps.config.bot_username,
      personalAuth: !!(deps.config && deps.config.personal_auth),
      onSettings: function () { select('settings'); },
      // The Settings view is built once at boot and never re-rendered, so its
      // theme <select> (tagged .set-select--theme) would otherwise show a
      // stale value after this icon cycles the theme — keep it in sync here.
      onToggleTheme: function () {
        var next = toggleTheme(!!(deps.config && deps.config.personal_auth));
        var sels = document.querySelectorAll('.set-select--theme');
        for (var i = 0; i < sels.length; i++) sels[i].value = next;
        return next;
      },
      // Bug fix (2026-08-23, Barat QA report: "refresh make whole app refresh,
      // logout user account also") — the header ↻ used to call reloadPage()
      // (a hard location.reload()), which re-runs the ENTIRE boot flow and can
      // drop a Guest Mode session or land the user back on the login gate. It
      // should only refetch the current page's data. See refreshCurrentView()
      // below (re-invokes select() on whatever view is active — the same
      // inst.load() path a normal view switch already uses, no reload needed).
      onRefresh: refreshCurrentView,
      onFeedback: function () { openFeedbackModal(deps); },
    });
    if (header && brandHeader) header.appendChild(brandHeader.el);

    var nav = Nav.buildNav({ onSelect: select, sections: sections });
    if (header && nav) header.appendChild(nav.el);

    // Guest Mode (2026-07-28): a persistent, non-dismissible reminder across every view (not
    // scoped to one page — appended to the header, which persists across select() calls) —
    // per Barat's decision, the guest keeps browsing what they've already got even after the
    // cap hits, so this never disappears/blocks anything, it just never lets them forget.
    if (header && deps.session && deps.session.role === 'guest') header.appendChild(buildGuestBanner(deps));

    // Telegram connect reminder (2026-08-08): a persistent header banner for a real personal
    // owner whose Telegram isn't connected yet — mirrors buildGuestBanner's placement/pattern
    // above so it survives every select() call. account_info.telegram_connected comes from
    // /api/config (routes/expenses.js), so this is only ever true/false for a real owner
    // session (null for guest/business/signed-out — see routes/expenses.js's own gating).
    var acctInfo = deps.config && deps.config.account_info;
    if (header && deps.session && deps.session.role === 'owner' && acctInfo && acctInfo.telegram_connected === false) {
      header.appendChild(buildTelegramBanner(deps, acctInfo));
    }

    // Email-verification banner (2026-08-24, W-01, P-01 contract) — async unlike the two
    // banners above because /api/verify-email/status (contract §2: "the single source both
    // clients render their banner from") isn't part of /api/config, so it can't be decided
    // synchronously here. Best-effort like Falc/RateMeter: on ANY failure (the P-01 backend
    // not deployed yet, a network hiccup, an old cached bundle without deps.EmailVerify) this
    // silently shows nothing rather than breaking boot — the banner is a reminder, not a gate.
    // `header` is captured in this closure and still the live DOM node the promise resolves
    // against, exactly like buildTelegramBanner's own "survives every select() call" comment.
    if (header && deps.session && deps.session.role === 'owner' && acctInfo && acctInfo.email
      && deps.EmailVerify && typeof deps.EmailVerify.buildBanner === 'function'
      && deps.Api && typeof deps.Api.apiFetch === 'function') {
      deps.Api.apiFetch('/api/verify-email/status').then(function (status) {
        if (status && status.verification_required && !status.verified) {
          header.appendChild(deps.EmailVerify.buildBanner(deps, acctInfo.email));
        }
      }).catch(function () { /* endpoint not live yet, or a transient failure — stay silent */ });
    }

    // QA report #1: after a dashboard upload, the user had no way to jump to what was
    // just saved. `select` (below) is the real switcher (updates the nav pill + lazy-
    // loads the target view's data) — shared with every mounted view via `deps` so e.g.
    // Upload's "View in Activity" button can call deps.switchView('activity').
    deps.switchView = select;

    // Rate-limit "% used" meter — a header chip that reads Barat's RateLimit-* trip
    // (via Api.onRateLimit) and warns near the edge. Hidden until the first limited
    // response arrives. Optional (older cached bundles may lack it) so it never blocks boot.
    var RateMeter = deps.RateMeter;
    var rateMeterHost = (brandHeader && brandHeader.actionsEl) || header;
    if (rateMeterHost && RateMeter && typeof RateMeter.mount === 'function') RateMeter.mount(rateMeterHost, deps);

    // Business mode: a "who am I" chip + Sign out in the header actions. Built with
    // textContent (identity values are still untrusted display text). Personal mode
    // (no session) renders nothing — header unchanged.
    if (deps.session && rateMeterHost) {
      var who = document.createElement('span');
      who.className = 'session-chip';
      var roleLabel = deps.session.role === 'admin' ? 'Admin' : deps.session.role === 'clerk' ? 'Clerk' : '';
      who.textContent = (deps.session.display_name || 'Signed in') + (roleLabel ? ' · ' + roleLabel : '');
      rateMeterHost.appendChild(who);

      var out = document.createElement('button');
      out.type = 'button';
      out.className = 'icon-btn';
      out.title = 'Sign out';
      out.setAttribute('aria-label', 'Sign out');
      // 2026-07-27 (Barat: real logout icon, bigger) — a proper door+arrow glyph
      // instead of the '⎋' escape-key Unicode symbol, which read as an unrelated
      // "no entry" circle at small sizes. stroke="currentColor" so it still
      // inherits the button's themed text color automatically, exactly like the
      // old text glyph did — works unchanged across every theme, business included.
      out.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>'
        + '<polyline points="16 17 21 12 16 7"/>'
        + '<line x1="21" y1="12" x2="9" y2="12"/>'
        + '</svg>';
      out.addEventListener('click', function () { logout(); });
      rateMeterHost.appendChild(out);
    }

    // Expose the real theme setter / login / logout / clear-local to view
    // components (the Settings view uses these) via the shared deps object.
    deps.setTheme = setTheme;
    deps.lang = deps.I18n.lang();
    deps.setLang = deps.I18n.setLang;
    deps.logout = logout;
    // Default-page picker (Settings view): the CURRENT boot's section list (so the
    // picker only ever offers views that actually exist right now) + the stored
    // value + a setter.
    deps.sections = sections;
    deps.defaultView = storedDefaultView();
    deps.setDefaultView = setDefaultView;
    // Bug fix: Settings' "Log in" button used to call `logout()` unconditionally
    // (there was no separate login path at all) — harmless-looking but wrong: in
    // an open (no-token-required) dashboard, clearing an already-empty token and
    // reloading just reboots straight back to Overview, which reads as "Log in
    // does nothing but bounce me to Overview." `login()` shows the real
    // token-entry gate in place, without a full page reload.
    //
    // Bug fix (2026-07-27, Barat: "why pop up like this" — screenshot showed the
    // old static token box): this used to call renderTokenGate() UNCONDITIONALLY,
    // even for personalAuth/multiUser deployments where that box is supposed to
    // be retired entirely (see authgate.js's authState() doc comment — it must
    // never resurface once real accounts exist). Route to the SAME real gate
    // boot() itself would use for each mode; the static token box is now only
    // reachable for the plain legacy DASHBOARD_TOKEN deployment (neither flag set).
    deps.login = function () {
      var cfg = deps.config;
      if (cfg && cfg.personal_auth) {
        mountLogin(deps, undefined, { onRegister: function () { mountOnboarding(deps, cfg); } });
      } else if (cfg && cfg.multi_user) {
        mountLogin(deps);
      } else {
        renderTokenGate(deps, function () { enterApp(deps); }, function () { enterApp(deps); });
      }
    };
    deps.onClearLocal = reloadPage;
    deps.autoMode = storedAutoMode();
    deps.setAutoMode = setAutoMode;
    // Guided tour (Settings > About > "Take a Tour" calls this to restart it).
    var Tour = deps.Tour;
    deps.startTour = function () {
      if (Tour && typeof Tour.start === 'function') Tour.start(deps);
    };

    // Install as desktop/home-screen app (2026-08-25, Settings > About > "Install
    // App"). canInstallApp hides the row once already running installed (nothing
    // to install). installApp() shows the browser's real prompt if it fired
    // early enough to be captured (deferredInstallPrompt, set above); otherwise
    // resolves 'unavailable' so the button can point the user at the browser's
    // own install icon/menu instead of doing nothing.
    deps.canInstallApp = function () { return !isStandalone(); };
    deps.installApp = function () {
      if (!deferredInstallPrompt) return Promise.resolve('unavailable');
      var promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      promptEvent.prompt();
      return promptEvent.userChoice ? promptEvent.userChoice.then(function () {}) : Promise.resolve();
    };

    var instances = mount ? buildViews(sections, mount, deps) : {};

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

    var currentViewId = null;
    function select(id) {
      currentViewId = id;
      showView(id);
      if (nav && nav.setActive) nav.setActive(id);
      // Lazy-load a view's data the first time it becomes visible.
      var inst = instances[id];
      if (inst && typeof inst.load === 'function') inst.load();
    }

    // Refetches the CURRENT view's data via the same select()/inst.load() path a
    // normal nav click already uses — no page reload, no session loss. Replaces
    // the old reloadPage() behavior for the header refresh button specifically.
    function refreshCurrentView() {
      select(currentViewId || first);
    }

    // A stored default-view id only wins if it's actually in THIS boot's section
    // list (business vs personal, or a since-removed view) — otherwise fall back
    // to the first section, same as before this preference existed.
    var storedDefault = storedDefaultView();
    var validDefault = storedDefault && sections.some(function (s) { return s.id === storedDefault; });
    var first = (validDefault && storedDefault) || (sections[0] && sections[0].id) || 'overview';
    select(first);

    // First-time guided tour (2026-08-22): auto-shows once per browser, never again
    // once completed or skipped (Tour.isCompleted() reads the localStorage flag Tour
    // itself sets). Deferred a tick so the just-selected view has started rendering
    // before the tour tries to find its first target.
    if (Tour && typeof Tour.isCompleted === 'function' && !Tour.isCompleted()) {
      setTimeout(function () { deps.startTour(); }, 300);
    }
  }

  // --- personalAuth entry screens (2026-07-27) — factored out so Landing's
  // onLogin/onRegister callbacks can reach the exact same code paths as a direct
  // 'login'/'signup' AuthGate decision, with zero duplication. ---
  function mountLogin(deps, expiredNotice, opts) {
    // 'landing-mode' (Landing's dark navbar chrome) never belongs here. 'onboard-mode'
    // (the blue/white card look) is opt-in via opts.onRegister — see login.js's render()
    // doc comment: the direct business (multiUser) AuthGate 'login' decision passes no
    // opts, so it stays byte-identical to before this change.
    if (document.body) {
      document.body.classList.remove('landing-mode');
      document.body.classList.toggle('onboard-mode', !!(opts && opts.onRegister));
    }
    var mount = document.getElementById('app');
    // Persistent (localStorage) only for a personal account's own username/password
    // login — business (multiUser) logins on a shared computer keep the original
    // sessionStorage-only, tab-lifetime behavior unchanged (2026-08-14 fix).
    var personalLogin = !!(deps.config && deps.config.personal_auth);
    deps.storeToken = function (t) { storeToken(t, personalLogin); };
    deps.Login && deps.Login.render(mount, deps, function (session) {
      storeSession(session, personalLogin);
      enterApp(deps);
    }, expiredNotice, opts);
  }

  function mountOnboarding(deps, cfg) {
    if (document.body) document.body.classList.remove('landing-mode');
    var onboardMount = document.getElementById('app');
    if (onboardMount) onboardMount.textContent = '';
    deps.Onboarding && deps.Onboarding.mount(onboardMount, {
      botUsername: cfg && cfg.bot_username,
      Api: deps.Api,
      onSignup: function (email, password) {
        return deps.Api.apiFetch('/api/signup', { method: 'POST', body: { email: email, password: password } })
          .then(function (r) {
            // Mirrors the business Login path exactly: store the token + identity, wire
            // Api, so the rest of the app (checkDash-gated calls) works unchanged. Persistent
            // (localStorage) — this whole flow only runs for a personal account (2026-08-14
            // "stay logged in across a Chrome minimize/restart" fix), never a shared-computer
            // business login.
            storeToken(r.token, true);
            deps.Api.setToken(r.token);
            storeSession({ role: r.role, branch_id: null, display_name: r.display_name || '' }, true);
            return { bindToken: r.bind_token };
          })
          .catch(function (err) {
            var msg = (err && err.body && err.body.error) || 'Could not create your account. Please try again.';
            throw new Error(msg);
          });
      },
      onFinished: function () { enterApp(deps); },
      // onGoogleSignup (2026-07-30): only passed when the server actually has Google
      // OAuth configured (cfg.google_auth) — same on/off pattern as onGuest below.
      // Navigates the whole page to /api/auth/google; app.js's boot() finishes the flow
      // when Google redirects back with a token in the URL fragment. Login vs. signup
      // isn't distinguished server-side — routes/googleAuth.js's callback finds-or-
      // creates the account either way, so this is the exact same entry point as
      // mountLogin's onGoogleLogin below.
      onGoogleSignup: (cfg && cfg.google_auth) ? function () { root.location.href = '/api/auth/google'; } : undefined,
      // "Already have an account? Log in" (2026-07-28) — same real Login form/callbacks as
      // Landing's onLogin, so both entry points converge on identical behavior.
      onLogin: function () { mountLogin(deps, undefined, { onRegister: function () { mountOnboarding(deps, cfg); }, onForgotPassword: function () { mountResetPassword(deps, cfg, 'request'); }, onGoogleLogin: (cfg && cfg.google_auth) ? function () { root.location.href = '/api/auth/google'; } : undefined }); },
      // Guest Mode (2026-07-28): lives on the Create Account screen itself (Barat: moved
      // here from an earlier Landing-page placement) — only passed when the server
      // actually turned it on (cfg.guest_mode); onboarding.js only renders the link when
      // opts.onGuest is a function, so an un-flagged deployment is unchanged.
      onGuest: (cfg && cfg.guest_mode) ? function () { mountGuest(deps, cfg); } : undefined,
    });
  }

  function mountLanding(deps, cfg) {
    var mount = document.getElementById('app');
    deps.Landing && deps.Landing.mount(mount, {
      appName: (cfg && cfg.app_name) || 'SnapReceipt AI',
      onLogin: function () { mountLogin(deps, undefined, { onRegister: function () { mountOnboarding(deps, cfg); }, onForgotPassword: function () { mountResetPassword(deps, cfg, 'request'); }, onGoogleLogin: (cfg && cfg.google_auth) ? function () { root.location.href = '/api/auth/google'; } : undefined }); },
      onRegister: function () { mountOnboarding(deps, cfg); },
    });
  }

  // mountGuest (2026-07-28): "Continue as Guest" — POST /api/guest/start mints a real (but
  // disposable) session exactly like a real signup does, then reuses Onboarding's OWN
  // Connect-Telegram/Done screens (via opts.startStep/opts.bindToken — no separate guest UI
  // to build/maintain) since a guest still needs to bind Telegram before they can try anything.
  function mountGuest(deps, cfg) {
    var mount = document.getElementById('app');
    if (document.body) document.body.classList.remove('landing-mode');
    if (!deps.Api || typeof deps.Api.apiFetch !== 'function' || !deps.Onboarding) return;
    deps.Api.apiFetch('/api/guest/start', { method: 'POST' }).then(function (r) {
      storeToken(r.token);
      deps.Api.setToken(r.token);
      storeSession({ role: 'guest', branch_id: null, display_name: 'Guest' });
      if (document.body) document.body.classList.add('onboard-mode');
      if (mount) mount.textContent = '';
      deps.Onboarding.mount(mount, {
        botUsername: cfg && cfg.bot_username,
        Api: deps.Api,
        startStep: 'connect',
        bindToken: r.bind_token,
        onFinished: function () { enterApp(deps); },
      });
    }).catch(function (err) {
      // 2026-08-22 (QA report #2): a device that already used its one guest trial
      // (routes/guest.js's guest_ip_log check, 403 { error: 'guest_already_used' })
      // used to silently bounce back to Landing with ZERO explanation — the user just
      // saw the button do nothing. A native popup is deliberately used here rather than
      // an in-page banner: it's a rare, one-time edge case, and this keeps the fix
      // scoped to app.js without touching landing.js's rendering surface.
      var body = err && typeof err === 'object' ? err.body : null;
      if (body && body.error === 'guest_already_used') {
        try { if (root && typeof root.alert === 'function') root.alert('You\'ve already tried Guest Mode on this device. Sign up for a free account to keep going — your data stays yours.'); } catch (e) { /* ignore */ }
      }
      // Any other failure (rate-limited, or the flag flipped off mid-session) has
      // nowhere useful to go but back to Landing — no partial/broken state to show.
      mountLanding(deps, cfg);
    });
  }

  // attachGuestBeacon() (2026-07-28) — best-effort immediate cleanup when a guest closes the
  // tab. Registered exactly once per page load (boot() calls this unconditionally — cheap,
  // and a no-op unless a guest session actually exists when the tab closes); reads session
  // state FRESH from sessionStorage at fire time rather than a closure snapshot, since this
  // can fire long after boot() ran (or never, for a non-guest session — the common case).
  // `pagehide` (not `beforeunload`) per the plan's own reasoning: more reliable across
  // mobile/bfcache navigation. sendBeacon can't set a custom Authorization header across
  // browsers, so /api/guest/end is the one route that reads its token from the POST body
  // instead — see routes/guest.js. This is a BEST-EFFORT signal only: a crash, force-quit, or
  // OS-killed tab never fires it at all — the 24h server-side sweep (routes/guest.js) is the
  // real guarantee, this is just the fast path for a normal close.
  function attachGuestBeacon() {
    if (typeof root === 'undefined' || !root || !root.addEventListener) return;
    if (!root.navigator || typeof root.navigator.sendBeacon !== 'function') return;
    root.addEventListener('pagehide', function () {
      var sess = getStoredSession();
      var token = getStoredToken();
      if (!sess || sess.role !== 'guest' || !token) return;
      try {
        var blob = new Blob([JSON.stringify({ token: token })], { type: 'application/json' });
        root.navigator.sendBeacon('/api/guest/end', blob);
      } catch (e) { /* best-effort only — the 24h sweep is the real backstop */ }
    });
  }

  // buildGuestBanner(deps) -> a persistent header banner shown on every view for a guest
  // session (2026-07-28). "Sign up" reuses the exact same real signup step every other entry
  // point uses — deliberately starts fully fresh (no guest-data carryover, matches "close the
  // window, start from first" — a guest's data is disposable, not a draft to migrate).
  function buildGuestBanner(deps) {
    var t = deps.t || function (k) { return k; };
    var bar = document.createElement('div');
    bar.className = 'guest-banner';
    var msg = document.createElement('span');
    msg.textContent = t('app.guest_banner');
    bar.appendChild(msg);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'guest-banner-btn';
    btn.textContent = t('app.guest_banner_signup');
    btn.addEventListener('click', function () { mountOnboarding(deps, deps.config); });
    bar.appendChild(btn);
    return bar;
  }

  // buildTelegramBanner(deps, acctInfo) -> a persistent header banner (same classes/placement
  // as buildGuestBanner above) for a real owner account whose Telegram isn't connected yet
  // (2026-08-08). The connect link is permanent now (no expiry), so this is always safe to
  // show — tapping it just opens the same t.me/<bot>?start=<token> deep link Settings' own
  // Telegram row uses. Disappears on its own next boot once acctInfo.telegram_connected flips
  // true (this banner is only ever appended when it's explicitly false, see enterApp above).
  function buildTelegramBanner(deps, acctInfo) {
    var t = deps.t || function (k) { return k; };
    var bar = document.createElement('div');
    bar.className = 'guest-banner';
    var msg = document.createElement('span');
    msg.textContent = t('app.telegram_banner');
    bar.appendChild(msg);
    var botUser = deps.config && deps.config.bot_username;
    var token = acctInfo && acctInfo.telegram_bind_token;
    var btn = document.createElement(botUser && token ? 'a' : 'button');
    btn.className = 'guest-banner-btn';
    btn.textContent = t('app.telegram_banner_connect');
    if (botUser && token) {
      btn.href = 'https://t.me/' + botUser + '?start=' + encodeURIComponent(token);
      btn.target = '_blank';
      btn.rel = 'noopener';
    } else {
      btn.type = 'button';
      btn.addEventListener('click', function () { deps.switchView && deps.switchView('settings'); });
    }
    bar.appendChild(btn);
    return bar;
  }

  // openFeedbackModal(deps) (2026-08-09) — the header's feedback icon (nav.js, personal-only)
  // opens this: a small "contact us" popup, reusing the same .team-modal-* overlay/card CSS
  // as the Delete-account modal (settings.js) and team.js's original openDeleteModal — the
  // one established fixed-backdrop-centered-card pattern this app already uses everywhere,
  // no new CSS needed for the shell. Posts to POST /api/feedback (routes/auth.js), which
  // emails the message straight to the app owner via lib/mailer.js's sendFeedbackEmail.
  function openFeedbackModal(deps) {
    if (typeof document === 'undefined' || !deps.Api || typeof deps.Api.apiFetch !== 'function') return;
    var t = deps.t || function (k) { return k; };
    var overlay = document.createElement('div');
    overlay.className = 'team-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'team-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Contact us');

    var title = document.createElement('div');
    title.className = 'team-modal-title';
    title.textContent = t('app.feedback_title');
    modal.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'team-modal-message';
    desc.textContent = t('app.feedback_desc');
    modal.appendChild(desc);

    var textarea = document.createElement('textarea');
    textarea.className = 'set-field-input';
    textarea.rows = 5;
    textarea.placeholder = t('app.feedback_placeholder');
    textarea.style.width = '100%';
    textarea.style.resize = 'vertical';
    textarea.style.marginTop = '10px';
    modal.appendChild(textarea);

    var errMsg = document.createElement('p');
    errMsg.className = 'team-modal-message set-field-error';
    errMsg.style.display = 'none';
    modal.appendChild(errMsg);

    var actions = document.createElement('div');
    actions.className = 'team-modal-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'set-btn set-btn--ghost';
    cancel.textContent = t('app.feedback_cancel');
    var send = document.createElement('button');
    send.type = 'button'; send.className = 'set-btn set-btn--primary';
    send.textContent = t('app.feedback_send');
    actions.appendChild(cancel); actions.appendChild(send);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    function closeModal() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    cancel.addEventListener('click', closeModal);

    send.addEventListener('click', function () {
      var message = textarea.value.trim();
      if (!message) { textarea.focus(); return; }
      send.disabled = true; cancel.disabled = true;
      errMsg.style.display = 'none';
      deps.Api.apiFetch('/api/feedback', { method: 'POST', body: { message: message } })
        .then(function () {
          title.textContent = t('app.feedback_thanks_title');
          desc.textContent = t('app.feedback_thanks_desc');
          textarea.style.display = 'none';
          send.style.display = 'none';
          cancel.textContent = t('app.feedback_close');
          cancel.disabled = false;
        })
        .catch(function (err) {
          var msg = (err && err.body && err.body.error) || t('app.feedback_send_failed');
          errMsg.textContent = msg;
          errMsg.style.display = '';
          send.disabled = false; cancel.disabled = false;
        });
    });

    document.body.appendChild(overlay);
    textarea.focus();
  }

  // "Forgot password?" (2026-07-27) — personal-mode only. mode 'request' (email in,
  // POST /api/forgot-password) or 'reset' (token from the URL, POST /api/reset-password).
  // Reachable independent of any stored session/token — a person resetting their password
  // may well be fully signed out, which is the whole point.
  function mountResetPassword(deps, cfg, mode, token) {
    var mount = document.getElementById('app');
    deps.ResetPassword && deps.ResetPassword.mount(mount, {
      mode: mode,
      token: token,
      Api: deps.Api,
      onBackToLogin: function () { mountLogin(deps, undefined, { onRegister: function () { mountOnboarding(deps, cfg); }, onForgotPassword: function () { mountResetPassword(deps, cfg, 'request'); }, onGoogleLogin: (cfg && cfg.google_auth) ? function () { root.location.href = '/api/auth/google'; } : undefined }); },
      onRequestNewLink: function () { mountResetPassword(deps, cfg, 'request'); },
    });
  }

  // Email-verification magic-link landing screen (2026-08-24, W-01) — reached via
  // ?verify_token=<token>, already stripped from the URL by boot() before this runs.
  // Unauthenticated (same reasoning as mountResetPassword's 'reset' mode): whatever
  // token/session was already stored (or wasn't) is untouched by this; "Continue" just
  // re-runs boot() so the normal gate decides where a real user lands next.
  function mountEmailVerify(deps, token) {
    var mount = document.getElementById('app');
    deps.EmailVerify && deps.EmailVerify.mount(mount, {
      token: token,
      Api: deps.Api,
      onContinue: function () { boot(); },
    });
  }

  // Boot sequence: apply persisted theme, probe /api/config, run the gate.
  function boot() {
    if (typeof document === 'undefined') return;
    var deps = {
      Escape: dep('Escape'), I18n: dep('I18n'), Api: dep('Api'), AuthGate: dep('AuthGate'), Nav: dep('Nav'),
      Overview: dep('Overview'), Activity: dep('Activity'), Upload: dep('Upload'),
      Templates: dep('Templates'), Reports: dep('Reports'), Agent: dep('Agent'),
      Settings: dep('Settings'), Falc: dep('Falc'),
      RateMeter: dep('RateMeter'), Render: dep('Render'), Login: dep('Login'),
      Payments: dep('Payments'), Grid: dep('Grid'), Team: dep('Team'),
      // Manage shell — hosts the Templates + Grid sub-pages behind a dropdown.
      Manage: dep('Manage'),
      // Personal-mode real-account onboarding (2026-07-25) — Welcome/Connect/Done + the new
      // Create-account first step. Optional so older cached bundles without it don't break boot.
      Onboarding: dep('Onboarding'),
      // Marketing entry screen shown before Onboarding/Login (2026-07-27).
      Landing: dep('Landing'),
      // "Forgot password?" flow (2026-07-27), personal-mode only.
      ResetPassword: dep('ResetPassword'),
      // Email-verification UI (2026-08-24, W-01) — optional like ResetPassword/Tour, so
      // an older cached bundle without it simply never shows the verify screen/banner.
      EmailVerify: dep('EmailVerify'),
      // Interactive guided onboarding tour (2026-08-22). Optional, like Falc/RateMeter —
      // an older cached bundle without it simply never offers/auto-starts the tour.
      Tour: dep('Tour'),
    };
    if (!deps.Escape || !deps.Api || !deps.AuthGate || !deps.Nav) return;
    // Guard against an older cached bundle missing i18n.js entirely — fall back to a
    // stub that shows the raw dotted key rather than throwing across every component.
    if (!deps.I18n) deps.I18n = { t: function (k) { return k; }, tp: function (k) { return k; }, lang: function () { return 'en'; }, setLang: function () { return 'en'; }, LANGS: [['en', 'English']] };
    deps.t = deps.I18n.t;
    if (document.documentElement) document.documentElement.lang = deps.I18n.lang();

    // Subscribe once, before any view can possibly fetch and hit a dead session.
    if (deps.Api.onAuthExpired) deps.Api.onAuthExpired(handleAuthExpired);

    // Guest Mode (2026-07-28): registered unconditionally, every boot — a no-op for every
    // non-guest session (the common case), see attachGuestBeacon's own doc comment.
    attachGuestBeacon();

    applyTheme(storedTheme());

    // Attach any already-stored token to Api up front so config carries it too.
    var stored = getStoredToken();
    if (stored) deps.Api.setToken(stored);

    // One-shot: handleAuthExpired sets this right before reloading, so the login/token
    // gate this boot lands on can say WHY it's asking again instead of just appearing
    // blank (the exact gap in the 2026-07-11 incident — nothing told the user a fresh
    // login was the fix).
    var expiredNotice = null;
    var s = ss();
    try {
      if (s && s.getItem(AUTH_EXPIRED_KEY)) {
        expiredNotice = deps.t('app.session_expired');
        s.removeItem(AUTH_EXPIRED_KEY);
      }
    } catch (e) { /* ignore */ }

    // Google Sign-In return trip (2026-07-30): routes/googleAuth.js's callback redirects
    // back here with the session token in the URL FRAGMENT (`#gauth_token=...`), never the
    // query string — a fragment never reaches the server, never lands in an access log,
    // never rides a Referer header. Parsed synchronously (doesn't need /api/config) and the
    // fragment is scrubbed via replaceState immediately either way, so a token never sits
    // visible in the address bar or browser history, success or failure.
    var gauth = null;
    // Bug fix (2026-08-24, found while researching W-01): routes/googleAuth.js redirects
    // back here with `#gauth_error=<code>` on every failure path (denied, state_mismatch,
    // account_type collision, not_configured, or a generic failed) — but until now nothing
    // on this end ever read it. A user whose Google sign-in failed saw the login screen
    // reappear with zero explanation, as if the click had done nothing at all.
    var gauthErrorMsg = null;
    try {
      if (root && root.location && root.location.hash && root.location.hash.length > 1) {
        var hashParams = new URLSearchParams(root.location.hash.slice(1));
        if (hashParams.get('gauth_token')) {
          gauth = {
            token: hashParams.get('gauth_token'),
            role: hashParams.get('gauth_role') || 'owner',
            name: hashParams.get('gauth_name') || '',
            isNew: hashParams.get('gauth_new') === '1',
            bindToken: hashParams.get('gauth_bind') || null,
          };
        } else {
          var gauthError = hashParams.get('gauth_error');
          if (gauthError) {
            // Only 'denied', 'account_type', and 'not_configured' get their own copy —
            // anything else (state_mismatch, failed, or a future code this build doesn't
            // know about yet) falls back to the generic message rather than surfacing an
            // internal code name to the user.
            var key = (gauthError === 'denied' || gauthError === 'account_type' || gauthError === 'not_configured')
              ? 'app.gauth_error_' + gauthError : 'app.gauth_error_failed';
            gauthErrorMsg = deps.t ? deps.t(key) : key;
          }
        }
        if (root.history && root.history.replaceState) {
          root.history.replaceState(null, '', root.location.pathname + root.location.search);
        }
      }
    } catch (e) { /* malformed fragment — ignore, fall through to the normal gate */ }

    // 2026-08-19 BUG FIX: attach the fresh gauth token to Api BEFORE the /api/config call
    // below, not after. This used to happen only inside that call's .then() handler — so the
    // VERY FIRST /api/config request after a brand-new Google signup went out with NO
    // Authorization header at all (the token was still sitting unattached in the local
    // `gauth` var), came back with account_info:null (an honest, correct answer for an
    // unauthenticated request — routes/expenses.js was never the bug), and that null-
    // account_info response was then used as `deps.config` for the rest of the session with
    // no second, authenticated fetch ever made. Not a Supabase read-after-write race — a
    // pure request-ordering bug. setToken() only touches an in-memory var (see api.js) with
    // no persistence side effect, so attaching it early here is safe even if `cfg.personal_auth`
    // turns out to be off below — storeToken/storeSession (the persisted, "keep me logged in"
    // step) stay exactly where they were, still gated on that check.
    if (gauth && gauth.token) deps.Api.setToken(gauth.token);

    // Check for special URL params that MUST go through the full fetch path
    var hasResetToken = false;
    try {
      var qs = root && root.location && new URLSearchParams(root.location.search);
      hasResetToken = !!(qs && qs.get('reset_token'));
    } catch (e) { /* ignore */ }

    // --- Instant render for returning users (2026-08-19) ---
    // A returning user (stored token + cached config, no special URL params) gets the
    // dashboard painted from the cached /api/config response — zero network wait. A
    // background fetch silently refreshes the config; if anything changed (categories,
    // flags), views pick it up on their next render cycle or the user's next refresh.
    var cachedCfg = getCachedConfig();
    if (stored && cachedCfg && !gauth && !hasResetToken && !expiredNotice) {
      deps.config = cachedCfg;
      if (cachedCfg.personal_auth && !storedTheme()) setTheme('ocean');
      renderApp(deps);
      // Background refresh — fire and forget; errors are harmless (cached config stands)
      deps.Api.apiFetch('/api/config').then(function (freshCfg) {
        if (freshCfg) {
          deps.config = freshCfg;
          cacheConfig(freshCfg);
        }
      }).catch(function () { /* stale cache is fine until next refresh */ });
      return;
    }

    // Not a returning user, or no cache yet — show loading indicator and fetch
    showBootLoading(deps);

    withTimeout(deps.Api.apiFetch('/api/config'), 15000).then(function (cfg) {
      deps.config = cfg;
      cacheConfig(cfg);
      if (cfg && cfg.personal_auth && !storedTheme()) setTheme('ocean');

      if (gauth && gauth.token && cfg && cfg.personal_auth) {
        // Api already carries this token (attached before the /api/config fetch above, so
        // THAT request itself was authenticated) — storeToken persists it for next visit.
        storeToken(gauth.token, true);
        storeSession({ role: gauth.role, branch_id: null, display_name: gauth.name }, true);
        if (gauth.isNew && gauth.bindToken && deps.Onboarding) {
          if (document.body) document.body.classList.add('onboard-mode');
          var gMount = document.getElementById('app');
          if (gMount) gMount.textContent = '';
          deps.Onboarding.mount(gMount, {
            botUsername: cfg.bot_username,
            Api: deps.Api,
            startStep: 'connect',
            bindToken: gauth.bindToken,
            onFinished: function () { enterApp(deps); },
          });
        } else {
          enterApp(deps);
        }
        return;
      }

      // Bug fix (2026-08-24, W-01): a gauth_error lands here with NO token, so the block
      // above never runs. Left alone, boot() would fall through to the normal AuthGate
      // decision — which for a personal-auth deployment with no stored token is ALWAYS
      // 'signup' (see authgate.js's authState()), landing on the marketing Landing page,
      // not the login form. The error would never reach mountLogin at all: Landing's own
      // onLogin callback (used 3x elsewhere in this file) is the ONLY path that actually
      // mounts Login for a personal account, so a failed Google sign-in must go straight
      // there instead of waiting for a second click through Landing first.
      if (gauthErrorMsg && cfg && cfg.personal_auth) {
        mountLogin(deps, gauthErrorMsg, { onRegister: function () { mountOnboarding(deps, cfg); }, onForgotPassword: function () { mountResetPassword(deps, cfg, 'request'); }, onGoogleLogin: (cfg && cfg.google_auth) ? function () { root.location.href = '/api/auth/google'; } : undefined });
        return;
      }

      var resetToken = null;
      try {
        var rtQs = root && root.location && new URLSearchParams(root.location.search);
        resetToken = rtQs ? rtQs.get('reset_token') : null;
      } catch (e) { /* ignore */ }
      if (resetToken && cfg && cfg.personal_auth) {
        mountResetPassword(deps, cfg, 'reset', resetToken);
        return;
      }

      // Email-verification magic link (2026-08-24, W-01, P-01 contract §3: "strip
      // ?verify_token= from the URL immediately after reading it" — it's a live,
      // single-use credential, and unlike reset_token it must not be left sitting in
      // the address bar/history even after a successful confirm). Unauthenticated by
      // design (contract §2 — the link IS the credential, and may open in a mail
      // client with no session at all).
      var verifyToken = null;
      try {
        var vtQs = root && root.location && new URLSearchParams(root.location.search);
        verifyToken = vtQs ? vtQs.get('verify_token') : null;
        if (verifyToken && root.history && root.history.replaceState) {
          vtQs.delete('verify_token');
          var strippedSearch = vtQs.toString();
          root.history.replaceState(null, '', root.location.pathname + (strippedSearch ? '?' + strippedSearch : ''));
        }
      } catch (e) { /* ignore */ }
      if (verifyToken && cfg && cfg.personal_auth) {
        mountEmailVerify(deps, verifyToken);
        return;
      }

      var decision = deps.AuthGate.authState({
        authRequired: cfg && cfg.auth_required,
        multiUser: cfg && cfg.multi_user,
        personalAuth: cfg && cfg.personal_auth,
        storedToken: getStoredToken(),
      });
      if (decision === 'login') {
        mountLogin(deps, expiredNotice || gauthErrorMsg);
      } else if (decision === 'signup') {
        mountLanding(deps, cfg);
      } else if (decision === 'prompt') {
        renderTokenGate(deps, function () { enterApp(deps); }, undefined, expiredNotice);
      } else {
        renderApp(deps);
      }
    }).catch(function (err) {
      var isTimeout = err && err.message === 'timeout';
      showBootError(deps, isTimeout ? 'app.boot_timeout' : 'app.server_unreachable');
    });
  }

  // Installable web app (2026-08-25): the one missing piece for Chrome/Edge to
  // actually offer an Install prompt (manifest.webmanifest + icons already
  // existed) — see sw.js's own header for the exact, deliberately narrow scope
  // (never touches /api/, so ADR-025 still holds). deferredInstallPrompt holds
  // the browser's install event until Settings > About's "Install App" button
  // (deps.installApp below) chooses to show it — Chrome requires calling
  // .preventDefault() up front to control timing like this.
  var deferredInstallPrompt = null;
  function isStandalone() {
    try {
      return !!((root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) || root.navigator.standalone);
    } catch (e) { return false; }
  }

  // Auto-boot only in a real browser (DOM present). Node require() must not boot.
  if (typeof document !== 'undefined' && root && root.addEventListener) {
    if (document.readyState === 'loading') {
      root.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
    if (root.navigator && 'serviceWorker' in root.navigator) {
      root.addEventListener('load', function () {
        // Never let a registration failure (unsupported browser quirk, etc.)
        // affect anything else — installability just silently degrades.
        root.navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
    root.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferredInstallPrompt = ev;
    });
    root.addEventListener('appinstalled', function () { deferredInstallPrompt = null; });
  }

  return {
    boot: boot,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    setTheme: setTheme,
    getStoredToken: getStoredToken,
    showView: showView,
    storedAutoMode: storedAutoMode,
    setAutoMode: setAutoMode,
    storedDefaultView: storedDefaultView,
    setDefaultView: setDefaultView,
    handleAuthExpired: handleAuthExpired,
  };
});
