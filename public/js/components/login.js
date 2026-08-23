// components/login.js — the business-mode login screen (ADR-021 Phase 6).
//
// Shown instead of the static token gate when the instance runs multiUser: the
// admin/clerk exchanges username+password (POST /api/login) for an opaque session
// bearer, which is stored exactly like the personal token (sessionStorage, never
// localStorage, never logged) so Api attaches it to every call unchanged. The
// session identity ({ role, branch_id, display_name }) rides back to app.js via
// onEntered so the shell can render role-aware.
//
// Same conventions as the rest of the frontend: pure DOM construction
// (createElement/textContent — never innerHTML with a dynamic value), no inline
// JS/styles (strict CSP), UMD shim so node:test can exercise the pure part.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Login = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure client-side mirror of the server's 400 rule (both fields required) so
  // the form fails fast without a round-trip. Username is trimmed (a copy-paste
  // artifact, never meaningful); the PASSWORD IS NOT (leading/trailing spaces
  // may be intentional — the server hashes exactly what was set).
  function validateCredentials(username, password, t) {
    t = t || function (k) { return k; };
    var u = username === null || username === undefined ? '' : String(username).trim();
    var p = password === null || password === undefined ? '' : String(password);
    if (!u || !p) return { ok: false, error: t('login.missing_fields') };
    return { ok: true, username: u, password: p };
  }

  // Render the login screen into `mount`. deps needs { Escape, Api }. On success:
  // stores the token via deps.storeToken (app.js's sessionStorage helper), wires
  // Api, and calls onEntered({ role, branch_id, display_name }). Returns nothing.
  // `initialMessage` is OPTIONAL — shown up front (e.g. "Your session expired.
  // Please log in again." after app.js's handleAuthExpired reload) instead of the
  // blank message paragraph a plain boot leaves until the first submit attempt.
  //
  // `opts.onRegister` is OPTIONAL (2026-07-27) — ONLY passed on the personal-mode
  // path (Landing's "Login" button, app.js's mountLogin). When present: the form
  // gets the same centered blue/white treatment as Landing/Onboarding (body
  // .onboard-mode — see onboarding.css) plus a "Don't have an account? Sign up
  // now" link. When absent — the direct business (multiUser) AuthGate 'login'
  // decision, which never sets it — rendering is BYTE-IDENTICAL to before this
  // change: no wrapper, no link, no theme override. Business accounts are
  // admin-provisioned, never self-registered, so that path must never show a
  // sign-up link; scoping the whole visual change behind this one flag is what
  // keeps the two modes from clashing (see feedback-personal-business-no-clash).
  function render(mount, deps, onEntered, initialMessage, opts) {
    if (typeof document === 'undefined' || !mount) return;
    opts = opts || {};
    var Escape = deps.Escape, Api = deps.Api;
    var t = deps.t || function (k) { return k; };
    mount.textContent = '';

    var form = document.createElement('form');
    form.className = 'token-gate login-gate'; // reuse the token-gate card styling

    var title = document.createElement('h2');
    title.className = 'login-title';
    Escape.setText(title, t('login.title'));
    form.appendChild(title);

    // Google sign-in (2026-07-27, Barat: "like how most app have"; wired to the real
    // backend 2026-07-30) — personal-mode only (opts.onRegister gates this exactly
    // like the rest of the blue/white treatment; business accounts are admin-
    // provisioned, no OAuth path). opts.onGoogleLogin is a PLAIN function (not a
    // Promise) — clicking it navigates the whole page to GET /api/auth/google,
    // which redirects to Google's consent screen and back; there is no in-page
    // result to await, the next thing that runs is a fresh page load. When the
    // hook isn't provided (google_auth off), show an HONEST "not available yet"
    // message — NEVER pretend it worked. (A real bug this session: the signup
    // version used to silently skip ahead as if it had succeeded, with no token
    // ever set, landing a user in a broken dashboard shell where every real data
    // call 401'd — see onboarding.js's fix, same date. That mistake must not be
    // repeated here.)
    var googleError = document.createElement('p');
    googleError.className = 'onboard-error';
    googleError.hidden = true;
    if (opts.onRegister) {
      var googleBtn = document.createElement('button');
      googleBtn.type = 'button';
      googleBtn.className = 'onboard-btn onboard-btn--google';
      var gIcon = document.createElement('span');
      gIcon.className = 'onboard-google-icon';
      gIcon.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">'
        + '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.61z"/>'
        + '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>'
        + '<path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>'
        + '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>'
        + '</svg>';
      googleBtn.appendChild(gIcon);
      var gLabel = document.createElement('span');
      gLabel.textContent = t('login.google');
      googleBtn.appendChild(gLabel);
      googleBtn.addEventListener('click', function () {
        if (typeof opts.onGoogleLogin !== 'function') {
          googleError.hidden = false;
          Escape.setText(googleError, t('login.google_unavailable'));
          return;
        }
        googleBtn.disabled = true;
        googleError.hidden = true;
        opts.onGoogleLogin(); // navigates away — no promise to await, see comment above
      });
      form.appendChild(googleBtn);
      form.appendChild(googleError);

      var divider = document.createElement('div');
      divider.className = 'onboard-divider';
      var dividerText = document.createElement('span');
      dividerText.textContent = t('login.or');
      divider.appendChild(dividerText);
      form.appendChild(divider);
    }

    var userLabel = document.createElement('label');
    userLabel.className = 'token-gate-label';
    userLabel.setAttribute('for', 'login-username');
    Escape.setText(userLabel, t('login.username'));
    var userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.id = 'login-username';
    userInput.className = 'token-gate-input';
    userInput.setAttribute('autocomplete', 'username');

    var pwLabel = document.createElement('label');
    pwLabel.className = 'token-gate-label';
    pwLabel.setAttribute('for', 'login-password');
    Escape.setText(pwLabel, t('login.password'));
    var pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.id = 'login-password';
    pwInput.className = 'token-gate-input';
    pwInput.setAttribute('autocomplete', 'current-password');

    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'token-gate-submit';
    submit.textContent = t('login.submit');

    var msg = document.createElement('p');
    msg.className = 'token-gate-msg muted';
    if (initialMessage) Escape.setText(msg, initialMessage);

    form.appendChild(userLabel);
    form.appendChild(userInput);
    form.appendChild(pwLabel);
    form.appendChild(pwInput);

    // "Forgot password?" (2026-07-27) — personal-mode only (opts.onRegister gates it,
    // same reasoning as the sign-up link and Google button above): business accounts
    // are operator-provisioned/reset, no self-service path exists or should exist here.
    if (opts.onRegister) {
      var forgotRow = document.createElement('p');
      forgotRow.className = 'login-forgot-row';
      var forgotLink = document.createElement('button');
      forgotLink.type = 'button';
      forgotLink.className = 'login-forgot-link';
      forgotLink.textContent = t('login.forgot');
      forgotLink.addEventListener('click', function () {
        if (typeof opts.onForgotPassword === 'function') opts.onForgotPassword();
      });
      forgotRow.appendChild(forgotLink);
      form.appendChild(forgotRow);
    }

    form.appendChild(submit);
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var creds = validateCredentials(userInput.value, pwInput.value, t);
      if (!creds.ok) { Escape.setText(msg, creds.error); return; }
      submit.disabled = true;
      Escape.setText(msg, t('login.signing_in'));
      Api.apiFetch('/api/login', { method: 'POST', body: { username: creds.username, password: creds.password } })
        .then(function (r) {
          // r = { token, role, branch_id, display_name } (routes/auth.js). The token is
          // stored exactly like the personal dashboard token; the identity rides to the shell.
          if (typeof deps.storeToken === 'function') deps.storeToken(r.token);
          Api.setToken(r.token); // never logged
          pwInput.value = '';
          mount.textContent = '';
          onEntered({ role: r.role, branch_id: r.branch_id || null, display_name: r.display_name || '' });
        })
        .catch(function (err) {
          submit.disabled = false;
          pwInput.value = '';
          var friendly = err && err.status === 401 ? t('login.wrong_credentials')
            : err && err.status === 429 ? t('login.rate_limited')
            : t('login.sign_in_failed');
          Escape.setText(msg, friendly);
        });
    });

    if (opts.onRegister) {
      var registerRow = document.createElement('p');
      registerRow.className = 'login-register-row';
      registerRow.appendChild(document.createTextNode(t('login.no_account')));
      var registerLink = document.createElement('button');
      registerLink.type = 'button';
      registerLink.className = 'login-register-link';
      registerLink.textContent = t('login.sign_up_now');
      registerLink.addEventListener('click', function () { opts.onRegister(); });
      registerRow.appendChild(registerLink);
      form.appendChild(registerRow);
    }

    if (opts.onRegister) {
      // Same centered blue/white card as Landing/Onboarding (2026-07-27) — only
      // for the personal-mode entry path; see the render() doc comment above.
      var wrap = document.createElement('div');
      wrap.className = 'onboard-root';
      wrap.appendChild(form);
      mount.appendChild(wrap);
    } else {
      mount.appendChild(form);
    }
    userInput.focus();
  }

  return { render: render, validateCredentials: validateCredentials };
});
