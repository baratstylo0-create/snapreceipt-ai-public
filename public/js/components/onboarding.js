// components/onboarding.js — first-time "get connected" flow (Phase 0).
//
// Four steps, shown once on a fresh personal-mode launch:
//   1. Create account — email + password. HARD RULE: nothing past this step is
//      reachable until this succeeds — the Telegram bot itself refuses every
//      photo until the account exists and the chat is bound (enforced
//      server-side in lib/bot.js; this screen is the front door to that gate).
//   2. Welcome     — what the app does, a 3-step preview.
//   3. Connect     — deep-link to the Telegram bot; polls for the first
//                    real receipt and shows it inline the moment it lands
//                    (proof it works, before asking for anything else).
//   4. You're set  — quick tab highlight, then into the real dashboard.
//
// Same conventions as every other component: pure DOM (createElement/
// textContent, never innerHTML), all untrusted/dynamic text via Escape,
// UMD shim so the pure step-state helper is unit-testable without a DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'));
  } else {
    root.Onboarding = factory(root.Escape, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };

  var STEPS = ['signup', 'welcome', 'connect', 'done'];

  // ---- pure helpers (unit-testable without a DOM) --------------------------

  function nextStep(current) {
    var i = STEPS.indexOf(current);
    if (i === -1 || i === STEPS.length - 1) return current;
    return STEPS[i + 1];
  }

  // Has a real receipt shown up yet? Tolerant of a missing/garbage response —
  // never throws, never treats junk as "yes".
  function hasFirstReceipt(expensesResponse) {
    var rows = expensesResponse && Array.isArray(expensesResponse.rows) ? expensesResponse.rows
      : (Array.isArray(expensesResponse) ? expensesResponse : null);
    return !!(rows && rows.length > 0);
  }

  function telegramDeepLink(botUsername, bindToken) {
    var u = (botUsername || '').replace(/^@/, '').trim();
    if (!u) return null;
    return bindToken ? 'https://t.me/' + u + '?start=' + bindToken : 'https://t.me/' + u;
  }

  // validateSignup(email, password) -> { ok:true } | { ok:false, error }
  // Simple, client-side, fail-fast checks only — the server is always the real
  // gate (this just avoids a pointless round-trip for an empty box or an
  // obviously-not-an-email string). Never throws.
  function validateSignup(email, password) {
    var e = (email === null || email === undefined ? '' : String(email)).trim();
    var p = password === null || password === undefined ? '' : String(password);
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: t('onboarding.invalid_email') };
    if (!p || p.length < 8) return { ok: false, error: t('onboarding.password_too_short') };
    return { ok: true };
  }

  // ---- DOM helpers -----------------------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }

  function stepDots(active) {
    var wrap = el('div', 'onboard-dots');
    STEPS.forEach(function (s) {
      var d = el('span', 'onboard-dot' + (s === active ? ' is-active' : ''));
      wrap.appendChild(d);
    });
    return wrap;
  }

  // ---- render layer ------------------------------------------------------

  // mount(container, opts) -> { el, destroy }
  //   opts.botUsername   — e.g. "Receiptreader56bot"
  //   opts.Api            — the shared Api module (apiFetch), for polling
  //   opts.pollMs         — how often to check for the first receipt (default 3000)
  //   opts.onSignup(email, password) -> Promise<{ bindToken? }>  — REQUIRED gate.
  //     Rejects with an Error whose .message is safe to show the user (e.g.
  //     "an account with that email already exists"). Nothing past this step
  //     renders until this resolves.
  //   opts.onFinished()   — called when the user reaches "Go to Dashboard"
  //   opts.onSkip()        — called if they skip the Connect step early
  //   opts.startStep      — Guest Mode (2026-07-28): skip the 'signup' step and start at any
  //     other STEPS value (e.g. 'connect') when the caller already has a session + bind_token
  //     in hand (guest signup, unlike real signup, needs no email/password form at all).
  //     Ignored (falls back to 'signup') for any value not in STEPS.
  //   opts.bindToken      — pre-supplied bind_token to pair with opts.startStep — normally
  //     this only gets set once renderSignup's onSignup() resolves; a caller starting past
  //     that step must supply it directly instead.
  function mount(container, opts) {
    if (!hasDom() || !container) return null;
    opts = opts || {};
    var pollMs = opts.pollMs || 3000;
    var pollTimer = null;
    var step = (opts.startStep && STEPS.indexOf(opts.startStep) !== -1) ? opts.startStep : 'signup';
    var bindToken = opts.bindToken || null;

    var root = el('div', 'onboard-root');
    container.appendChild(root);
    // Same blue/white identity as the Landing screen before this one (2026-07-27) —
    // see onboarding.css's body.onboard-mode block for the token overrides.
    if (document.body) document.body.classList.add('onboard-mode');

    function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

    function render() {
      clear(root);
      var card = el('div', 'onboard-card');
      card.appendChild(stepDots(step));
      // The product-proof visual (donut/hero shot) now lives on the Landing screen
      // shown BEFORE this step (2026-07-27) — Create account stays a single focused
      // form, not a repeat of the same pitch.
      if (step === 'signup') card.appendChild(renderSignup());
      else if (step === 'welcome') card.appendChild(renderWelcome());
      else if (step === 'connect') card.appendChild(renderConnect());
      else card.appendChild(renderDone());
      root.appendChild(card);
    }

    function goTo(s) { stopPolling(); step = s; render(); }

    // Guest Mode explainer popup (2026-07-28) — a small overlay explaining what guest mode
    // is/isn't BEFORE it starts (no bait-and-switch: cap, disposability, and the sign-up
    // path are all stated up front). Same standalone-overlay pattern as grid.js's Export-PDF
    // paywall (this app has no shared modal host to reuse — every component that needs one
    // builds its own). Appended to document.body (not `root`) so it floats above the whole
    // onboarding card, dismissed by its own Cancel, the backdrop, or Escape.
    function showGuestExplainer() {
      var host = el('div', 'onboard-guest-explainer-host');
      var card = el('div', 'onboard-guest-explainer-card');
      card.appendChild(text('div', 'onboard-guest-explainer-badge', '🕒'));
      card.appendChild(text('h2', 'onboard-guest-explainer-title', t('onboarding.guest_explainer_title')));
      var body = el('ul', 'onboard-guest-explainer-list');
      [
        t('onboarding.guest_explainer_1'),
        t('onboarding.guest_explainer_2'),
        t('onboarding.guest_explainer_3'),
        t('onboarding.guest_explainer_4')
      ].forEach(function (line) {
        body.appendChild(text('li', '', line));
      });
      card.appendChild(body);

      var actions = el('div', 'onboard-guest-explainer-actions');
      var cancelBtn = text('button', 'onboard-btn onboard-btn--secondary', t('onboarding.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', close);
      var continueBtn = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.continue'));
      continueBtn.type = 'button';
      continueBtn.addEventListener('click', function () {
        close();
        opts.onGuest();
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(continueBtn);
      card.appendChild(actions);

      host.appendChild(card);
      host.addEventListener('click', function (ev) { if (ev.target === host) close(); });
      function onKey(ev) { if (ev.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      function close() {
        document.removeEventListener('keydown', onKey);
        if (host.parentNode) host.parentNode.removeChild(host);
      }
      document.body.appendChild(host);
    }

    // --- Create account (hard gate — nothing else is reachable without this) ---
    function renderSignup() {
      var wrap = el('div', 'onboard-step onboard-signup');
      var badge = el('div', 'onboard-badge'); badge.textContent = '🔒';
      wrap.appendChild(badge);
      wrap.appendChild(text('h1', 'onboard-title', t('onboarding.create_account')));

      // Google sign-in (wired to the real backend 2026-07-30) — opts.onGoogleSignup
      // is a PLAIN function (not a Promise): clicking it navigates the whole page to
      // GET /api/auth/google?intent=signup, which redirects to Google's consent
      // screen and back. There is no in-page result to await here — app.js's boot()
      // picks up the #gauth_token=... fragment on the next page load and finishes
      // the flow (new account -> straight to the Connect-Telegram step).
      var googleBtn = el('button', 'onboard-btn onboard-btn--google');
      googleBtn.type = 'button';
      var gIcon = el('span', 'onboard-google-icon');
      gIcon.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">'
        + '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.61z"/>'
        + '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>'
        + '<path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>'
        + '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>'
        + '</svg>';
      googleBtn.appendChild(gIcon);
      googleBtn.appendChild(text('span', '', t('onboarding.google_signup')));
      var googleError = text('p', 'onboard-error', '');
      googleError.hidden = true;
      googleBtn.addEventListener('click', function () {
        // BUG FIX (2026-07-27): this used to silently `goTo('welcome')` — advancing
        // the wizard as if Google sign-in had succeeded, with NO real account and NO
        // token ever set. A user who clicked this FIRST (it's the top, most obvious
        // button) could walk all the way to "Go to Dashboard" and land in the real
        // app shell with no valid session — every real data call then 401s, showing
        // as "Could not load your expenses"/"...review queue" with no indication why.
        // This is the most likely explanation for exactly that report earlier this
        // session. Real Google OAuth still isn't built (needs a Google Cloud project +
        // client ID/secret + a backend callback route) — until it is, be honest
        // instead of faking success.
        if (typeof opts.onGoogleSignup !== 'function') {
          googleError.hidden = false;
          Escape.setText(googleError, t('login.google_unavailable'));
          return;
        }
        googleBtn.disabled = true;
        googleError.hidden = true;
        opts.onGoogleSignup(); // navigates away — no promise to await, see comment above
      });
      wrap.appendChild(googleBtn);
      wrap.appendChild(googleError);

      // Guest Mode (2026-07-28): a small, lower-emphasis button directly under Google —
      // Barat's placement + interaction spec: a compact box here, and clicking it opens an
      // explainer popup (what guest mode is/isn't) with its own "Continue" to actually start
      // it, rather than jumping straight in. Only rendered when the caller passes opts.onGuest
      // (mountOnboarding only does when cfg.guest_mode is on) — an un-flagged deployment is
      // byte-for-byte unchanged.
      if (opts.onGuest) {
        var guestBtn = text('button', 'onboard-btn onboard-btn--guest', t('onboarding.guest'));
        guestBtn.type = 'button';
        guestBtn.addEventListener('click', function () { showGuestExplainer(); });
        wrap.appendChild(guestBtn);
      }

      var divider = el('div', 'onboard-divider');
      divider.appendChild(text('span', '', t('onboarding.or')));
      wrap.appendChild(divider);

      var form = el('form', 'onboard-form');

      var emailLabel = text('label', 'onboard-label', t('onboarding.email'));
      var emailInput = el('input', 'onboard-input');
      emailInput.type = 'email';
      emailInput.autocomplete = 'email';
      emailInput.placeholder = 'you@example.com';
      form.appendChild(emailLabel);
      form.appendChild(emailInput);

      var pwLabel = text('label', 'onboard-label', t('onboarding.password'));
      var pwInput = el('input', 'onboard-input');
      pwInput.type = 'password';
      pwInput.autocomplete = 'new-password';
      pwInput.placeholder = t('onboarding.password_hint');
      form.appendChild(pwLabel);
      form.appendChild(pwInput);

      var errorMsg = text('p', 'onboard-error', '');
      errorMsg.hidden = true;
      form.appendChild(errorMsg);

      var submit = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.create_account_btn'));
      submit.type = 'submit';
      form.appendChild(submit);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var check = validateSignup(emailInput.value, pwInput.value);
        if (!check.ok) { errorMsg.hidden = false; Escape.setText(errorMsg, check.error); return; }
        if (typeof opts.onSignup !== 'function') { goTo('welcome'); return; } // preview/no-backend mode
        submit.disabled = true;
        errorMsg.hidden = true;
        Escape.setText(submit, t('onboarding.creating_account'));
        opts.onSignup(emailInput.value.trim(), pwInput.value).then(function (result) {
          bindToken = (result && result.bindToken) || null;
          goTo('welcome');
        }).catch(function (err) {
          submit.disabled = false;
          Escape.setText(submit, t('onboarding.create_account_btn'));
          errorMsg.hidden = false;
          Escape.setText(errorMsg, (err && err.message) || t('onboarding.signup_failed'));
        });
      });

      wrap.appendChild(form);

      // "Already have an account? Log in" (2026-07-28) — mirrors login.js's "Don't have an
      // account yet? Sign up now" link exactly, so both entry points are symmetric.
      if (opts.onLogin) {
        var loginRow = el('p', 'login-register-row');
        loginRow.appendChild(document.createTextNode(t('onboarding.already_have_account')));
        var loginLink = el('button', 'login-register-link');
        loginLink.type = 'button';
        loginLink.textContent = t('onboarding.log_in');
        loginLink.addEventListener('click', function () { opts.onLogin(); });
        loginRow.appendChild(loginLink);
        wrap.appendChild(loginRow);
      }

      return wrap;
    }

    // --- Welcome ---
    function renderWelcome() {
      var wrap = el('div', 'onboard-step onboard-welcome');
      var badge = el('div', 'onboard-badge'); badge.textContent = '🌿';
      wrap.appendChild(badge);
      wrap.appendChild(text('h1', 'onboard-title', t('onboarding.welcome_title')));
      wrap.appendChild(text('p', 'onboard-sub', t('onboarding.welcome_sub')));

      var list = el('ol', 'onboard-steps-list');
      [
        t('onboarding.welcome_step1'),
        t('onboarding.welcome_step2'),
        t('onboarding.welcome_step3')
      ].forEach(function (label, i) {
        var li = el('li', 'onboard-steps-item');
        var num = el('span', 'onboard-steps-num'); num.textContent = String(i + 1);
        li.appendChild(num);
        li.appendChild(text('span', 'onboard-steps-label', label));
        list.appendChild(li);
      });
      wrap.appendChild(list);

      var cta = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.get_connected'));
      cta.type = 'button';
      cta.addEventListener('click', function () { goTo('connect'); });
      wrap.appendChild(cta);
      return wrap;
    }

    // --- Connect ---
    function renderConnect() {
      var wrap = el('div', 'onboard-step onboard-connect');
      wrap.appendChild(text('h1', 'onboard-title onboard-title--sm', t('onboarding.connect_title')));
      wrap.appendChild(text('p', 'onboard-sub', t('onboarding.connect_sub')));

      var link = telegramDeepLink(opts.botUsername, bindToken);
      var openBtn = text('a', 'onboard-btn onboard-btn--primary onboard-telegram-btn', t('onboarding.open_telegram'));
      if (link) { openBtn.href = link; openBtn.target = '_blank'; openBtn.rel = 'noopener noreferrer'; }
      else { openBtn.setAttribute('aria-disabled', 'true'); }
      wrap.appendChild(openBtn);

      if (opts.botUsername) {
        var chip = text('span', 'onboard-bot-chip', '@' + opts.botUsername.replace(/^@/, ''));
        wrap.appendChild(chip);
      }

      var status = el('div', 'onboard-status');
      var dot = el('span', 'onboard-status-dot');
      var statusText = text('span', 'onboard-status-text', t('onboarding.waiting_receipt'));
      status.appendChild(dot);
      status.appendChild(statusText);
      wrap.appendChild(status);

      var result = el('div', 'onboard-result'); result.hidden = true;
      wrap.appendChild(result);

      function showFirstReceipt(row) {
        stopPolling();
        status.classList.add('is-done');
        Escape.setText(dot, '');
        dot.classList.add('is-success');
        Escape.setText(statusText, t('onboarding.got_it'));
        result.hidden = false;
        clear(result);
        var merchant = text('div', 'onboard-result-merchant', (row && row.merchant) || 'Receipt');
        var amount = text('div', 'onboard-result-amount', formatAmount(row));
        result.appendChild(merchant);
        result.appendChild(amount);
        var cta = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.continue'));
        cta.type = 'button';
        cta.addEventListener('click', function () { goTo('done'); });
        result.appendChild(cta);
        // The manual Continue button below is redundant once a receipt is auto-detected —
        // the result panel above has its own Continue.
        manualContinue.hidden = true;
      }

      function poll() {
        if (!opts.Api || typeof opts.Api.apiFetch !== 'function') return; // no backend wired in preview mode
        opts.Api.apiFetch('/api/expenses?limit=1').then(function (res) {
          if (hasFirstReceipt(res)) {
            var rows = res && res.rows ? res.rows : res;
            showFirstReceipt(rows[0]);
          } else {
            pollTimer = setTimeout(poll, pollMs);
          }
        }).catch(function () {
          pollTimer = setTimeout(poll, pollMs); // a transient error just retries; never blocks the flow
        });
      }
      poll();

      // Manual Continue (2026-07-28): dropped the QR code — "Open Telegram" is enough on its
      // own (a phone user just taps the same link; a desktop user opens Telegram directly).
      // This button covers the case where auto-detection (poll() above) hasn't caught up yet
      // by the time the user comes back from Telegram — they don't have to wait for it. Not
      // the same as "I'll do this later" below (which flags them as still-unconnected and
      // shows the persistent Overview reminder); this one means "I already connected."
      var manualContinue = text('button', 'onboard-btn onboard-btn--secondary', t('onboarding.continue'));
      manualContinue.type = 'button';
      manualContinue.addEventListener('click', function () { stopPolling(); goTo('done'); });
      wrap.appendChild(manualContinue);

      var skip = text('button', 'onboard-skip', t('onboarding.do_later'));
      skip.type = 'button';
      skip.addEventListener('click', function () {
        if (typeof opts.onSkip === 'function') opts.onSkip();
        goTo('done');
      });
      wrap.appendChild(skip);
      return wrap;
    }

    // --- Done ---
    function renderDone() {
      var wrap = el('div', 'onboard-step onboard-done');
      var badge = el('div', 'onboard-badge'); badge.textContent = '✅';
      wrap.appendChild(badge);
      wrap.appendChild(text('h1', 'onboard-title', t('onboarding.done_title')));
      wrap.appendChild(text('p', 'onboard-sub', t('onboarding.done_sub')));

      var tabs = [
        [t('onboarding.tab_overview'), t('onboarding.tab_overview_desc')],
        [t('onboarding.tab_activity'), t('onboarding.tab_activity_desc')],
        [t('onboarding.tab_upload'), t('onboarding.tab_upload_desc')],
        [t('onboarding.tab_manage'), t('onboarding.tab_manage_desc')],
        [t('onboarding.tab_settings'), t('onboarding.tab_settings_desc')]
      ];
      var list = el('div', 'onboard-tabs-list');
      tabs.forEach(function (row2) {
        var row = el('div', 'onboard-tabs-row');
        row.appendChild(text('span', 'onboard-tabs-name', row2[0]));
        row.appendChild(text('span', 'onboard-tabs-desc', row2[1]));
        list.appendChild(row);
      });
      wrap.appendChild(list);

      var cta = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.go_to_dashboard'));
      cta.type = 'button';
      cta.addEventListener('click', function () { if (typeof opts.onFinished === 'function') opts.onFinished(); });
      wrap.appendChild(cta);
      return wrap;
    }

    function formatAmount(row) {
      if (!row) return '';
      var amt = row.amount;
      var cur = row.currency || '';
      if (amt === null || amt === undefined || amt === '') return cur;
      return (cur ? cur + ' ' : '') + amt;
    }

    render();
    return { el: root, destroy: function () { stopPolling(); clear(root); } };
  }

  return {
    STEPS: STEPS,
    nextStep: nextStep,
    hasFirstReceipt: hasFirstReceipt,
    telegramDeepLink: telegramDeepLink,
    validateSignup: validateSignup,
    mount: mount
  };
});
