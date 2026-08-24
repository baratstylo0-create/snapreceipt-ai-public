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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../i18n'));
  else root.Nav = factory(root.I18n);
})(typeof self !== 'undefined' ? self : this, function (I18n) {
  'use strict';

  // Falls back to plain English if i18n.js hasn't loaded (older cached bundle) —
  // never throws, never leaves a label blank.
  var t = (I18n && I18n.t) || function (k) {
    var fallback = { 'nav.overview': 'Overview', 'nav.activity': 'Activity', 'nav.upload': 'Upload', 'nav.manage': 'Manage', 'nav.settings': 'Settings', 'nav.team': 'Team' };
    return fallback[k] || k;
  };

  // Canonical section order. id is used as the view key; label is display text.
  // Phase 2 (Mugi's Treehouse concept): the Agent is no longer a nav tab — it
  // lives in the floating "Falc" assistant (components/falc.js), so it's dropped
  // here. A dedicated Settings view takes its place.
  var SECTIONS = [
    { id: 'overview', label: t('nav.overview') },
    { id: 'activity', label: t('nav.activity') },
    { id: 'upload', label: t('nav.upload') },
    { id: 'manage', label: t('nav.manage') },
    { id: 'settings', label: t('nav.settings') },
  ];

  // Business-only sections: Team (branches/staff/companies — Phase 2/8 follow-up, was
  // API-only until this was wired) and the payment Pending/Paid tabs (Phase 6). Inserted
  // before Settings so Settings stays last.
  // NB: the excel-lite editable grid is NOT a top-level section — it's a sub-page of
  // "Manage" (components/manage.js), gated there by the excelLiteGrid capability. It used to
  // be a standalone "Ledger" tab here; the Owner moved it under Manage (2026-07-09).
  var BUSINESS_SECTIONS = [
    { id: 'team', label: t('nav.team') },
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
    if (paymentsPageEnabled(opts)) businessSections.push({ id: 'payments', label: t('nav.payments') });
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
  // Real app icon (public/icons/app-icon-192.png — the actual designed logo,
  // already a blue squircle with its own receipt-scan glyph baked in) swapped
  // in for the old placeholder leaf/droplet SVG that never matched branding.
  function buildEmblem() {
    if (typeof document === 'undefined') return null;
    var wrap = document.createElement('span');
    wrap.className = 'nav-emblem';
    wrap.setAttribute('aria-hidden', 'true');
    var img = document.createElement('img');
    img.src = 'icons/app-icon-192.png';
    img.alt = '';
    img.width = 46;
    img.height = 46;
    wrap.appendChild(img);
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

  // Paper-plane glyph for the Telegram nav button (Owner request 2026-07-14: "a telegram icon
  // would be better" than the plain ✈ text glyph). Inline SVG via createElementNS — never
  // innerHTML — same discipline as buildEmblem above, so the strict no-inline CSP holds.
  // stroke="currentColor" inherits .icon-btn's color (and its hover-color transition) for
  // free, matching the plain-glyph siblings (⚙ ☾ ↻) it sits next to.
  // Owner report 2026-07-14 (round 2): the first pass (a generic stroke paper-plane/"send"
  // icon) still just read as "an aeroplane", not specifically Telegram. Swapped for the
  // actual Telegram logomark (blue circle + white paper-plane silhouette) — instantly
  // recognisable, so there's no more ambiguity about what the icon does. Brand colour is
  // fixed (not `currentColor`/theme-tinted) on purpose: a brand mark should look the same
  // in every theme, same as how a real Telegram/WhatsApp/etc. badge never re-themes.
  function buildTelegramIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '12');
    circle.setAttribute('fill', '#29A9EB');
    var plane = document.createElementNS(SVG_NS, 'path');
    plane.setAttribute('fill', '#fff');
    plane.setAttribute('d', 'M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.05-2 1.93c-.23.23-.42.42-.83.42z');
    svg.appendChild(circle);
    svg.appendChild(plane);
    return svg;
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
    var onFeedback = typeof opts.onFeedback === 'function' ? opts.onFeedback : function () {};
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
    h1.textContent = business ? 'AutoReceipt Business' : t('brand.title');
    var sub = document.createElement('div');
    sub.className = 'brand-sub';
    sub.textContent = business ? 'branches · staff · petty-cash, in one place' : t('brand.subtitle');
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
      tgBtn.title = t('brand.telegram_tooltip');
      tgBtn.setAttribute('aria-label', t('brand.telegram_tooltip'));
      tgBtn.appendChild(buildTelegramIcon());
      actions.appendChild(tgBtn);
    }

    // 2026-08-09 (Barat: "remove the appearance option from here and set the new customer
    // service icon"): the gear/Settings shortcut is replaced with a feedback/contact icon
    // for PERSONAL accounts only — Settings itself stays fully reachable via the main nav
    // pills (it's one of the 5 sections), so dropping this header shortcut loses nothing.
    // Business (Premala) keeps the original gear icon exactly as before — untouched.
    if (opts.personalAuth) {
      var feedbackBtn = document.createElement('button');
      feedbackBtn.type = 'button';
      feedbackBtn.className = 'icon-btn icon-btn--lg';
      feedbackBtn.title = t('brand.feedback_tooltip');
      feedbackBtn.setAttribute('aria-label', t('brand.feedback_tooltip'));
      feedbackBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
        + '</svg>';
      feedbackBtn.addEventListener('click', function () { onFeedback(); });
      actions.appendChild(feedbackBtn);
    } else {
      var settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      // 2026-07-27 (Barat: "increase the size") — these three are plain text glyphs
      // (Telegram's own icon above is already a properly-sized SVG); icon-btn--lg
      // bumps just their font-size to match the logout icon's 22px, without
      // touching the shared .icon-btn base size used by icon buttons elsewhere
      // (Team/Templates/etc — business included, unaffected).
      settingsBtn.className = 'icon-btn icon-btn--lg';
      settingsBtn.title = 'Settings';
      settingsBtn.setAttribute('aria-label', 'Settings');
      settingsBtn.textContent = '⚙';
      settingsBtn.addEventListener('click', function () { onSettings(); });
      actions.appendChild(settingsBtn);
    }

    // 2026-07-27: personal accounts only cycle Light(blue/white)/Dark now — see
    // app.js's themeCycleFor(). Business keeps the original three-way label.
    var themeLabel = opts.personalAuth ? t('brand.theme_tooltip_personal') : 'Cycle theme (Light / Warm / Dark)';
    var themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.className = 'icon-btn icon-btn--lg';
    themeBtn.title = themeLabel;
    themeBtn.setAttribute('aria-label', themeLabel);
    themeBtn.textContent = '☾';
    themeBtn.addEventListener('click', function () { onToggleTheme(); });
    actions.appendChild(themeBtn);

    var refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'icon-btn icon-btn--lg';
    refreshBtn.title = t('brand.refresh_tooltip');
    refreshBtn.setAttribute('aria-label', t('brand.refresh_tooltip'));
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
    nav.setAttribute('data-tour', 'nav-root');

    var links = document.createElement('div');
    links.className = 'nav-links';
    var buttons = {};
    sections.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-link';
      btn.setAttribute('data-view', s.id);
      // Purpose-built tour target (2026-08-23) alongside data-view — a fixed prefix
      // means any new section auto-qualifies as a tour target without extra wiring.
      btn.setAttribute('data-tour', 'nav-' + s.id);
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
