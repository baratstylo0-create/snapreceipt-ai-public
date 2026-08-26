// components/authcard.js — the sliding Sign In / Create Account split card
// (2026-08-25, Barat: reference https://pin.it/65hSccAKx — "Sign In / Sign Up
// in One Page" style). Replaces the separate full-screen Login and Onboarding-
// step-1 screens for PERSONAL accounts only; business (multiUser) admin login
// still uses login.js directly, untouched (see app.js's mountLogin — the
// direct AuthGate 'login' decision passes no opts and never reaches here).
//
// This component owns ONLY the toggle between Sign In and Create Account
// (step 1 of the 4-step onboarding wizard: create account -> welcome ->
// connect Telegram -> done). Once Create Account succeeds, the caller hands
// off to Onboarding.mount(..., { startStep: 'welcome', bindToken }) exactly
// like Guest Mode already does (see app.js's mountGuest) — steps 2-4 stay
// their existing full-screen wizard, unchanged, not part of this card.
//
// Reuses Login.validateCredentials / Onboarding.validateSignup (the pure
// validators those modules already export) rather than re-deriving the
// rules, and reuses onboarding.css's .onboard-input/.onboard-btn/
// .onboard-error/.onboard-divider classes for the actual form fields so they
// stay pixel-identical to the wizard screens that follow. This file's own
// authcard.css only owns the two-panel sliding shell.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'), require('./login'), require('./onboarding'));
  } else {
    root.AuthCard = factory(root.Escape, root.I18n, root.Login, root.Onboarding);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n, Login, Onboarding) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // Same Google "G" mark used by login.js/onboarding.js — kept identical (not
  // shared as a helper across files, matching how those two already duplicate
  // it rather than introducing a new shared module for one inline SVG).
  function googleIconSpan() {
    var gIcon = el('span', 'onboard-google-icon');
    gIcon.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">'
      + '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.61z"/>'
      + '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>'
      + '<path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>'
      + '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>'
      + '</svg>';
    return gIcon;
  }

  // Decorative-only (aria-hidden) icon prefixes for the username/email and
  // password fields — 2026-08-25b visual upgrade. Wraps a given input in an
  // .ac-input-wrap with a small inline SVG icon; input keeps its own
  // onboard-input class/behavior untouched, just gets left padding via CSS.
  function wrapWithIcon(input, kind) {
    var wrap = el('div', 'ac-input-wrap');
    var icon = el('span', 'ac-input-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = kind === 'lock'
      ? '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
      : '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
    wrap.appendChild(icon);
    wrap.appendChild(input);
    return wrap;
  }

  // Decorative-only (aria-hidden) blob shapes layered behind a toggle panel's
  // text content — purely visual, styled entirely in authcard.css (.ac-blob*).
  function appendBlobs(panel) {
    ['ac-blob ac-blob-1', 'ac-blob ac-blob-2', 'ac-blob ac-blob-3'].forEach(function (cls) {
      var b = el('div', cls);
      b.setAttribute('aria-hidden', 'true');
      panel.appendChild(b);
    });
  }

  // mount(container, opts) -> { el, destroy }
  //   opts.initialSide         — 'login' (default) | 'signup'
  //   opts.initialMessage      — optional, shown under the Sign In form up front
  //     (e.g. "Your session expired" — mirrors login.js's `initialMessage` param)
  //   opts.onLogin(username, password) -> Promise<{role, branch_id, display_name}>
  //     REQUIRED. Rejects with an Error whose .message is safe to show the user
  //     (same contract style as opts.onSignup below) — the caller (app.js) owns
  //     the actual /api/login call + token storage + friendly-message mapping.
  //   opts.onLoginSuccess(session) — called after onLogin resolves.
  //   opts.onGoogleLogin()      — optional PLAIN function (not a Promise); omit
  //     entirely when Google auth is off, same as login.js/onboarding.js.
  //   opts.onForgotPassword()   — optional.
  //   opts.onSignup(email, password) -> Promise<{bindToken}> — REQUIRED, same
  //     exact contract as Onboarding.mount's opts.onSignup (reused as-is).
  //   opts.onSignupSuccess(bindToken) — called after onSignup resolves.
  //   opts.onGoogleSignup()     — optional PLAIN function, omit when Google auth is off.
  //   opts.onGuest()            — optional; when present, shows the Guest Mode
  //     explainer popup (same copy/flow as onboarding.js's) before calling this.
  function mount(container, opts) {
    if (!hasDom() || !container) return null;
    opts = opts || {};

    var root = el('div', 'ac-root');
    container.appendChild(root);

    // Decorative-only (aria-hidden) floating circle accents around the card —
    // 2026-08-25b visual upgrade, styled entirely in authcard.css.
    ['ac-circle-1', 'ac-circle-2'].forEach(function (cls) {
      var c = el('div', cls);
      c.setAttribute('aria-hidden', 'true');
      root.appendChild(c);
    });

    var card = el('div', 'ac-card' + (opts.initialSide === 'signup' ? ' is-signup' : ''));

    // ---- Sign In panel ----
    var loginPanel = el('div', 'ac-panel ac-panel--form ac-panel--login');
    (function renderLoginForm() {
      loginPanel.appendChild(text('h1', 'ac-title', t('login.title')));

      var gBtn = el('button', 'onboard-btn onboard-btn--google');
      gBtn.type = 'button';
      gBtn.appendChild(googleIconSpan());
      gBtn.appendChild(text('span', '', t('login.google')));
      var gErr = text('p', 'onboard-error', '');
      gErr.hidden = true;
      gBtn.addEventListener('click', function () {
        if (typeof opts.onGoogleLogin !== 'function') {
          gErr.hidden = false;
          Escape.setText(gErr, t('login.google_unavailable'));
          return;
        }
        gBtn.disabled = true;
        gErr.hidden = true;
        opts.onGoogleLogin(); // navigates away — no promise to await
      });
      loginPanel.appendChild(gBtn);
      loginPanel.appendChild(gErr);

      var div = el('div', 'onboard-divider');
      div.appendChild(text('span', '', t('login.or')));
      loginPanel.appendChild(div);

      var form = el('form', 'ac-form');
      form.appendChild(text('label', 'onboard-label', t('login.username')));
      var uInput = el('input', 'onboard-input');
      uInput.type = 'text';
      uInput.autocomplete = 'username';
      form.appendChild(wrapWithIcon(uInput, 'mail'));

      form.appendChild(text('label', 'onboard-label', t('login.password')));
      var pInput = el('input', 'onboard-input');
      pInput.type = 'password';
      pInput.autocomplete = 'current-password';
      form.appendChild(wrapWithIcon(pInput, 'lock'));

      var forgotRow = el('p', 'login-forgot-row');
      var forgotLink = el('button', 'login-forgot-link');
      forgotLink.type = 'button';
      forgotLink.textContent = t('login.forgot');
      forgotLink.addEventListener('click', function () {
        if (typeof opts.onForgotPassword === 'function') opts.onForgotPassword();
      });
      forgotRow.appendChild(forgotLink);
      form.appendChild(forgotRow);

      var submit = text('button', 'onboard-btn onboard-btn--primary', t('login.submit'));
      submit.type = 'submit';
      form.appendChild(submit);

      var msg = text('p', 'onboard-error', '');
      msg.hidden = !opts.initialMessage;
      if (opts.initialMessage) Escape.setText(msg, opts.initialMessage);
      form.appendChild(msg);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var creds = Login.validateCredentials(uInput.value, pInput.value, t);
        if (!creds.ok) { msg.hidden = false; Escape.setText(msg, creds.error); return; }
        if (typeof opts.onLogin !== 'function') return;
        submit.disabled = true;
        msg.hidden = false;
        Escape.setText(msg, t('login.signing_in'));
        opts.onLogin(creds.username, creds.password).then(function (session) {
          pInput.value = '';
          if (typeof opts.onLoginSuccess === 'function') opts.onLoginSuccess(session);
        }).catch(function (err) {
          submit.disabled = false;
          pInput.value = '';
          msg.hidden = false;
          Escape.setText(msg, (err && err.message) || t('login.sign_in_failed'));
        });
      });

      loginPanel.appendChild(form);
    })();

    // ---- Create Account panel (onboarding step 1 only) ----
    var signupPanel = el('div', 'ac-panel ac-panel--form ac-panel--signup');
    (function renderSignupForm() {
      signupPanel.appendChild(text('h1', 'ac-title', t('onboarding.create_account')));

      var gBtn = el('button', 'onboard-btn onboard-btn--google');
      gBtn.type = 'button';
      gBtn.appendChild(googleIconSpan());
      gBtn.appendChild(text('span', '', t('onboarding.google_signup')));
      var gErr = text('p', 'onboard-error', '');
      gErr.hidden = true;
      gBtn.addEventListener('click', function () {
        if (typeof opts.onGoogleSignup !== 'function') {
          gErr.hidden = false;
          Escape.setText(gErr, t('login.google_unavailable'));
          return;
        }
        gBtn.disabled = true;
        gErr.hidden = true;
        opts.onGoogleSignup();
      });
      signupPanel.appendChild(gBtn);
      signupPanel.appendChild(gErr);

      if (typeof opts.onGuest === 'function') {
        var guestBtn = text('button', 'onboard-btn onboard-btn--guest', t('onboarding.guest'));
        guestBtn.type = 'button';
        guestBtn.addEventListener('click', showGuestExplainer);
        signupPanel.appendChild(guestBtn);
      }

      var div = el('div', 'onboard-divider');
      div.appendChild(text('span', '', t('onboarding.or')));
      signupPanel.appendChild(div);

      var form = el('form', 'ac-form');
      form.appendChild(text('label', 'onboard-label', t('onboarding.email')));
      var eInput = el('input', 'onboard-input');
      eInput.type = 'email';
      eInput.autocomplete = 'email';
      eInput.placeholder = 'you@example.com';
      form.appendChild(wrapWithIcon(eInput, 'mail'));

      form.appendChild(text('label', 'onboard-label', t('onboarding.password')));
      var pInput = el('input', 'onboard-input');
      pInput.type = 'password';
      pInput.autocomplete = 'new-password';
      pInput.placeholder = t('onboarding.password_hint');
      form.appendChild(wrapWithIcon(pInput, 'lock'));

      var errorMsg = text('p', 'onboard-error', '');
      errorMsg.hidden = true;
      form.appendChild(errorMsg);

      var submit = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.create_account_btn'));
      submit.type = 'submit';
      form.appendChild(submit);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var check = Onboarding.validateSignup(eInput.value, pInput.value);
        if (!check.ok) { errorMsg.hidden = false; Escape.setText(errorMsg, check.error); return; }
        if (typeof opts.onSignup !== 'function') return;
        submit.disabled = true;
        errorMsg.hidden = true;
        Escape.setText(submit, t('onboarding.creating_account'));
        opts.onSignup(eInput.value.trim(), pInput.value).then(function (result) {
          if (typeof opts.onSignupSuccess === 'function') opts.onSignupSuccess((result && result.bindToken) || null);
        }).catch(function (err) {
          submit.disabled = false;
          Escape.setText(submit, t('onboarding.create_account_btn'));
          errorMsg.hidden = false;
          Escape.setText(errorMsg, (err && err.message) || t('onboarding.signup_failed'));
        });
      });

      signupPanel.appendChild(form);
    })();

    // ---- Guest Mode explainer popup — copied from onboarding.js's
    // showGuestExplainer (same copy, same onboarding.css classes) since this
    // card's signup panel is a standalone reimplementation of onboarding.js's
    // renderSignup(), not a mount of it. Keep in sync manually if the explainer
    // copy/flow ever changes in onboarding.js. ----
    function showGuestExplainer() {
      var host = el('div', 'onboard-guest-explainer-host');
      var gcard = el('div', 'onboard-guest-explainer-card');
      gcard.appendChild(text('div', 'onboard-guest-explainer-badge', '🕒'));
      gcard.appendChild(text('h2', 'onboard-guest-explainer-title', t('onboarding.guest_explainer_title')));
      var body = el('ul', 'onboard-guest-explainer-list');
      [
        t('onboarding.guest_explainer_1'),
        t('onboarding.guest_explainer_2'),
        t('onboarding.guest_explainer_3'),
        t('onboarding.guest_explainer_4')
      ].forEach(function (line) { body.appendChild(text('li', '', line)); });
      gcard.appendChild(body);

      var actions = el('div', 'onboard-guest-explainer-actions');
      var cancelBtn = text('button', 'onboard-btn onboard-btn--secondary', t('onboarding.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', close);
      var continueBtn = text('button', 'onboard-btn onboard-btn--primary', t('onboarding.continue'));
      continueBtn.type = 'button';
      continueBtn.addEventListener('click', function () { close(); opts.onGuest(); });
      actions.appendChild(cancelBtn);
      actions.appendChild(continueBtn);
      gcard.appendChild(actions);

      host.appendChild(gcard);
      host.addEventListener('click', function (ev) { if (ev.target === host) close(); });
      function onKey(ev) { if (ev.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      function close() {
        document.removeEventListener('keydown', onKey);
        if (host.parentNode) host.parentNode.removeChild(host);
      }
      document.body.appendChild(host);
    }

    // ---- colored toggle panels + mobile fallback links ----
    function setSide(side) { card.classList.toggle('is-signup', side === 'signup'); }

    var toSignupPanel = el('div', 'ac-panel ac-panel--toggle ac-panel--to-signup');
    appendBlobs(toSignupPanel);
    toSignupPanel.appendChild(text('h2', 'ac-toggle-title', t('authcard.new_here')));
    toSignupPanel.appendChild(text('p', 'ac-toggle-sub', t('authcard.new_here_sub')));
    var toSignupBtn = text('button', 'ac-toggle-btn', t('authcard.sign_up_cta'));
    toSignupBtn.type = 'button';
    toSignupBtn.addEventListener('click', function () { setSide('signup'); });
    toSignupPanel.appendChild(toSignupBtn);

    var toLoginPanel = el('div', 'ac-panel ac-panel--toggle ac-panel--to-login');
    appendBlobs(toLoginPanel);
    toLoginPanel.appendChild(text('h2', 'ac-toggle-title', t('authcard.welcome_back')));
    toLoginPanel.appendChild(text('p', 'ac-toggle-sub', t('authcard.welcome_back_sub')));
    var toLoginBtn = text('button', 'ac-toggle-btn', t('authcard.sign_in_cta'));
    toLoginBtn.type = 'button';
    toLoginBtn.addEventListener('click', function () { setSide('login'); });
    toLoginPanel.appendChild(toLoginBtn);

    // Mobile (<=720px, authcard.css hides the sliding colored panels there):
    // a plain text toggle under each form, same two destinations.
    var mobileToLogin = el('p', 'ac-mobile-toggle');
    mobileToLogin.appendChild(document.createTextNode(t('authcard.mobile_have_account')));
    var mobileLoginBtn = text('button', '', t('authcard.sign_in_cta'));
    mobileLoginBtn.type = 'button';
    mobileLoginBtn.addEventListener('click', function () { setSide('login'); });
    mobileToLogin.appendChild(document.createTextNode(' '));
    mobileToLogin.appendChild(mobileLoginBtn);
    signupPanel.appendChild(mobileToLogin);

    var mobileToSignup = el('p', 'ac-mobile-toggle');
    mobileToSignup.appendChild(document.createTextNode(t('authcard.mobile_no_account')));
    var mobileSignupBtn = text('button', '', t('authcard.sign_up_cta'));
    mobileSignupBtn.type = 'button';
    mobileSignupBtn.addEventListener('click', function () { setSide('signup'); });
    mobileToSignup.appendChild(document.createTextNode(' '));
    mobileToSignup.appendChild(mobileSignupBtn);
    loginPanel.appendChild(mobileToSignup);

    card.appendChild(loginPanel);
    card.appendChild(signupPanel);
    card.appendChild(toSignupPanel);
    card.appendChild(toLoginPanel);
    root.appendChild(card);

    return { el: root, destroy: function () { clear(root); } };
  }

  return { mount: mount };
});
