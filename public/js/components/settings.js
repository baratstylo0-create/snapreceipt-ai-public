// components/settings.js — the Settings screen (built from Mugi's Treehouse
// concept mockup): account/session, appearance (theme, default page), currency
// & display, and a few rows (capture, notifications, retention) that the
// concept itself marks "concept" — intentional placeholders for a later
// version, not things this build was ever meant to wire up.
//
// Only the rows that map to something REAL today actually do something:
//   • Session — Log out (clears the dashboard token via deps.logout) / status.
//   • Theme — switches the light/warm/dark forest palette (deps.setTheme, persisted).
//   • Default page — which view opens on a fresh launch (deps.sections/
//     deps.defaultView/deps.setDefaultView; wiring lives in app.js).
//   • Account currency — read-only, from GET /api/config (deps.config).
//   • Clear local data — wipes the saved token + theme from this browser.
//   • Agent auto-mode — skips confirmation for edits & review decisions
//     (deps.autoMode / deps.setAutoMode; wiring lives in app.js, ADR-019).
// Team/company/staff management (the M2 business layer) lives in its own
// components/team.js view, not here. Everything else below is tagged "concept"
// so it stays honest about not being live — same as the source mockup.
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
  // 'warm'/'dark'/'ocean' when that class is present, else 'light'. Never throws.
  function currentTheme() {
    try {
      if (typeof document === 'undefined' || !document.body) return 'light';
      if (document.body.classList.contains('theme-warm')) return 'warm';
      if (document.body.classList.contains('theme-ocean-dark')) return 'ocean-dark';
      if (document.body.classList.contains('theme-dark')) return 'dark';
      if (document.body.classList.contains('theme-ocean')) return 'ocean';
      return 'light';
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

  // A labelled text input with an eye-icon toggle to show/hide the value — built for the
  // Delete-account password field (2026-08-09, Barat: "give eye icon that password view
  // option"). Starts masked (type=password); the toggle flips type password<->text and
  // swaps the glyph, mirroring the same open/closed-eye convention used everywhere else
  // (browsers' own native show-password icon, etc.). Returns { wrap, input }.
  function passwordFieldWithEye(labelText) {
    var wrap = el('div', 'set-field');
    var lab = el('label', 'set-field-label');
    Escape.setText(lab, labelText);
    wrap.appendChild(lab);
    var row = el('div', 'set-field-input-row');
    var input = el('input', 'set-field-input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    row.appendChild(input);
    var eyeBtn = el('button', 'set-field-eye');
    eyeBtn.type = 'button';
    eyeBtn.setAttribute('aria-label', 'Show password');
    eyeBtn.textContent = '👁';
    eyeBtn.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      eyeBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      eyeBtn.classList.toggle('is-active', !showing);
    });
    row.appendChild(eyeBtn);
    wrap.appendChild(row);
    return { wrap: wrap, input: input };
  }

  // Delete-account confirmation modal (2026-08-09) — reuses team.js's openDeleteModal
  // structure/CSS classes (.team-modal-overlay/.team-modal/...) exactly, the established
  // fixed-backdrop-centered-card pattern already shared across this app, rather than
  // inventing a new one. Requires BOTH the real account password (verified server-side —
  // routes/auth.js's DELETE /api/account, already live) AND typing the literal word DELETE
  // (client-side friction only, mirrors the reference design) before the button un-disables.
  function openDeleteAccountModal(opts) {
    if (!hasDom()) return;
    var overlay = el('div', 'team-modal-overlay');
    var modal = el('div', 'team-modal');
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-label', 'Delete your account?');
    modal.appendChild((function () { var t = el('div', 'team-modal-title'); Escape.setText(t, 'Delete your account?'); return t; })());
    modal.appendChild((function () {
      var p = el('p', 'team-modal-message');
      Escape.setText(p, 'This permanently deletes your account, every receipt, and your Telegram connection. This cannot be undone.');
      return p;
    })());

    var pw = passwordFieldWithEye('Confirm your password');
    modal.appendChild(pw.wrap);

    var confirmField = el('div', 'set-field');
    var confirmLab = el('label', 'set-field-label');
    Escape.setText(confirmLab, 'Type DELETE to confirm');
    confirmField.appendChild(confirmLab);
    var confirmInput = el('input', 'set-field-input');
    confirmInput.type = 'text';
    confirmInput.autocomplete = 'off';
    confirmField.appendChild(confirmInput);
    modal.appendChild(confirmField);

    var errMsg = el('p', 'team-modal-message set-field-error');
    errMsg.style.display = 'none';
    modal.appendChild(errMsg);

    var actions = el('div', 'team-modal-actions');
    var cancel = el('button', 'set-btn set-btn--ghost'); cancel.type = 'button';
    Escape.setText(cancel, 'Cancel');
    var confirm = el('button', 'set-btn set-btn--danger'); confirm.type = 'button';
    confirm.disabled = true;
    Escape.setText(confirm, 'Delete my account');
    actions.appendChild(cancel); actions.appendChild(confirm);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    // Both fields must be filled (password non-empty, confirm text exactly "DELETE") before
    // the destructive button is even clickable — matches the reference design, and gives an
    // extra guard against a fast/accidental click beyond the password check alone.
    function refreshEnabled() {
      confirm.disabled = !(pw.input.value && confirmInput.value === 'DELETE');
    }
    pw.input.addEventListener('input', refreshEnabled);
    confirmInput.addEventListener('input', refreshEnabled);

    function closeModal() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    cancel.addEventListener('click', closeModal);
    confirmInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !confirm.disabled) confirm.click(); });

    confirm.addEventListener('click', function () {
      if (confirm.disabled || !opts.Api || typeof opts.Api.apiFetch !== 'function') return;
      confirm.disabled = true;
      cancel.disabled = true;
      errMsg.style.display = 'none';
      opts.Api.apiFetch('/api/account', { method: 'DELETE', body: { password: pw.input.value } })
        .then(function () {
          // Account (and its session) no longer exists server-side — reuse the app's real
          // logout path (deps.logout, wired in app.js) so the browser's stored token is
          // cleared and the page reloads back to the signed-out entry screen, exactly like
          // any other logout. Its own best-effort POST /api/logout will just no-op/404
          // since the user is already gone — logout()'s .then(finish, finish) tolerates that.
          if (typeof opts.logout === 'function') { closeModal(); opts.logout(); }
          else { closeModal(); }
        })
        .catch(function (err) {
          var msg = (err && err.body && err.body.error) || '';
          Escape.setText(errMsg, msg === 'wrong password' ? 'Wrong password — try again.'
            : msg ? msg : 'Could not delete your account. Please try again.');
          errMsg.style.display = '';
          cancel.disabled = false;
          refreshEnabled();
        });
    });

    document.body.appendChild(overlay);
    pw.input.focus();
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

    // --- Account settings (real) ---
    var acc = collapsible('Account settings', true);

    // Account identity + plan summary (2026-08-08) — opts.config.account_info comes from
    // /api/config's real session lookup (routes/expenses.js), null for a signed-out/guest/
    // business session. A compact glance only — the full usage bar + upgrade button stays
    // in the separate "Plan & billing" section below, not duplicated here.
    var accountInfo = opts.config && opts.config.account_info;
    if (accountInfo) {
      acc.body.appendChild(setRow('Email', null, valueChip(accountInfo.email || '')));
      if (accountInfo.created_at) {
        var joined = new Date(accountInfo.created_at);
        var joinedText = isNaN(joined.getTime()) ? '' : joined.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        if (joinedText) acc.body.appendChild(setRow('Member since', null, valueChip(joinedText)));
      }
      var usage = opts.config.plan_usage;
      var planLabel = (opts.config.plan === 'pro') ? 'Pro plan'
        : 'Free plan' + (usage ? ' · ' + usage.used + '/' + usage.limit + ' receipts this month' : '');
      acc.body.appendChild(setRow('Plan', null, valueChip(planLabel)));

      // Telegram connect status (2026-08-08) — reachable ANY time now, not just once during
      // onboarding. The connect link (bind_token) is permanent (schema.sql migration), so
      // there's no "expired link" case to handle here — just connected vs. not-yet.
      if (accountInfo.telegram_connected) {
        acc.body.appendChild(setRow('Telegram', null, valueChip('Connected')));
      } else {
        var connectBtn = el('a', 'set-btn set-btn--primary');
        Escape.setText(connectBtn, 'Connect Telegram');
        var botUser = opts.config.bot_username;
        var token = accountInfo.telegram_bind_token;
        if (botUser && token) {
          connectBtn.href = 'https://t.me/' + botUser + '?start=' + encodeURIComponent(token);
          connectBtn.target = '_blank';
          connectBtn.rel = 'noopener';
        }
        acc.body.appendChild(setRow('Telegram', 'Not connected yet — tap to open the bot.', connectBtn));
      }

      // Delete account (2026-08-09): the backend (DELETE /api/account, routes/auth.js) has
      // existed and worked for a while — this button/modal is the missing frontend half.
      // Owner-only (accountInfo is null for anyone else — business/guest/signed-out), same
      // gate as the rest of this block.
      var delBtn = el('button', 'set-btn set-btn--danger');
      Escape.setText(delBtn, 'Delete account');
      delBtn.addEventListener('click', function () { openDeleteAccountModal(opts); });
      acc.body.appendChild(setRow('Delete account', 'Permanently deletes your account, every receipt, and your Telegram connection. This cannot be undone.', delBtn));
    }

    rootEl.appendChild(acc.el);

    // --- Appearance (real: theme) ---
    // 2026-07-27 (Barat: "only dark mode and light mode, remove other modes"):
    // personal accounts get just two options — the blue/white palette (CSS class
    // theme-ocean, but presented here simply as "Light" — that IS the personal
    // brand now, matching Landing/Login/Onboarding) and Dark. Business (multiUser)
    // is completely unchanged: the original three (Light/Warm/Dark) — this file
    // is shared with the live Premala dashboard, which never asked for this.
    var isPersonal = !!(opts.config && opts.config.personal_auth);
    var app = collapsible('Appearance', false);
    var themeSel = pick(
      isPersonal
        ? [['ocean', 'Light'], ['ocean-dark', 'Dark']]
        : [['light', 'Light'], ['warm', 'Warm'], ['dark', 'Dark']],
      currentTheme(),
      function (v) { if (typeof opts.setTheme === 'function') opts.setTheme(v); }
    );
    // Hook class so app.js can keep this dropdown in sync when the header's
    // theme icon (a full cycle, not this dropdown) changes the theme —
    // this view is built once at boot and never re-rendered, so without this
    // the select would show a stale value after the icon is clicked.
    themeSel.classList.add('set-select--theme');
    app.body.appendChild(setRow('Theme', isPersonal ? 'Light or dark. Saved to this browser.' : 'Light, warm, or dark forest. Saved to this browser.', themeSel));
    // Default page (real, wired to app.js's storedDefaultView/setDefaultView):
    // which view opens on a fresh launch. Options are whatever THIS boot's
    // section list actually is (opts.sections, business vs personal) — never
    // offer a view that doesn't exist right now.
    if (Array.isArray(opts.sections) && opts.sections.length) {
      var viewOptions = opts.sections.map(function (s) { return [s.id, s.label]; });
      var landingSel = pick(viewOptions, opts.defaultView || opts.sections[0].id, function (v) {
        if (typeof opts.setDefaultView === 'function') opts.setDefaultView(v);
      });
      app.body.appendChild(setRow('Default page', 'Which page opens when you launch the dashboard fresh.', landingSel));
    }
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
    // PREVIEW (2026-07-25): "Account currency" is planned to become real-editable
    // (see plan file — new account_settings key + a background reconversion job
    // that re-derives every receipt from its ORIGINAL amount using that receipt's
    // own historical FX rate, never today's rate applied to an old purchase).
    // Not built yet — this is a UI-only demo of the dropdown + the "in progress"
    // banner, wired to opts.onCurrencyChange if the host supplies one, otherwise
    // just simulates the flow locally so the design can be reviewed.
    var cur = collapsible('Currency & display', false);
    var currentCurrency = model.currency;
    var currencyBanner = el('p', 'set-currency-banner muted');
    currencyBanner.hidden = true;
    function simulateReconvert(newCur) {
      currencyBanner.hidden = false;
      Escape.setText(currencyBanner, 'Updating your numbers to ' + newCur + '… recalculating every receipt using its own historical exchange rate.');
      var run = function () {
        Escape.setText(currencyBanner, 'Done — all receipts now shown in ' + newCur + '.');
        setTimeout(function () { currencyBanner.hidden = true; }, 3000);
      };
      if (typeof opts.onCurrencyChange === 'function') {
        opts.onCurrencyChange(newCur).then(run).catch(function (err) {
          Escape.setText(currencyBanner, (err && err.message) || 'Could not update currency. Please try again.');
        });
      } else {
        setTimeout(run, 1200); // preview-only simulated delay
      }
    }
    var currencySel = pick(
      [['MYR', 'MYR — Malaysian Ringgit'], ['USD', 'USD — US Dollar'], ['SGD', 'SGD — Singapore Dollar'], ['EUR', 'EUR — Euro'], ['GBP', 'GBP — British Pound']],
      currentCurrency,
      function (v) { if (v !== currentCurrency) { currentCurrency = v; simulateReconvert(v); } }
    );
    cur.body.appendChild(setRow('Account currency', 'Every receipt is shown in this currency — changing it re-converts your full history, not just new receipts.', currencySel));
    cur.body.appendChild(currencyBanner);
    cur.body.appendChild(setRow('Date format', 'How dates display across the dashboard.', pick([['iso', 'YYYY-MM-DD'], ['dmy', 'DD/MM/YYYY'], ['mdy', 'MMM D, YYYY']], 'iso'), true));
    rootEl.appendChild(cur.el);

    // --- Plan & billing (2026-07-28: `planName` is real — opts.config.plan comes from
    // users.plan via /api/config, see routes/expenses.js; feeds the real Export PDF gate in
    // grid.js. 2026-07-30: the Upgrade buttons below are now real too — POST
    // /api/billing/checkout (routes/billing.js) creates a HitPay recurring-billing
    // subscription and returns a hosted checkout URL to redirect to. Usage/receipt-count
    // numbers below are STILL a mock placeholder — no per-month counter UI exists yet;
    // separate from the real enforcement, which already runs server-side (lib/billing.js).) ---
    var billing = collapsible('Plan & billing', false);
    var planName = (opts.config && opts.config.plan === 'pro') ? 'Pro' : 'Free';
    var used = (opts.plan && opts.plan.receiptsUsed != null) ? opts.plan.receiptsUsed : 14;
    var limit = (opts.plan && opts.plan.receiptsLimit != null) ? opts.plan.receiptsLimit : 20;
    billing.body.appendChild(setRow('Current plan', 'Free plan limits: 20 receipts/month, 1 photo at a time.', valueChip(planName)));
    var usageWrap = el('div', 'set-usage');
    var usageBar = el('div', 'set-usage-track');
    var usageFill = el('div', 'set-usage-fill');
    usageFill.style.width = Math.min(100, Math.round((used / limit) * 100)) + '%';
    usageBar.appendChild(usageFill);
    usageWrap.appendChild(usageBar);
    usageWrap.appendChild(text('span', 'set-usage-label', used + ' / ' + limit + ' receipts used this month'));
    billing.body.appendChild(usageWrap);
    var upgradePanel = el('div', 'set-upgrade-panel');
    upgradePanel.hidden = true;
    var upgradeBtn = el('button', 'set-btn set-btn--primary');
    Escape.setText(upgradeBtn, planName === 'Pro' ? 'Manage plan' : 'Upgrade to Pro');
    upgradeBtn.addEventListener('click', function () { upgradePanel.hidden = !upgradePanel.hidden; });
    billing.body.appendChild(setRow('Upgrade', 'RM 12.90/month or RM 99/year — unlimited receipts, priority processing.', upgradeBtn));
    // Billing cycle choice — payment METHOD (FPX/card/etc.) is chosen on HitPay's own hosted
    // checkout page, not here, so this only needs to ask monthly vs yearly.
    [['Monthly — RM 12.90', 'monthly'], ['Yearly — RM 99 (save ~36%)', 'yearly']].forEach(function (pair) {
      var b = el('button', 'set-btn set-btn--ghost');
      Escape.setText(b, pair[0]);
      var status = text('span', 'set-upgrade-status muted', '');
      b.addEventListener('click', function () {
        if (planName === 'Pro') {
          Escape.setText(status, 'You\'re already on Pro.');
          return;
        }
        if (!Api || typeof Api.apiFetch !== 'function') {
          Escape.setText(status, 'Checkout isn\'t available right now.');
          return;
        }
        b.disabled = true;
        Escape.setText(status, 'Opening checkout…');
        Api.apiFetch('/api/billing/checkout', { method: 'POST', body: { billingCycle: pair[1] } })
          .then(function (res) {
            if (res && res.checkoutUrl) {
              window.location.href = res.checkoutUrl;
            } else {
              b.disabled = false;
              Escape.setText(status, (res && res.message) || 'Could not start checkout.');
            }
          })
          .catch(function (err) {
            b.disabled = false;
            Escape.setText(status, (err && err.body && err.body.message) || 'Could not start checkout. Please try again.');
          });
      });
      var row = el('div', 'set-upgrade-row');
      row.appendChild(b);
      row.appendChild(status);
      upgradePanel.appendChild(row);
    });
    billing.body.appendChild(upgradePanel);
    rootEl.appendChild(billing.el);

    function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }

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
    about.body.appendChild(setRow('AutoReceipt Dashboard', 'Treehouse design · Mugi.', valueChip('v0.2')));
    rootEl.appendChild(about.el);

    // --- Session (real) --- moved to the last section of the page (2026-08-09, Barat:
    // "remove logout option from here [Account settings] and give logout option in
    // settings page last column") — was previously the first row under Account settings,
    // grouped too close to the account identity info. Same exact button/behavior, just
    // relocated to the bottom of the page.
    var sess = collapsible('Logout', false);
    var isPersonal = !!(opts.config && opts.config.personal_auth);
    var authBtn = el('button', model.signedIn
      ? 'set-btn ' + (isPersonal ? 'set-btn--primary' : 'set-btn--danger')
      : 'set-btn set-btn--primary');
    Escape.setText(authBtn, model.signedIn ? 'Log out' : 'Log in');
    // Bug fix: this used to call opts.logout() unconditionally — even when the
    // button read "Log in" — so clicking "Log in" silently cleared the (already
    // empty) token and reloaded, landing back on Overview with nothing entered.
    // Branch on sign-in state: signed in -> log out; signed out -> show the
    // real token-entry gate (opts.login).
    authBtn.addEventListener('click', function () {
      if (model.signedIn) {
        if (typeof opts.logout === 'function') opts.logout();
      } else {
        if (typeof opts.login === 'function') opts.login();
      }
    });
    sess.body.appendChild(setRow(
      'Session',
      model.signedIn ? 'You are signed in on this device.'
        : (model.authRequired ? 'Not signed in.' : 'This dashboard is open (no token required in dev).'),
      authBtn
    ));
    rootEl.appendChild(sess.el);

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
