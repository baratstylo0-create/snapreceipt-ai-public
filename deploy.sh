#!/bin/bash
set -e
APP=/opt/snapreceipt-ai/public

echo "=== SnapReceipt AI — Account Panel Deploy v2 ==="
echo ""

# 0. Show what's currently there
echo "[0] Current state check..."
if [ -f "$APP/js/components/accountPanel.js" ]; then
  echo "  accountPanel.js exists. First line:"
  head -1 "$APP/js/components/accountPanel.js"
  echo "  Checking for CURRENT ACCOUNT text:"
  grep -c "CURRENT ACCOUNT" "$APP/js/components/accountPanel.js" || echo "  NOT FOUND — old version detected"
else
  echo "  accountPanel.js does NOT exist."
fi
echo ""

# 1. FORCE write accountPanel.js (delete old first)
echo "[1/5] Force-writing accountPanel.js..."
rm -f "$APP/js/components/accountPanel.js"
cat > "$APP/js/components/accountPanel.js" << 'ACCOUNTPANEL_EOF'
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'));
  } else {
    root.AccountPanel = factory(root.Escape);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

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

  function openPanel(anchorEl, deps) {
    if (!hasDom()) return;
    var win = typeof self !== 'undefined' ? self : this;
    var config = deps.config || {};
    var info = config.account_info || {};
    var email = info.email || '';
    var initial = email ? email.charAt(0).toUpperCase() : '?';

    anchorEl.setAttribute('aria-expanded', 'true');

    var host = el('div', 'account-panel-host');
    var panel = el('div', 'account-panel');
    panel.setAttribute('role', 'menu');
    host.appendChild(panel);
    document.body.appendChild(host);

    var rect = anchorEl.getBoundingClientRect();
    var right = (win.innerWidth || 1024) - rect.right;
    panel.style.top = (rect.bottom + 8) + 'px';
    panel.style.right = Math.max(8, right) + 'px';

    // Header
    var header = el('div', 'acct-header');
    setText(header, 'CURRENT ACCOUNT');
    panel.appendChild(header);

    // Account card
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
    panel.appendChild(el('div', 'acct-divider'));

    // Menu rows
    var profileRow = buildMenuRow(userIcon(), 'Profile & account', 'Manage your profile information', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(profileRow);

    var prefsRow = buildMenuRow(settingsIcon(), 'Preferences', 'Customize your experience', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(prefsRow);

    var helpRow = buildMenuRow(helpIcon(), 'Help & support', 'Get help and contact support', function () {
      closePanel();
      if (deps.switchView) deps.switchView('settings');
    });
    panel.appendChild(helpRow);

    panel.appendChild(el('div', 'acct-divider'));

    // Log out row
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

    // Click-outside + Escape to close
    function onDocClick(e) {
      if (!host.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
        closePanel();
      }
    }
    function onKeydown(e) { if (e.key === 'Escape') closePanel(); }
    win.setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
    document.addEventListener('keydown', onKeydown);
    host._cleanup = function () {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    };
  }

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

    var avatar = el('span', 'acct-avatar');
    setText(avatar, initial);
    chip.appendChild(avatar);

    var label = el('span', 'acct-chip-label');
    setText(label, email);
    chip.appendChild(label);

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

    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var wasOpen = chip.getAttribute('aria-expanded') === 'true';
      closePanel();
      if (wasOpen) return;
      openPanel(chip, deps);
    });

    return chip;
  }

  return {
    buildChip: buildChip,
    closePanel: closePanel,
  };
});
ACCOUNTPANEL_EOF
echo "  Written. Verifying..."
grep -c "CURRENT ACCOUNT" "$APP/js/components/accountPanel.js" && echo "  VERIFIED: new version." || echo "  ERROR: write failed!"
echo ""

# 2. Append account panel CSS if not already present
echo "[2/5] Patching app.css..."
if grep -q 'account-chip' "$APP/css/app.css" 2>/dev/null; then
  echo "  Already has account-chip styles — skipping."
else
  cat >> "$APP/css/app.css" << 'CSS_EOF'

/* ============================================================
   Account chip + panel (personal-mode only)
   Scoped under body.personal-mode so business is byte-identical.
   ============================================================ */

body.personal-mode .account-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 5px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--txt);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  line-height: 1.3;
}
body.personal-mode .account-chip:hover,
body.personal-mode .account-chip[aria-expanded="true"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.10);
}

body.personal-mode .acct-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 13px;
  font-weight: 600;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  line-height: 1;
}
body.personal-mode .acct-avatar--lg {
  width: 42px;
  height: 42px;
  font-size: 18px;
}

body.personal-mode .acct-chip-label {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

body.personal-mode .acct-chip-caret {
  display: grid;
  place-items: center;
  color: var(--muted);
  transition: transform 0.15s;
}
body.personal-mode .account-chip[aria-expanded="true"] .acct-chip-caret {
  transform: rotate(180deg);
}

body.personal-mode .account-panel-host {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

body.personal-mode .account-panel {
  position: fixed;
  width: 370px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--panel-shadow), 0 4px 24px rgba(0,0,0,0.08);
  padding: 0;
  z-index: 10000;
}

body.personal-mode .acct-header {
  padding: 18px 20px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
  text-transform: uppercase;
}

body.personal-mode .acct-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 12px 4px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--bg-2);
  border: 1.5px solid var(--accent);
  cursor: default;
}

