// components/emailverify.js — email-verification UI (2026-08-24, W-01), built against
// Jeevan/Claude-P's P-01 contract (docs/security/P-01-email-verification-contract.md,
// branch feature/claude-p-P-01-verified-email-challenge — not yet merged into main, but
// that document is the frozen interface both clients build against per its own header,
// so this is written to match it exactly rather than inventing a contract).
//
// Two independent pieces:
//   mount(container, opts)  — the full-page screen reached via a magic-link
//     `?verify_token=...` URL. Auto-confirms on load (the link IS the credential per
//     the contract — no session needed), shows success or the server's own generic
//     failure message verbatim (same "show it verbatim, don't guess which case"
//     pattern already used by resetpassword.js's reset screen).
//   buildBanner(deps, email) — a persistent header banner (same shape/placement as
//     app.js's own buildTelegramBanner) for a signed-in owner whose email isn't
//     verified yet. Resend has a client-side-only 60s cooldown (contract §3: the
//     server enforces the real cooldown silently via an identical 200 either way, so
//     without a client timer a second click just looks like nothing happened) plus a
//     code-entry fallback for anyone who can't or won't click the email link.
//
// Every response from these three endpoints carries exactly one message regardless of
// what actually happened server-side (account-enumeration defense, contract §2/§5) —
// this file must never try to be smarter than that and infer a different case.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'));
  } else {
    root.EmailVerify = factory(root.Escape, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var RESEND_COOLDOWN_MS = 60000; // contract §3 — client display only, not the real limit

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // validateCode(code) -> { ok:true, code } | { ok:false }. A bare non-empty/format
  // pre-check only — the server is the real gate (contract §2: attempts are budgeted
  // server-side per challenge). This just avoids a pointless round trip for an empty
  // or obviously-not-a-code input; it must never reject anything the server would
  // actually accept, so it only checks "looks like digits", not an exact length.
  function validateCode(code) {
    var c = (code === null || code === undefined ? '' : String(code)).trim();
    if (!c || !/^[0-9]+$/.test(c)) return { ok: false };
    return { ok: true, code: c };
  }

  function card() {
    var r = el('div', 'onboard-root');
    var c = el('div', 'onboard-card');
    r.appendChild(c);
    return { root: r, card: c };
  }

  // mount(container, opts) — the ?verify_token= landing screen.
  //   opts.token           — the raw verify token from the URL (caller already stripped it)
  //   opts.Api              — the shared Api module (apiFetch)
  //   opts.onContinue()     — proceed into the app / back to sign-in
  function mount(container, opts) {
    if (!hasDom() || !container) return;
    opts = opts || {};
    if (document.body) document.body.classList.add('onboard-mode');

    var parts = card();
    var wrap = el('div', 'onboard-step');
    var badge = el('div', 'onboard-badge'); badge.textContent = '✉️';
    wrap.appendChild(badge);
    var titleEl = text('h1', 'onboard-title onboard-title--sm', t('emailverify.confirming'));
    wrap.appendChild(titleEl);
    var statusEl = text('p', 'onboard-sub', '');
    wrap.appendChild(statusEl);

    var continueBtn = text('button', 'onboard-btn onboard-btn--primary', t('emailverify.continue_btn'));
    continueBtn.type = 'button';
    continueBtn.hidden = true;
    continueBtn.addEventListener('click', function () { if (typeof opts.onContinue === 'function') opts.onContinue(); });
    wrap.appendChild(continueBtn);

    parts.card.appendChild(wrap);
    clear(container);
    container.appendChild(parts.root);

    function finish(titleText, subText) {
      Escape.setText(titleEl, titleText);
      Escape.setText(statusEl, subText || '');
      continueBtn.hidden = false;
    }

    if (!opts.Api || typeof opts.Api.apiFetch !== 'function' || !opts.token) {
      finish(t('emailverify.confirm_failed'));
      return;
    }

    opts.Api.apiFetch('/api/verify-email/confirm', { method: 'POST', body: { token: opts.token } })
      .then(function () { finish(t('emailverify.success_title'), t('emailverify.success_sub')); })
      .catch(function (err) {
        var msg = (err && err.body && err.body.error) ? err.body.error : t('emailverify.confirm_failed');
        finish(msg);
      });
  }

  // buildBanner(deps, email) — a persistent header banner. Mirrors app.js's own
  // buildTelegramBanner shape (.guest-banner / .guest-banner-btn classes, same
  // placement contract: caller appends this to the header, which survives every
  // select() call) so it re-skins automatically with zero new CSS for the base bar.
  function buildBanner(deps, email) {
    var tt = (deps && deps.t) || t;
    var Api = deps && deps.Api;
    var bar = el('div', 'guest-banner');
    bar.appendChild(text('span', '', tt('app.verify_banner')));

    var resendBtn = el('button', 'guest-banner-btn');
    resendBtn.type = 'button';
    Escape.setText(resendBtn, tt('app.verify_banner_resend'));
    var cooldownUntil = 0;
    var cooldownTimer = null;
    function tickCooldown() {
      var remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        resendBtn.disabled = false;
        Escape.setText(resendBtn, tt('app.verify_banner_resend'));
        if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
        return;
      }
      resendBtn.disabled = true;
      Escape.setText(resendBtn, remaining + 's');
    }
    resendBtn.addEventListener('click', function () {
      if (!Api || typeof Api.apiFetch !== 'function' || !email || resendBtn.disabled) return;
      cooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
      tickCooldown();
      cooldownTimer = setInterval(tickCooldown, 1000);
      // Fire-and-forget: the response carries no usable signal either way (contract
      // §2) — the cooldown above is the only feedback this UI can honestly give.
      Api.apiFetch('/api/verify-email/request', { method: 'POST', body: { email: email } }).catch(function () { /* nothing to branch on */ });
    });
    bar.appendChild(resendBtn);

    var codeToggle = el('button', 'guest-banner-btn');
    codeToggle.type = 'button';
    Escape.setText(codeToggle, tt('app.verify_banner_code_toggle'));
    bar.appendChild(codeToggle);

    var codeForm = el('form', 'verify-banner-code-form');
    codeForm.hidden = true;
    var codeInput = el('input', 'verify-banner-code-input');
    codeInput.type = 'text';
    codeInput.inputMode = 'numeric';
    codeInput.autocomplete = 'one-time-code';
    codeInput.maxLength = 6;
    codeInput.placeholder = tt('app.verify_banner_code_placeholder');
    codeForm.appendChild(codeInput);
    var codeSubmit = text('button', 'guest-banner-btn', tt('app.verify_banner_code_submit'));
    codeSubmit.type = 'submit';
    codeForm.appendChild(codeSubmit);
    var codeError = text('span', 'onboard-error', '');
    codeError.hidden = true;
    codeForm.appendChild(codeError);
    bar.appendChild(codeForm);

    codeToggle.addEventListener('click', function () {
      codeForm.hidden = !codeForm.hidden;
      if (!codeForm.hidden) codeInput.focus();
    });
    codeForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!Api || typeof Api.apiFetch !== 'function' || !email) return;
      var check = validateCode(codeInput.value);
      if (!check.ok) return;
      codeSubmit.disabled = true;
      codeError.hidden = true;
      Api.apiFetch('/api/verify-email/confirm', { method: 'POST', body: { email: email, code: check.code } })
        .then(function () {
          if (bar.parentNode) bar.parentNode.removeChild(bar);
        })
        .catch(function (err) {
          codeSubmit.disabled = false;
          var msg = (err && err.body && err.body.error) ? err.body.error : t('emailverify.confirm_failed');
          codeError.hidden = false;
          Escape.setText(codeError, msg);
        });
    });

    return bar;
  }

  return { mount: mount, buildBanner: buildBanner, validateCode: validateCode };
});
