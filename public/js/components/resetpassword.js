// components/resetpassword.js — "Forgot password?" flow (2026-07-27), personal
// (personalAuth) accounts only. Two screens:
//   'request' — email in, POST /api/forgot-password, ALWAYS shows the same generic
//     confirmation ("if that email has an account...") — never reveals whether the
//     account exists (matches the backend's own no-enumeration contract exactly;
//     this screen must not "cheat" by showing a different message on any path).
//   'reset'   — reached via a link with ?reset_token=<token> in the URL. New
//     password in, POST /api/reset-password with the token. On success: a plain
//     confirmation + "Sign in" link — deliberately does NOT auto-login (the
//     password reset already revokes every existing session server-side; forcing
//     a fresh explicit sign-in is the safer default, not a shortcut).
//
// Same conventions as onboarding.js/login.js: pure DOM (createElement/textContent,
// Escape.setText for all dynamic text), UMD shim, .onboard-* CSS classes (same
// blue/white card look as the rest of the personal-mode entry flow).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'));
  } else {
    root.ResetPassword = factory(root.Escape);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // validateEmail(email) -> { ok:true } | { ok:false, error }. Same loose "obviously
  // an email" check as onboarding.js's signup form — the server is always the real gate.
  function validateEmail(email) {
    var e = (email === null || email === undefined ? '' : String(email)).trim();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'Enter a valid email address.' };
    return { ok: true, email: e };
  }

  // validateNewPassword(password, confirm) -> { ok:true } | { ok:false, error }.
  // Mirrors the server's passwordPolicy MINIMUM (10 chars, letters+digits) so the form
  // fails fast — the server is still the real gate (same policy, re-checked there).
  function validateNewPassword(password, confirm) {
    var p = password === null || password === undefined ? '' : String(password);
    var c = confirm === null || confirm === undefined ? '' : String(confirm);
    if (p.length < 10) return { ok: false, error: 'Password must be at least 10 characters.' };
    if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return { ok: false, error: 'Password must include letters and digits.' };
    if (p !== c) return { ok: false, error: 'Passwords do not match.' };
    return { ok: true, password: p };
  }

  function card() {
    var root = el('div', 'onboard-root');
    var card = el('div', 'onboard-card');
    root.appendChild(card);
    return { root: root, card: card };
  }

  // --- 'request' screen ---
  function renderRequest(container, opts) {
    var parts = card();
    var wrap = el('div', 'onboard-step');
    var badge = el('div', 'onboard-badge'); badge.textContent = '🔑';
    wrap.appendChild(badge);
    wrap.appendChild(text('h1', 'onboard-title', 'Reset your password'));
    wrap.appendChild(text('p', 'onboard-sub', "Enter your account email and we'll send you a reset link."));

    var done = el('div', 'onboard-step');
    done.hidden = true;
    done.appendChild(text('h1', 'onboard-title onboard-title--sm', 'Check your email'));
    done.appendChild(text('p', 'onboard-sub', 'If that email has an account, a reset link has been sent. It expires in 1 hour.'));
    var backBtn1 = text('button', 'onboard-btn onboard-btn--primary', 'Back to sign in');
    backBtn1.type = 'button';
    backBtn1.addEventListener('click', function () { if (typeof opts.onBackToLogin === 'function') opts.onBackToLogin(); });
    done.appendChild(backBtn1);

    var form = el('form', 'onboard-form');
    var emailLabel = text('label', 'onboard-label', 'Email');
    var emailInput = el('input', 'onboard-input');
    emailInput.type = 'email';
    emailInput.autocomplete = 'email';
    emailInput.placeholder = 'you@example.com';
    form.appendChild(emailLabel);
    form.appendChild(emailInput);

    var errorMsg = text('p', 'onboard-error', '');
    errorMsg.hidden = true;
    form.appendChild(errorMsg);

    var submit = text('button', 'onboard-btn onboard-btn--primary', 'Send reset link');
    submit.type = 'submit';
    form.appendChild(submit);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var check = validateEmail(emailInput.value);
      if (!check.ok) { errorMsg.hidden = false; Escape.setText(errorMsg, check.error); return; }
      submit.disabled = true;
      errorMsg.hidden = true;
      Escape.setText(submit, 'Sending…');
      opts.Api.apiFetch('/api/forgot-password', { method: 'POST', body: { email: check.email } })
        .then(function () {
          wrap.hidden = true;
          done.hidden = false;
        })
        .catch(function (err) {
          submit.disabled = false;
          Escape.setText(submit, 'Send reset link');
          errorMsg.hidden = false;
          var friendly = err && err.status === 429 ? 'Too many attempts — please wait a minute and try again.'
            : 'Could not send the reset link. Please try again shortly.';
          Escape.setText(errorMsg, friendly);
        });
    });
    wrap.appendChild(form);

    var backLink = text('button', 'onboard-skip', 'Back to sign in');
    backLink.type = 'button';
    backLink.addEventListener('click', function () { if (typeof opts.onBackToLogin === 'function') opts.onBackToLogin(); });
    wrap.appendChild(backLink);

    parts.card.appendChild(wrap);
    parts.card.appendChild(done);
    clear(container);
    container.appendChild(parts.root);
  }

  // --- 'reset' screen (?reset_token=... in the URL) ---
  function renderReset(container, opts) {
    var parts = card();
    var wrap = el('div', 'onboard-step');
    var badge = el('div', 'onboard-badge'); badge.textContent = '🔒';
    wrap.appendChild(badge);
    wrap.appendChild(text('h1', 'onboard-title', 'Set a new password'));
    wrap.appendChild(text('p', 'onboard-sub', 'At least 10 characters, with letters and digits.'));

    var done = el('div', 'onboard-step');
    done.hidden = true;
    done.appendChild(text('h1', 'onboard-title onboard-title--sm', 'Password changed'));
    done.appendChild(text('p', 'onboard-sub', "You're signed out everywhere for safety — sign in with your new password."));
    var toLogin = text('button', 'onboard-btn onboard-btn--primary', 'Sign in');
    toLogin.type = 'button';
    toLogin.addEventListener('click', function () { if (typeof opts.onBackToLogin === 'function') opts.onBackToLogin(); });
    done.appendChild(toLogin);

    var form = el('form', 'onboard-form');
    var pwLabel = text('label', 'onboard-label', 'New password');
    var pwInput = el('input', 'onboard-input');
    pwInput.type = 'password';
    pwInput.autocomplete = 'new-password';
    pwInput.placeholder = 'At least 10 characters';
    form.appendChild(pwLabel);
    form.appendChild(pwInput);

    var confirmLabel = text('label', 'onboard-label', 'Confirm password');
    var confirmInput = el('input', 'onboard-input');
    confirmInput.type = 'password';
    confirmInput.autocomplete = 'new-password';
    confirmInput.placeholder = 'Re-enter the password';
    form.appendChild(confirmLabel);
    form.appendChild(confirmInput);

    var errorMsg = text('p', 'onboard-error', '');
    errorMsg.hidden = true;
    form.appendChild(errorMsg);

    var submit = text('button', 'onboard-btn onboard-btn--primary', 'Reset password');
    submit.type = 'submit';
    form.appendChild(submit);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var check = validateNewPassword(pwInput.value, confirmInput.value);
      if (!check.ok) { errorMsg.hidden = false; Escape.setText(errorMsg, check.error); return; }
      submit.disabled = true;
      errorMsg.hidden = true;
      Escape.setText(submit, 'Resetting…');
      opts.Api.apiFetch('/api/reset-password', { method: 'POST', body: { token: opts.token, password: check.password } })
        .then(function () {
          wrap.hidden = true;
          done.hidden = false;
        })
        .catch(function (err) {
          submit.disabled = false;
          Escape.setText(submit, 'Reset password');
          errorMsg.hidden = false;
          var friendly = (err && err.body && err.body.error) ? err.body.error
            : err && err.status === 429 ? 'Too many attempts — please wait a minute and try again.'
            : 'Could not reset your password. Please try again shortly.';
          Escape.setText(errorMsg, friendly);
        });
    });
    wrap.appendChild(form);

    var requestNewLink = text('button', 'onboard-skip', 'Request a new link');
    requestNewLink.type = 'button';
    requestNewLink.addEventListener('click', function () { if (typeof opts.onRequestNewLink === 'function') opts.onRequestNewLink(); });
    wrap.appendChild(requestNewLink);

    parts.card.appendChild(wrap);
    parts.card.appendChild(done);
    clear(container);
    container.appendChild(parts.root);
  }

  // mount(container, opts) -> void
  //   opts.mode            — 'request' | 'reset'
  //   opts.token            — the raw reset token (mode 'reset' only)
  //   opts.Api              — the shared Api module (apiFetch)
  //   opts.onBackToLogin()  — go back to the sign-in screen
  //   opts.onRequestNewLink() — (mode 'reset' only) go to the 'request' screen instead
  function mount(container, opts) {
    if (!hasDom() || !container) return;
    opts = opts || {};
    if (document.body) document.body.classList.add('onboard-mode'); // same blue/white as Login/Onboarding
    if (opts.mode === 'reset') renderReset(container, opts);
    else renderRequest(container, opts);
  }

  return { mount: mount, validateEmail: validateEmail, validateNewPassword: validateNewPassword };
});
