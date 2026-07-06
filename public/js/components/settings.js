// components/settings.js — the Settings screen (Phase 2 of Mugi's Treehouse
// concept): account/session, appearance (theme), currency & display, and a few
// forward-looking "concept" rows (capture, notifications, privacy) that describe
// the multi-tenant M2 behaviour without wiring backend that doesn't exist yet.
//
// Only the rows that map to something REAL today actually do something:
//   • Session — Log out (clears the dashboard token via deps.logout) / status.
//   • Theme — switches the light/dark forest palette (deps.setTheme, persisted).
//   • Account currency — read-only, from GET /api/config (deps.config).
//   • Clear local data — wipes the saved token + theme from this browser.
//   • Agent auto-mode — skips confirmation for edits & review decisions
//     (deps.autoMode / deps.setAutoMode; wiring lives in app.js, ADR-019).
// Everything else is tagged "concept" so it's honest about not being live.
//
// TWO layers so the logic is unit-testable without a DOM:
//   1. PURE helpers — settingsModel / currentTheme. No DOM, never throw on junk.
//      Covered by tests/frontend/settings.test.js.
//   2. RENDER layer (mount) — real DOM via createElement + Escape.setText. No
//      innerHTML anywhere (SOP §7 — every value is inert text). No-ops in Node.
//
// UMD shim: window.Settings in the browser; require()-able in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'));
  } else {
    root.Settings = factory(root.Escape);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ---- pure helpers -------------------------------------------------------

  // Distil the bits of /api/config Settings shows into a small, safe model.
  // Tolerant of a missing/garbage config (renders sensible fallbacks). Never
  // throws.
  function settingsModel(config, hasToken) {
    var cfg = isPlainObject(config) ? config : {};
    var currency = typeof cfg.default_currency === 'string' && cfg.default_currency.trim()
      ? cfg.default_currency.trim() : 'MYR';
    return {
      currency: currency,
      authRequired: !!cfg.auth_required,
      signedIn: !!hasToken,
    };
  }

  // Read the active theme off <body> (matches app.js's applyTheme classes).
  // 'dark' when the dark class is present, else 'light'. Never throws.
  function currentTheme() {
    try {
      if (typeof document === 'undefined' || !document.body) return 'light';
      return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  // Coerce opts.autoMode into a strict boolean for the Agent auto-mode toggle's
  // initial state. Tolerant of missing/garbage input (undefined, strings, etc.)
  // — defaults to false. Never throws.
  function initialAutoMode(opts) {
    return !!(opts && opts.autoMode);
  }

  // ---- DOM helpers (browser only) -----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // A collapsible section (low-stimulation: open what you want). Static title
  // via textContent. Returns { el, body }.
  function collapsible(title, defaultOpen) {
    var wrap = el('div', 'collapsible' + (defaultOpen ? ' is-open' : ''));
    var head = el('button', 'collapsible-head');
    head.type = 'button';
    var chev = el('span', 'collapsible-chev'); chev.textContent = '▸';
    var t = el('span', 'collapsible-title'); t.textContent = str(title);
    head.appendChild(chev); head.appendChild(t);
    var body = el('div', 'collapsible-body');
    head.addEventListener('click', function () { wrap.classList.toggle('is-open'); });
    wrap.appendChild(head); wrap.appendChild(body);
    return { el: wrap, body: body };
  }

  // A settings row: label (+ optional "concept" tag) + description + control.
  function setRow(label, desc, control, concept) {
    var r = el('div', 'set-row');
    var main = el('div', 'set-main');
    var lab = el('div', 'set-label');
    lab.appendChild(document.createTextNode(str(label)));
    if (concept) { var tag = el('span', 'concept-tag'); tag.textContent = 'concept'; lab.appendChild(tag); }
    main.appendChild(lab);
    if (desc) { var d = el('div', 'set-desc'); Escape.setText(d, desc); main.appendChild(d); }
    r.appendChild(main);
    var c = el('div', 'set-control');
    if (control) c.appendChild(control);
    r.appendChild(c);
    return r;
  }

  // A read-only value chip.
  function valueChip(text) { var s = el('span', 'set-value'); Escape.setText(s, text); return s; }

  // A toggle switch. `onChange` is optional — omit it (as every "concept" row
  // does) and the switch is purely visual, not wired to anything. When
  // provided, it's called with the new boolean value on the checkbox's
  // `change` event.
  function toggle(checked, onChange) {
    var s = el('label', 'switch');
    var i = el('input'); i.type = 'checkbox'; i.checked = !!checked;
    var track = el('span', 'switch-track');
    var knob = el('span', 'switch-knob');
    s.appendChild(i); s.appendChild(track); s.appendChild(knob);
    if (typeof onChange === 'function') {
      i.addEventListener('change', function () { onChange(!!i.checked); });
    }
    return s;
  }

  // A <select> from [value,label] pairs, with an onChange callback.
  function pick(options, value, onChange) {
    var sel = el('select', 'set-select');
    (options || []).forEach(function (o) {
      var op = el('option'); op.value = o[0]; Escape.setText(op, o[1]); sel.appendChild(op);
    });
    if (value != null) sel.value = value;
    if (typeof onChange === 'function') sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var Api = opts.Api || null;
    var hasToken = !!(Api && Api.getToken && Api.getToken());
    var model = settingsModel(opts.config, hasToken);

    var rootEl = el('div', 'set-root');
    section.appendChild(rootEl);

    var sub = el('p', 'view-sub muted');
    Escape.setText(sub, 'Account, appearance, capture, notifications and privacy.');
    rootEl.appendChild(sub);

    // --- Account & session (real) ---
    var acc = collapsible('Account & session', true);
    var authBtn = el('button', model.signedIn ? 'set-btn set-btn--danger' : 'set-btn set-btn--primary');
    Escape.setText(authBtn, model.signedIn ? 'Log out' : 'Log in');
    authBtn.addEventListener('click', function () {
      if (typeof opts.logout === 'function') opts.logout();
    });
    acc.body.appendChild(setRow(
      'Session',
      model.signedIn ? 'You are signed in on this device.'
        : (model.authRequired ? 'Not signed in.' : 'This dashboard is open (no token required in dev).'),
      authBtn
    ));
    acc.body.appendChild(setRow(
      'Identity',
      'HQ admin / branch clerk account (from Supabase Auth in the live system).',
      valueChip(model.signedIn ? 'token session' : '—'),
      true
    ));
    rootEl.appendChild(acc.el);

    // --- Appearance (real: theme) ---
    var app = collapsible('Appearance', false);
    var themeSel = pick(
      [['light', 'Light'], ['dark', 'Dark']],
      currentTheme(),
      function (v) { if (typeof opts.setTheme === 'function') opts.setTheme(v); }
    );
    app.body.appendChild(setRow('Theme', 'Light or dark forest palette. Saved to this browser.', themeSel));
    rootEl.appendChild(app.el);

    // --- Agent (real: auto-mode) ---
    var agent = collapsible('Agent', false);
    agent.body.appendChild(setRow(
      'Agent auto-mode',
      'Skip confirmation for edits & review decisions. Delete and template changes always confirm, regardless of this setting.',
      toggle(initialAutoMode(opts), function (v) {
        if (typeof opts.setAutoMode === 'function') opts.setAutoMode(v);
      })
    ));
    rootEl.appendChild(agent.el);

    // --- Currency & display ---
    var cur = collapsible('Currency & display', false);
    cur.body.appendChild(setRow('Account currency', 'Set on the server; amounts are normalised to this.', valueChip(model.currency)));
    cur.body.appendChild(setRow('Date format', 'How dates display across the dashboard.', pick([['iso', 'YYYY-MM-DD'], ['dmy', 'DD/MM/YYYY'], ['mdy', 'MMM D, YYYY']], 'iso'), true));
    rootEl.appendChild(cur.el);

    // --- Capture & camera (concept) ---
    var cap = collapsible('Capture & camera', false);
    cap.body.appendChild(setRow('Camera capture on Upload', 'Let staff snap a receipt straight from the device camera.', toggle(true), true));
    cap.body.appendChild(setRow('Auto-crop & enhance', 'Straighten and sharpen the photo before OCR.', toggle(true), true));
    rootEl.appendChild(cap.el);

    // --- Notifications (concept) ---
    var noti = collapsible('Notifications', false);
    noti.body.appendChild(setRow('Telegram confirmations', 'Reply in chat when a receipt is captured.', toggle(true), true));
    noti.body.appendChild(setRow('Weekly email summary', 'A branch/company spend digest each week.', toggle(false), true));
    noti.body.appendChild(setRow('Anomaly alerts', 'Notify the admin when a receipt is flagged.', toggle(true), true));
    rootEl.appendChild(noti.el);

    // --- Privacy & data (real: clear local) ---
    var priv = collapsible('Privacy & data', false);
    priv.body.appendChild(setRow('Data retention', 'How long receipt images are kept.', pick([['12', '12 months'], ['24', '24 months'], ['0', 'Forever']], '24'), true));
    var clearBtn = el('button', 'set-btn set-btn--ghost');
    Escape.setText(clearBtn, 'Clear now');
    clearBtn.addEventListener('click', function () {
      try { if (typeof sessionStorage !== 'undefined') sessionStorage.clear(); } catch (e) { /* ignore */ }
      if (typeof opts.onClearLocal === 'function') opts.onClearLocal();
    });
    priv.body.appendChild(setRow('Clear local data', 'Remove the saved token + theme from this browser.', clearBtn));
    var note = el('p', 'set-privacy-text');
    Escape.setText(note, 'Receipts and extracted data are stored per company and scoped by branch. HQ admins see all branches; branch clerks see only their own. In the live system this is enforced by database row-level security, not just the UI.');
    priv.body.appendChild(note);
    rootEl.appendChild(priv.el);

    // --- About ---
    var about = collapsible('About', false);
    about.body.appendChild(setRow('AutoReceipt Dashboard', 'Treehouse frontend concept · Mugi design, adapted onto the app.', valueChip('v0.2')));
    rootEl.appendChild(about.el);

    // Settings is static — no async data to fetch on view.
    return { el: rootEl };
  }

  return {
    // pure
    settingsModel: settingsModel,
    currentTheme: currentTheme,
    initialAutoMode: initialAutoMode,
    // render (browser)
    mount: mount,
  };
});
