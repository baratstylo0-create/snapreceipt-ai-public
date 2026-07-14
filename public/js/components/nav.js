// components/nav.js — the top navigation bar for the app shell.
//
// Pure DOM construction: every element is built with createElement + textContent
// (never innerHTML), so no untrusted value can ever inject markup and the strict
// no-inline CSP is satisfied. The section list is the single source of truth for
// both the nav buttons and the view-switching in app.js.
//
// UMD shim: window.Nav in the browser; require()-able in Node. Node has no DOM,
// so buildNav() no-ops (returns null) there — the SECTIONS list is still exported
// so it stays unit-inspectable without a DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Nav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical section order. id is used as the view key; label is display text.
  // Phase 2 (Mugi's Treehouse concept): the Agent is no longer a nav tab — it
  // lives in the floating "Falc" assistant (components/falc.js), so it's dropped
  // here. A dedicated Settings view takes its place.
  var SECTIONS = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'upload', label: 'Upload' },
    { id: 'manage', label: 'Manage' },
    { id: 'settings', label: 'Settings' },
  ];

  // Business-only sections: Team (branches/staff/companies — Phase 2/8 follow-up, was
  // API-only until this was wired) and the payment Pending/Paid tabs (Phase 6). Inserted
  // before Settings so Settings stays last.
  // NB: the excel-lite editable grid is NOT a top-level section — it's a sub-page of
  // "Manage" (components/manage.js), gated there by the excelLiteGrid capability. It used to
  // be a standalone "Ledger" tab here; the Owner moved it under Manage (2026-07-09).
  var BUSINESS_SECTIONS = [
    { id: 'team', label: 'Team' },
  ];

  function paymentsPageEnabled(opts) {
    opts = opts || {};
    if (opts.paymentsPage === true) return true;
    if (opts.config && opts.config.payments_page === true) return true;
    return false;
  }

  // sectionsFor({ business, role }) -> the nav list for the mode. Personal (business falsy)
  // returns SECTIONS untouched — the classic six, byte-identical. Business adds Team +
  // Payments for BOTH roles (the views render role-aware internally; the server enforces
  // authorization regardless of what the nav shows). Pure, no DOM.
  // NB (2026-07-09): the excelLiteGrid flag no longer affects the nav — the grid moved into
  // the Manage sub-page (components/manage.js), which reads the flag itself. An `excelLiteGrid`
  // property on opts is now simply ignored here (kept accepted for caller back-compat).
  function sectionsFor(opts) {
    opts = opts || {};
    if (!opts.business) return SECTIONS;
    var businessSections = BUSINESS_SECTIONS.slice();
    if (paymentsPageEnabled(opts)) businessSections.push({ id: 'payments', label: 'Payments' });
    var out = [];
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].id === 'settings') { out = out.concat(businessSections); }
      out.push(SECTIONS[i]);
    }
    return out;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Build Mugi's "Treehouse" brand emblem (a leaf mark) as inline SVG via
  // createElementNS — never innerHTML — so the strict no-inline CSP holds.
  // Returns the emblem <span> wrapper (or null outside a browser).
  function buildEmblem() {
    if (typeof document === 'undefined') return null;
    var wrap = document.createElement('span');
    wrap.className = 'nav-emblem';
    wrap.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    var leaf = document.createElementNS(SVG_NS, 'path');
    leaf.setAttribute('d', 'M12 3C8 8 5 11 5 15a7 7 0 0014 0c0-4-3-7-7-12z');
    leaf.setAttribute('fill', 'var(--accent-contrast)');
    var vein = document.createElementNS(SVG_NS, 'path');
    vein.setAttribute('d', 'M12 9v9');
    vein.setAttribute('stroke', 'var(--accent)');
    vein.setAttribute('stroke-width', '1.4');
    vein.setAttribute('stroke-linecap', 'round');
    svg.appendChild(leaf);
    svg.appendChild(vein);
    wrap.appendChild(svg);
    return wrap;
  }

  // Owner request 2026-07-06: match Mugi's reference mockup's TWO-tier header
  // — a big brand block (badge + title + tagline + icon actions) sitting
  // above a separate pill-shaped nav bar — instead of the one combined row
  // this used to build. Split into buildBrandHeader() (the big block) and
  // buildNav() (now just the pill bar of section links). Personal-only:
  // no "Team" tab, no mascot illustration — those are business-mockup extras,
  // out of scope here.

  // https://t.me/<bot_username> — pure so it's unit-testable without a DOM. Same
  // link for every role (one bot per client account, ADR-020); the bot's @handle
  // comes from GET /api/config's `bot_username` (already fetched at boot, no new
  // endpoint needed). Returns null when unset (BOT_USERNAME not yet configured/
  // auto-detected) so the caller can skip rendering the icon entirely rather than
  // link to a broken/empty bot handle.
  function telegramLink(botUsername) {
    var u = botUsername == null ? '' : String(botUsername).trim();
    return u ? 'https://t.me/' + encodeURIComponent(u) : null;
  }

  // Build the big top block: logo badge + title + tagline, plus icon actions
  // (Telegram bot link, settings shortcut, theme toggle, refresh). onSettings/
  // onToggleTheme/onRefresh are called on their respective button clicks. Returns
  // { el } or null outside a browser.
  //
  // opts.business (bool, ADR-021 Phase 6 follow-up): the original two-tier header
  // (Owner request 2026-07-06) hardcoded "AutoReceipt Dashboard (Personal)" —
  // deliberately personal-only AT THE TIME, before the M2 business layer existed
  // ("business-mockup extras, out of scope here"). Now that business accounts are
  // live, that hardcoded label is simply wrong for them (shows "(Personal)" on a
  // real business account). business:true swaps in a business-appropriate
  // title/tagline; personal mode (default) is byte-identical to before.
  function buildBrandHeader(opts) {
    if (typeof document === 'undefined') return null;
    opts = opts || {};
    var onSettings = typeof opts.onSettings === 'function' ? opts.onSettings : function () {};
    var onToggleTheme = typeof opts.onToggleTheme === 'function' ? opts.onToggleTheme : function () {};
    var onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : function () {};
    var business = !!opts.business;

    var top = document.createElement('div');
    top.className = 'app-header-top';

    var brand = document.createElement('div');
    brand.className = 'brand';
    var badge = document.createElement('div');
    badge.className = 'emblem';
    badge.setAttribute('aria-hidden', 'true');
    var emblem = buildEmblem();
    if (emblem) badge.appendChild(emblem);
    brand.appendChild(badge);

    var titleWrap = document.createElement('div');
    var h1 = document.createElement('h1');
    h1.className = 'brand-title';
    h1.textContent = business ? 'AutoReceipt Business' : 'AutoReceipt Dashboard (Personal)';
    var sub = document.createElement('div');
    sub.className = 'brand-sub';
    sub.textContent = business ? 'branches · staff · petty-cash, in one place' : 'snap a receipt · auto-extract · auto-categorize';
    titleWrap.appendChild(h1);
    titleWrap.appendChild(sub);
    brand.appendChild(titleWrap);
    top.appendChild(brand);

    var actions = document.createElement('div');
    actions.className = 'header-actions';

    // Telegram bot link (Owner request 2026-07-14): neither role had any persistent,
    // nav-accessible way to find "their" bot — a clerk's/admin's one-time bind LINK
    // (with the secret bind_token) is only ever shown once via Team's credential
    // panel and must stay that way (re-exposing a live bind_token in the nav would
    // let anyone with page access re-bind the branch's chat to themselves). This
    // icon is the safe, always-visible piece: a plain link to open a chat with the
    // account's bot (no token, nothing secret) — the same URL for every role, since
    // there is exactly one bot per client account (ADR-020). Omitted entirely when
    // BOT_USERNAME isn't configured yet, rather than linking to a dead handle.
    var tgLink = telegramLink(opts.botUsername);
    if (tgLink) {
      var tgBtn = document.createElement('a');
      tgBtn.className = 'icon-btn';
      tgBtn.href = tgLink;
      tgBtn.target = '_blank';
      tgBtn.rel = 'noopener noreferrer';
      tgBtn.title = 'Open Telegram bot';
      tgBtn.setAttribute('aria-label', 'Open Telegram bot');
      tgBtn.textContent = '✈'; // ✈ plane glyph, single-character like the sibling icon buttons
      actions.appendChild(tgBtn);
    }

    var settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'icon-btn';
    settingsBtn.title = 'Settings';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', function () { onSettings(); });
    actions.appendChild(settingsBtn);

    var themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'icon-btn';
    themeBtn.title = 'Cycle theme (Light / Warm / Dark)';
    themeBtn.setAttribute('aria-label', 'Cycle theme (Light / Warm / Dark)');
    themeBtn.textContent = '☾';
    themeBtn.addEventListener('click', function () { onToggleTheme(); });
    actions.appendChild(themeBtn);

    var refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'icon-btn';
    refreshBtn.title = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', function () { onRefresh(); });
    actions.appendChild(refreshBtn);

    top.appendChild(actions);
    return { el: top, actionsEl: actions };
  }

  // Build the pill-shaped nav bar (just the section links now — brand/theme
  // moved to buildBrandHeader above). onSelect(id) fires when a section
  // button is clicked. Returns the <nav> element, or null outside a browser.
  function buildNav(opts) {
    if (typeof document === 'undefined') return null;
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    // Optional section list (Phase 6: app.js passes sectionsFor(...) in business mode);
    // defaults to the classic SECTIONS so existing callers are unchanged.
    var sections = Array.isArray(opts.sections) && opts.sections.length ? opts.sections : SECTIONS;

    var nav = document.createElement('nav');
    nav.className = 'nav';

    var links = document.createElement('div');
    links.className = 'nav-links';
    var buttons = {};
    sections.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-link';
      btn.setAttribute('data-view', s.id);
      btn.textContent = s.label;
      // addEventListener (not on*=) keeps us CSP-clean.
      btn.addEventListener('click', function () { onSelect(s.id); });
      links.appendChild(btn);
      buttons[s.id] = btn;
    });
    nav.appendChild(links);

    // Mark the active button so app.js can reflect the current view.
    function setActive(id) {
      sections.forEach(function (s) {
        if (buttons[s.id]) buttons[s.id].classList.toggle('is-active', s.id === id);
      });
    }

    return { el: nav, setActive: setActive };
  }

  return {
    buildNav: buildNav, buildBrandHeader: buildBrandHeader, buildEmblem: buildEmblem,
    SECTIONS: SECTIONS, sectionsFor: sectionsFor, paymentsPageEnabled: paymentsPageEnabled,
    telegramLink: telegramLink,
  };
});