body.personal-mode .acct-card-info {
  flex: 1;
  min-width: 0;
}

body.personal-mode .acct-card-email {
  font-size: 14px;
  font-weight: 600;
  color: var(--txt);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.personal-mode .acct-card-type {
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
  margin-top: 1px;
}

body.personal-mode .acct-card-email-sub {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.personal-mode .acct-card-check {
  flex-shrink: 0;
  color: var(--accent);
}

body.personal-mode .acct-divider {
  height: 1px;
  margin: 8px 20px;
  background: var(--line);
}

body.personal-mode .acct-menu-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 20px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
  color: var(--txt);
}
body.personal-mode .acct-menu-row:hover {
  background: var(--bg-2);
}

body.personal-mode .acct-menu-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--bg-2);
  color: var(--accent);
  flex-shrink: 0;
}

body.personal-mode .acct-menu-icon--danger {
  background: var(--clay-bg, rgba(220, 38, 38, 0.10));
  color: var(--clay, #dc2626);
}

body.personal-mode .acct-menu-text {
  flex: 1;
  min-width: 0;
}

body.personal-mode .acct-menu-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--txt);
}

body.personal-mode .acct-menu-title--danger {
  color: var(--clay, #dc2626);
}

body.personal-mode .acct-menu-desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

body.personal-mode .acct-menu-arrow {
  flex-shrink: 0;
  color: var(--muted);
  display: grid;
  place-items: center;
}

body.personal-mode .acct-menu-row--danger:hover {
  background: var(--clay-bg, rgba(220, 38, 38, 0.08));
}

@media (max-width: 480px) {
  body.personal-mode .account-panel { width: calc(100vw - 16px); }
  body.personal-mode .acct-chip-label { max-width: 120px; }
}
CSS_EOF
  echo "  Appended account panel styles."
fi

# 3. Patch index.html — add accountPanel.js script tag before app.js
echo "[3/5] Patching index.html..."
node << 'NODEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/index.html";
var s = fs.readFileSync(f, "utf8");
if (s.indexOf("accountPanel.js") !== -1) {
  console.log("  Already has accountPanel.js script tag.");
} else {
  s = s.replace(
    /(<script src="js\/app\.js)/,
    '<script src="js/components/accountPanel.js?v=20260826a"></script>\n  $1'
  );
  fs.writeFileSync(f, s);
  console.log("  Added accountPanel.js script tag.");
}
NODEOF

# 4. Patch app.js — add AccountPanel dep + personal-mode chip branch
echo "[4/5] Patching app.js..."
node << 'NODEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/js/app.js";
var s = fs.readFileSync(f, "utf8");
var changed = false;

if (s.indexOf("AccountPanel") === -1) {
  s = s.replace(
    /([ \t]*\} catch \(e\) \{ return null; \})/,
    "        if (name === 'AccountPanel') return require('./components/accountPanel');\n$1"
  );
  var marker = "rateMeterHost.appendChild(out);";
  var idx = s.lastIndexOf(marker);
  if (idx !== -1) {
    var insertAt = idx + marker.length;
    var patch = "\n    } else if (rateMeterHost && deps.config && deps.config.personal_auth\n               && deps.config.account_info && dep('AccountPanel')) {\n      var AccountPanel = dep('AccountPanel');\n      var acctChip = AccountPanel.buildChip(deps);\n      if (acctChip) rateMeterHost.appendChild(acctChip);";
    s = s.slice(0, insertAt) + patch + s.slice(insertAt);
  }
  fs.writeFileSync(f, s);
  changed = true;
  console.log("  Added AccountPanel dep + chip branch.");
} else {
  console.log("  AccountPanel already present.");
}
NODEOF

# 5. Patch settings.js — export openDeleteAccountModal
echo "[5/5] Patching settings.js..."
node << 'NODEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/js/components/settings.js";
var s = fs.readFileSync(f, "utf8");
if (s.indexOf("openDeleteAccountModal: openDeleteAccountModal") !== -1) {
  console.log("  Already exports openDeleteAccountModal.");
} else {
  s = s.replace(
    /(mount: mount,)/,
    "$1\n    openDeleteAccountModal: openDeleteAccountModal,"
  );
  fs.writeFileSync(f, s);
  console.log("  Added openDeleteAccountModal export.");
}
NODEOF

# 6. Bump cache-bust on script tags so browsers reload
echo ""
echo "[6] Bumping cache-bust version in index.html..."
node << 'NODEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/index.html";
var s = fs.readFileSync(f, "utf8");
var ts = Date.now().toString(36);
s = s.replace(/accountPanel\.js\?v=[^"']*/g, "accountPanel.js?v=" + ts);
s = s.replace(/(app\.js)\?v=[^"']*/g, "$1?v=" + ts);
s = s.replace(/(app\.css)\?v=[^"']*/g, "$1?v=" + ts);
s = s.replace(/(settings\.js)\?v=[^"']*/g, "$1?v=" + ts);
fs.writeFileSync(f, s);
console.log("  Cache-bust set to: " + ts);
NODEOF

echo ""
echo "Restarting app..."
pm2 restart snapreceipt-ai --update-env
echo ""
echo "=== Deploy complete! ==="
echo "Hard-refresh (Ctrl+Shift+R) https://snapreceiptai.friction.com.my/ to verify."
