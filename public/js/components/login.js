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
  function validateCredentials(username, password) {
    var u = username === null || username === undefined ? '' : String(username).trim();
    var p = password === null || password === undefined ? '' : String(password);
    if (!u || !p) return { ok: false, error: 'Please enter your username and password.' };
    return { ok: true, username: u, password: p };
  }

  // Render the login screen into `mount`. deps needs { Escape, Api }. On success:
  // stores the token via deps.storeToken (app.js's sessionStorage helper), wires
  // Api, and calls onEntered({ role, branch_id, display_name }). Returns nothing.
  // `initialMessage` is OPTIONAL — shown up front (e.g. "Your session expired.
  // Please log in again." after app.js's handleAuthExpired reload) instead of the
  // blank message paragraph a plain boot leaves until the first submit attempt.
  function render(mount, deps, onEntered, initialMessage) {
    if (typeof document === 'undefined' || !mount) return;
    var Escape = deps.Escape, Api = deps.Api;
    mount.textContent = '';

    var form = document.createElement('form');
    form.className = 'token-gate login-gate'; // reuse the token-gate card styling

    var title = document.createElement('h2');
    title.className = 'login-title';
    Escape.setText(title, 'Sign in');
    form.appendChild(title);

    var userLabel = document.createElement('label');
    userLabel.className = 'token-gate-label';
    userLabel.setAttribute('for', 'login-username');
    Escape.setText(userLabel, 'Username');
    var userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.id = 'login-username';
    userInput.className = 'token-gate-input';
    userInput.setAttribute('autocomplete', 'username');

    var pwLabel = document.createElement('label');
    pwLabel.className = 'token-gate-label';
    pwLabel.setAttribute('for', 'login-password');
    Escape.setText(pwLabel, 'Password');
    var pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.id = 'login-password';
    pwInput.className = 'token-gate-input';
    pwInput.setAttribute('autocomplete', 'current-password');

    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'token-gate-submit';
    submit.textContent = 'Sign in';

    var msg = document.createElement('p');
    msg.className = 'token-gate-msg muted';
    if (initialMessage) Escape.setText(msg, initialMessage);

    form.appendChild(userLabel);
    form.appendChild(userInput);
    form.appendChild(pwLabel);
    form.appendChild(pwInput);
    form.appendChild(submit);
    form.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var creds = validateCredentials(userInput.value, pwInput.value);
      if (!creds.ok) { Escape.setText(msg, creds.error); return; }
      submit.disabled = true;
      Escape.setText(msg, 'Signing in…');
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
          var friendly = err && err.status === 401 ? 'Wrong username or password.'
            : err && err.status === 429 ? 'Too many attempts — please wait a minute and try again.'
            : 'Sign-in failed. Please try again shortly.';
          Escape.setText(msg, friendly);
        });
    });

    mount.appendChild(form);
    userInput.focus();
  }

  return { render: render, validateCredentials: validateCredentials };
});
