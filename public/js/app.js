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

  // Resolve dependencies from either CommonJS (Node) or the browser globals that
  // the earlier <script> tags attached. In Node these are only used by boot(),
  // which never runs there, so a missing global is harmless.
  function dep(name) {
    if (typeof module === 'object' && module.exports) {
      try {
        if (name === 'Escape') return require('./escape');
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

  // --- business session identity (ADR-021 Phase 6) ---
  // The identity ({ role, branch_id, display_name }) is stored SEPARATELY from the
  // token so a page refresh keeps the role-aware shell without re-login. It is
  // identity metadata only — authorization always happens server-side per request
  // (a tampered role here changes labels, never data access).
  function getStoredSession() {
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

  function storeSession(sess) {
    var s = ss();
    try {
      if (!s) return;
      if (sess) s.setItem(SESSION_KEY, JSON.stringify({
        role: sess.role || '', branch_id: sess.branch_id || null, display_name: sess.display_name || '',
      }));
      else s.removeItem(SESSION_KEY);
    } catch (e) { /* ignore */ }
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
      var s = ss();
      try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
      storeSession(null);
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
    var s = ss();
    try { if (s) s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    storeSession(null);
    try { var api = dep('Api'); if (api && api.setToken) api.setToken(null); } catch (e) { /* ignore */ }
    try { if (s) s.setItem(AUTH_EXPIRED_KEY, '1'); } catch (e) { /* ignore */ }
    reloadPage();
  }

  // Owner request 2026-07-06: a small "what is this page for" hint on every
  // page, so a non-technical user always has a one-line explanation on hand
  // without having to ask. Plain, static strings (never user input), so a
  // direct .textContent assignment is safe — same convention this file
  // already uses for s.label below.
  var VIEW_INFO = {
    overview: 'A quick snapshot of your spending: your total, the trend this year, and your top categories.',
    activity: "Every receipt you've captured — search, filter, edit, or review any of them.",
    upload: 'Add a receipt manually from this browser, instead of sending it to the Telegram bot.',
    manage: "Set up how the app reads your receipts and, in business mode, edit your data directly. Use the Section dropdown to switch between the field/category template and the spreadsheet-style Data editor (click any cell to edit it in place).",
    settings: 'Adjust preferences like theme, categories, and account options.',
    // Business-only (ADR-021 Phase 6/8): only ever shown when Nav.sectionsFor(business) is used.
    team: 'Manage your branches and each branch’s staff directory. Admins can also add branches and companies.',
    payments: 'Track which expenses are pending vs paid. Admins can select several and mark them paid at once.',
  };

  // The "i" button + popup logic itself now lives in Render.buildInfoIcon
  // (shared with components that want the same per-section explainer, e.g.
  // Templates' visual field builder) — this map just supplies the per-page text.

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
  // `sections` is the SAME list enterApp already computed for Nav.buildNav (single
  // source of truth — see enterApp) so the nav buttons and the mounted panels can
  // never disagree about what's in business vs personal mode.
  function buildViews(sections, mount, deps) {
    sections = sections || [];
    var components = viewComponents(deps);
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
    if (initialMessage) Escape.setText(msg, initialMessage);

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(submit);
    if (typeof onCancel === 'function') {
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'token-gate-cancel';
      cancel.textContent = 'Cancel';
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
      if (!tok) { Escape.setText(msg, 'Please enter a token.'); return; }
      storeToken(tok);
      Api.setToken(tok);              // never logged
      mount.textContent = '';
      onEntered();
    });

    mount.appendChild(form);
    input.focus();
  }

  // Enter the app proper: build the brand header + nav + views, wire switching + theme.
  function enterApp(deps) {
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
      onRefresh: reloadPage,
    });
    if (header && brandHeader) header.appendChild(brandHeader.el);

    var nav = Nav.buildNav({ onSelect: select, sections: sections });
    if (header && nav) header.appendChild(nav.el);

    // Guest Mode (2026-07-28): a persistent, non-dismissible reminder across every view (not
    // scoped to one page — appended to the header, which persists across select() calls) —
    // per Barat's decision, the guest keeps browsing what they've already got even after the
    // cap hits, so this never disappears/blocks anything, it just never lets them forget.
    if (header && deps.session && deps.session.role === 'guest') header.appendChild(buildGuestBanner(deps));

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

    function select(id) {
      showView(id);
      if (nav && nav.setActive) nav.setActive(id);
      // Lazy-load a view's data the first time it becomes visible.
      var inst = instances[id];
      if (inst && typeof inst.load === 'function') inst.load();
    }

    // A stored default-view id only wins if it's actually in THIS boot's section
    // list (business vs personal, or a since-removed view) — otherwise fall back
    // to the first section, same as before this preference existed.
    var storedDefault = storedDefaultView();
    var validDefault = storedDefault && sections.some(function (s) { return s.id === storedDefault; });
    var first = (validDefault && storedDefault) || (sections[0] && sections[0].id) || 'overview';
    select(first);
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
    deps.storeToken = storeToken;
    deps.Login && deps.Login.render(mount, deps, function (session) {
      storeSession(session);
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
            // Api, so the rest of the app (checkDash-gated calls) works unchanged.
            storeToken(r.token);
            deps.Api.setToken(r.token);
            storeSession({ role: r.role, branch_id: null, display_name: r.display_name || '' });
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
    }).catch(function () {
      // A failed guest signup (rate-limited, or the flag flipped off mid-session) has
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
    var bar = document.createElement('div');
    bar.className = 'guest-banner';
    var msg = document.createElement('span');
    msg.textContent = 'Guest mode — try up to 4 receipts, then sign up to keep your data.';
    bar.appendChild(msg);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'guest-banner-btn';
    btn.textContent = 'Sign up';
    btn.addEventListener('click', function () { mountOnboarding(deps, deps.config); });
    bar.appendChild(btn);
    return bar;
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

  // Boot sequence: apply persisted theme, probe /api/config, run the gate.
  function boot() {
    if (typeof document === 'undefined') return;
    var deps = {
      Escape: dep('Escape'), Api: dep('Api'), AuthGate: dep('AuthGate'), Nav: dep('Nav'),
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
    };
    if (!deps.Escape || !deps.Api || !deps.AuthGate || !deps.Nav) return;

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
        expiredNotice = 'Your session expired. Please log in again.';
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
        }
        if (root.history && root.history.replaceState) {
          root.history.replaceState(null, '', root.location.pathname + root.location.search);
        }
      }
    } catch (e) { /* malformed fragment — ignore, fall through to the normal gate */ }

    deps.Api.apiFetch('/api/config').then(function (cfg) {
      // Share the already-fetched config (incl. `categories`) with mounted view
      // components — e.g. activity.js's category dropdowns/pill colours — so
      // they don't issue a second, redundant /api/config call at boot.
      deps.config = cfg;
      // Default a FRESH personalAuth session (no theme picked yet this session) to
      // Ocean — matches the blue/white Landing/Login/Onboarding identity (2026-07-27,
      // Barat: "change ALL theme to blue white"). Gated on personal_auth and applied
      // only when nothing is already stored, so: (a) a returning user's own choice in
      // Settings always wins, and (b) business (multiUser) deployments — which share
      // this exact file — are completely unaffected; their fresh-session default stays
      // 'light', exactly as before this change.
      if (cfg && cfg.personal_auth && !storedTheme()) setTheme('ocean');

      // Finish the Google Sign-In round trip (2026-07-30): a token in the fragment wins
      // over any stored session/gate decision, mirroring reset_token's priority below —
      // this IS the login, arriving via redirect rather than a fetch response. A brand-new
      // account (gauth.isNew) still needs Connect-Telegram before the dashboard, exactly
      // like a real signup; a returning account goes straight in.
      if (gauth && gauth.token && cfg && cfg.personal_auth) {
        storeToken(gauth.token);
        deps.Api.setToken(gauth.token);
        storeSession({ role: gauth.role, branch_id: null, display_name: gauth.name });
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

      // "Forgot password?" reset link (2026-07-27): ?reset_token=... in the URL takes
      // priority over the normal gate decision entirely, regardless of stored-token
      // state — someone resetting a password may be fully signed out (the whole
      // point), or may have an unrelated stale session in this same browser; either
      // way the reset screen must be reachable. Personal-mode only.
      var resetToken = null;
      try {
        var qs = root && root.location && new URLSearchParams(root.location.search);
        resetToken = qs ? qs.get('reset_token') : null;
      } catch (e) { /* ignore — malformed query string, fall through to the normal gate */ }
      if (resetToken && cfg && cfg.personal_auth) {
        mountResetPassword(deps, cfg, 'reset', resetToken);
        return;
      }

      var decision = deps.AuthGate.authState({
        authRequired: cfg && cfg.auth_required,
        multiUser: cfg && cfg.multi_user,
        personalAuth: cfg && cfg.personal_auth,
        storedToken: getStoredToken(),
      });
      if (decision === 'login') {
        // Business mode (ADR-021 Phase 6): username/password login, never the token box.
        mountLogin(deps, expiredNotice);
      } else if (decision === 'signup') {
        // Personal-mode real accounts (2026-07-27): marketing Landing screen first
        // (Login/Register), THEN Create account -> Welcome -> Connect Telegram ->
        // You're set — never the old static token box (see authgate.js). Landing is
        // pure chrome in front of the same two real gates (Onboarding/Login); it
        // enforces nothing itself.
        mountLanding(deps, cfg);
      } else if (decision === 'prompt') {
        renderTokenGate(deps, function () { enterApp(deps); }, undefined, expiredNotice);
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
