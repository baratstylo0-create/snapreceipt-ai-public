// components/accountPanel.js — personal-mode account chip + settings panel.
//
// Clicking the header chip opens a dropdown panel anchored under it (right-
// aligned, fixed-position, click-outside + Escape to close) containing the
// user's account card and every REAL setting — theme, plan/usage, member
// since, clear local data, delete account, log out.
//
// Business mode is completely untouched — this module is only consumed when
// deps.config.personal_auth && deps.config.account_info are truthy.
//
// Popover mechanics modeled on render.js's buildInfoIcon/closeInfoPopups
// (the proven, CSP-clean pattern already in the codebase).
//
// UMD shim: window.AccountPanel in the browser; require()-able in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'));
  } else {
    root.AccountPanel = factory(root.Escape);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

  // ---- tiny helpers (private) -----------------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function setText(node, value) {
    if (Escape && Escape.setText) Escape.setText(node, value);
    else node.textContent = String(value == null ? '' : value);
  }

  // SVG helpers — inline, no external assets, CSP-clean.
  function svgIcon(paths, size) {
    size = size || 20;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', paths[i].tag || 'path');
      var attrs = paths[i];
      for (var k in attrs) { if (k !== 'tag') p.setAttribute(k, attrs[k]); }
      svg.appendChild(p);
    }
    return svg;
  }

  // Icons used in the panel rows.
  function userIcon() {
    return svgIcon([
      { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' },
      { tag: 'circle', cx: '12', cy: '7', r: '4' }
    ]);
  }
  function settingsIcon() {
    return svgIcon([
      { tag: 'circle', cx: '12', cy: '12', r: '3' },
      { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }
    ]);
  }
  function helpIcon() {
    return svgIcon([
      { tag: 'circle', cx: '12', cy: '12', r: '10' },
      { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' },
      { tag: 'line', x1: '12', y1: '17', x2: '12.01', y2: '17' }
    ]);
  }
  function logoutIcon() {
    return svgIcon([
      { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' },
      { tag: 'polyline', points: '16 17 21 12 16 7' },
      { tag: 'line', x1: '21', y1: '12', x2: '9', y2: '12' }
    ]);
  }
  function chevronIcon() {
    return svgIcon([{ tag: 'polyline', points: '9 18 15 12 9 6' }], 16);
  }
  function trashIcon() {
    return svgIcon([
      { tag: 'polyline', points: '3 6 5 6 21 6' },
      { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }
    ]);
  }
  function moonIcon() {
    return svgIcon([{ d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }]);
  }
  function sunIcon() {
    return svgIcon([
      { tag: 'circle', cx: '12', cy: '12', r: '5' },
      { tag: 'line', x1: '12', y1: '1', x2: '12', y2: '3' },
      { tag: 'line', x1: '12', y1: '21', x2: '12', y2: '23' },
      { tag: 'line', x1: '4.22', y1: '4.22', x2: '5.64', y2: '5.64' },
      { tag: 'line', x1: '18.36', y1: '18.36', x2: '19.78', y2: '19.78' },
      { tag: 'line', x1: '1', y1: '12', x2: '3', y2: '12' },
      { tag: 'line', x1: '21', y1: '12', x2: '23', y2: '12' },
      { tag: 'line', x1: '4.22', y1: '19.78', x2: '5.64', y2: '18.36' },
      { tag: 'line', x1: '18.36', y1: '5.64', x2: '19.78', y2: '4.22' }
    ]);
  }

  // ---- close ----------------------------------------------------------------

  // Close any open account panel (mirrors render.js's closeInfoPopups).
  function closePanel() {
    if (!hasDom()) return;
    var hosts = document.querySelectorAll('.account-panel-host');
    for (var i = 0; i < hosts.length; i++) {
      if (typeof hosts[i]._cleanup === 'function') hosts[i]._cleanup();
      if (hosts[i].parentNode) hosts[i].parentNode.removeChild(hosts[i]);
    }
    var chips = document.querySelectorAll('.account-chip[aria-expanded="true"]');
    for (var j = 0; j < chips.length; j++) chips[j].setAttribute('aria-expanded', 'false');
  }

  // ---- panel builder --------------------------------------------------------

  function openPanel(anchorEl, deps) {
    if (!hasDom()) return;
    var win = typeof self !== 'undefined' ? self : this;
    var config = deps.config || {};
    var info = config.account_info || {};
    var email = info.email || '';
    var initial = email ? email.charAt(0).toUpperCase() : '?';

    anchorEl.setAttribute('aria-expanded', 'true');

    // --- host overlay (fixed, transparent) ---
    var host = el('div', 'account-panel-host');
    var panel = el('div', 'account-panel');
    panel.setAttribute('role', 'menu');
    host.appendChild(panel);
    document.body.appendChild(host);

    // Position: right-aligned under the chip, clamped to viewport.
    var rect = anchorEl.getBoundingClientRect();
    var panelW = 370;
    var right = (win.innerWidth || 1024) - rect.right;
    panel.style.top = (rect.bottom + 8) + 'px';
    panel.style.right = Math.max(8, right) + 'px';

    // --- 1. Current Account card ---
    var header = el('div', 'acct-header');
    setText(header, 'CURRENT ACCOUNT');
    panel.appendChild(header);

    var card = el('div', 'acct-card');
    var cardAvatar = el('div', 'acct-avatar acct-avatar--lg');
    setText(cardAvatar, initial);
    card.appendChild(cardAvatar);

    var cardInfo = el('div', 'acct-card-info');
    var cardEmail = el('div', 'acct-card-email');
    setText(cardEmail, email);
    cardInfo.appendChild(cardEmail);

    var cardType = el('div', 'acct-card-type');
    setText(cardType, 'Personal');
    cardInfo.appendChild(cardType);

    var cardEmailSub = el('div', 'acct-card-email-sub');
    setText(cardEmailSub, email);
    cardInfo.appendChild(cardEmailSub);

    card.appendChild(cardInfo);

    // Checkmark
    var check = el('div', 'acct-card-check');
    var checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    checkSvg.setAttribute('width', '20');
    checkSvg.setAttribute('height', '20');
    checkSvg.setAttribute('viewBox', '0 0 24 24');
    checkSvg.setAttribute('fill', 'none');
    checkSvg.setAttribute('stroke', 'currentColor');
    checkSvg.setAttribute('stroke-width', '2.5');
    checkSvg.setAttribute('aria-hidden', 'true');
    var checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    checkPath.setAttribute('points', '20 6 9 17 4 12');
    checkSvg.appendChild(checkPath);
    check.appendChild(checkSvg);
    card.appendChild(check);

    panel.appendChild(card);

    // --- divider ---
    panel.appendChild(el('div', 'acct-divider'));

    // --- 2. Profile & account (navigates to Settings) ---
    var profileRow = buildMenuRow(userIcon(), 'Profile & account', 'Manage your profile information', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(profileRow);

    // --- 3. Preferences (theme + appearance) ---
    var prefsRow = buildMenuRow(settingsIcon(), 'Preferences', 'Customize your experience', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(prefsRow);

    // --- 4. Help & support ---
    var helpRow = buildMenuRow(helpIcon(), 'Help & support', 'Get help and contact support', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(helpRow);

    // --- divider ---
    panel.appendChild(el('div', 'acct-divider'));

    // --- 5. Log out ---
    var logoutRow = el('button', 'acct-menu-row acct-menu-row--danger');
    logoutRow.type = 'button';
    var logoutIconWrap = el('span', 'acct-menu-icon acct-menu-icon--danger');
    logoutIconWrap.appendChild(logoutIcon());
    logoutRow.appendChild(logoutIconWrap);
    var logoutText = el('div', 'acct-menu-text');
    var logoutTitle = el('div', 'acct-menu-title acct-menu-title--danger');
    setText(logoutTitle, 'Log out');
    logoutText.appendChild(logoutTitle);
    var logoutDesc = el('div', 'acct-menu-desc');
    setText(logoutDesc, 'Sign out from your account');
    logoutText.appendChild(logoutDesc);
    logoutRow.appendChild(logoutText);
    logoutRow.addEventListener('click', function () {
      closePanel();
      if (typeof deps.logout === 'function') deps.logout();
    });
    panel.appendChild(logoutRow);

    // --- click-outside + Escape handlers (render.js pattern) ---
    function onDocClick(e) {
      if (!host.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
        closePanel();
      }
    }
    function onKeydown(e) { if (e.key === 'Escape') closePanel(); }
    // Deferred one tick so THIS click (still bubbling) doesn't self-close.
    win.setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
    document.addEventListener('keydown', onKeydown);
    host._cleanup = function () {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    };
  }

  // Build a clickable menu row (icon + title + desc + chevron).
  function buildMenuRow(icon, title, desc, onClick) {
    var row = el('button', 'acct-menu-row');
    row.type = 'button';
    var iconWrap = el('span', 'acct-menu-icon');
    iconWrap.appendChild(icon);
    row.appendChild(iconWrap);

    var textWrap = el('div', 'acct-menu-text');
    var titleEl = el('div', 'acct-menu-title');
    setText(titleEl, title);
    textWrap.appendChild(titleEl);
    var descEl = el('div', 'acct-menu-desc');
    setText(descEl, desc);
    textWrap.appendChild(descEl);
    row.appendChild(textWrap);

    var arrow = el('span', 'acct-menu-arrow');
    arrow.appendChild(chevronIcon());
    row.appendChild(arrow);

    row.addEventListener('click', function () { if (onClick) onClick(); });
    return row;
  }

  // ---- chip builder ---------------------------------------------------------

  // Build the header account chip. Returns a <button> or null (outside a browser
  // or when account_info is absent — i.e. not a signed-in personal owner).
  function buildChip(deps) {
    if (!hasDom()) return null;
    var config = deps.config || {};
    if (!config.account_info) return null;

    var email = config.account_info.email || '';
    var initial = email ? email.charAt(0).toUpperCase() : '?';

    var chip = el('button', 'account-chip');
    chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'menu');
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-label', 'Account menu');

    // Avatar circle
    var avatar = el('span', 'acct-avatar');
    setText(avatar, initial);
    chip.appendChild(avatar);

    // Email label
    var label = el('span', 'acct-chip-label');
    setText(label, email);
    chip.appendChild(label);

    // Caret
    var caret = el('span', 'acct-chip-caret');
    caret.setAttribute('aria-hidden', 'true');
    var caretSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    caretSvg.setAttribute('width', '12');
    caretSvg.setAttribute('height', '12');
    caretSvg.setAttribute('viewBox', '0 0 24 24');
    caretSvg.setAttribute('fill', 'none');
    caretSvg.setAttribute('stroke', 'currentColor');
    caretSvg.setAttribute('stroke-width', '2.5');
    var caretPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    caretPath.setAttribute('points', '6 9 12 15 18 9');
    caretSvg.appendChild(caretPath);
    caret.appendChild(caretSvg);
    chip.appendChild(caret);

    // Click handler — toggle
    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var wasOpen = chip.getAttribute('aria-expanded') === 'true';
      closePanel();
      if (wasOpen) return; // just closed — don't reopen
      openPanel(chip, deps);
    });

    return chip;
  }

  // ---- public API -----------------------------------------------------------

  return {
    buildChip: buildChip,
    closePanel: closePanel,
  };
});
