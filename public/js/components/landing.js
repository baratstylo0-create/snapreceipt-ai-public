// components/landing.js — marketing entry screen shown before Create account.
//
// This is the very first thing a fresh personalAuth visitor sees. It does not
// gate anything itself — it is pure marketing chrome in front of the real
// gates (Onboarding's signup step, Login) which still enforce everything they
// always did. Two ways forward:
//   "Login"            -> opts.onLogin()    (existing account)
//   "Register"/"Try it" -> opts.onRegister() (new account -> Onboarding)
//
// 2026-07-28: "The Receipt, Transformed" — replaces the earlier dark-navbar +
// donut-chart hero. Reviewed as a standalone preview (public/landing-preview.html/
// .css) before being ported here — see that file's own history/comments for the
// design iteration (Barat: "change layout and color... give me idea" -> preview ->
// "recreate" a real Telegram screenshot of the bot -> "analyze animation" -> "make
// it live"). The signature element is a recreation of that real screenshot (see
// buildTelegramWindow below), not an abstract stat card — it tells "send a photo
// -> get structured data" as one visual instead of a headline.
//
// Same conventions as every other component: pure DOM (createElement/textContent
// for all dynamic/user-controlled text; the small SVG icons below are static,
// trusted, non-interpolated markup — same precedent as onboarding.js/login.js's
// Google icon), UMD shim.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'));
  } else {
    root.Landing = factory(root.Escape, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function text(tag, className, value) { var n = el(tag, className); Escape.setText(n, value); return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // Static icon markup (no dynamic/user data ever passed through innerHTML).
  var ICON_SEARCH = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="#7d8b99" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#7d8b99" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_DOTS = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="#7d8b99"/><circle cx="12" cy="12" r="1.8" fill="#7d8b99"/><circle cx="19" cy="12" r="1.8" fill="#7d8b99"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 16 11" width="14" height="10" aria-hidden="true"><path d="M1 5.5 4.5 9 10 2M6 9 11.5 2.5" fill="none" stroke="#8fd6ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // A recreation of a real Telegram screenshot of the bot — not a live/interactive
  // widget, an illustration. The sent "photo" is a stylized drawing of a receipt
  // (grey bars standing in for printed lines), not a copy of any real photographed
  // receipt. Copy is the SUCCESS path (the real screenshot happened to show a
  // "blurry, please resend" reply — this is the marketing story, not a bug report).
  function buildTelegramWindow() {
    var win = el('div', 'tg-window');

    var header = el('div', 'tg-header');
    var avatar = text('div', 'tg-header-avatar', 'RA');
    var info = el('div', 'tg-header-info');
    info.appendChild(text('div', 'tg-header-name', 'SnapReceipt AI (personal)'));
    info.appendChild(text('div', 'tg-header-sub', 'bot'));
    var icons = el('div', 'tg-header-icons');
    var searchIcon = el('span', ''); searchIcon.innerHTML = ICON_SEARCH;
    var dotsIcon = el('span', ''); dotsIcon.innerHTML = ICON_DOTS;
    icons.appendChild(searchIcon);
    icons.appendChild(dotsIcon);
    header.appendChild(avatar);
    header.appendChild(info);
    header.appendChild(icons);
    win.appendChild(header);

    var body = el('div', 'tg-body');

    // the sent receipt photo
    var sentRow = el('div', 'tg-msg-row tg-msg-row--sent');
    var photo = el('div', 'tg-photo-mock');
    photo.appendChild(el('div', 'tg-scan-line'));
    [70, 90, 60, 80].forEach(function (w) {
      var line = el('div', 'tg-photo-line');
      line.style.width = w + '%';
      photo.appendChild(line);
    });
    var totalLine = el('div', 'tg-photo-line tg-photo-line--total');
    totalLine.style.width = '75%';
    photo.appendChild(totalLine);
    photo.appendChild(el('span', 'tg-photo-corner'));
    var meta = el('span', 'tg-photo-meta');
    meta.appendChild(document.createTextNode('4:47 PM '));
    var checkIcon = el('span', ''); checkIcon.innerHTML = ICON_CHECK;
    meta.appendChild(checkIcon);
    photo.appendChild(meta);
    sentRow.appendChild(photo);
    body.appendChild(sentRow);

    // typing indicator
    var typingRow = el('div', 'tg-msg-row');
    var typing = el('div', 'tg-typing');
    typing.appendChild(el('span', 'tg-typing-dot'));
    typing.appendChild(el('span', 'tg-typing-dot'));
    typing.appendChild(el('span', 'tg-typing-dot'));
    typingRow.appendChild(typing);
    body.appendChild(typingRow);

    // "reading your receipt" reply
    var readingRow = el('div', 'tg-msg-row');
    var readingMsg = el('div', 'tg-msg');
    var readingIcon = text('span', 'tg-msg-icon', '📄');
    readingMsg.appendChild(readingIcon);
    readingMsg.appendChild(document.createTextNode(' ' + t('landing.tg_reading')));
    readingMsg.appendChild(document.createElement('br'));
    readingMsg.appendChild(document.createTextNode(t('landing.tg_reading_2')));
    readingMsg.appendChild(text('div', 'tg-msg-time', '4:47 PM'));
    readingRow.appendChild(readingMsg);
    body.appendChild(readingRow);

    // success reply
    var successRow = el('div', 'tg-msg-row');
    var successMsg = el('div', 'tg-msg tg-msg--success');
    successMsg.appendChild(text('span', 'tg-msg-icon', '✅'));
    successMsg.appendChild(document.createTextNode(' ' + t('landing.tg_success_prefix')));
    var strong = el('strong', ''); Escape.setText(strong, 'Groceries');
    successMsg.appendChild(strong);
    successMsg.appendChild(document.createTextNode(t('landing.tg_success_suffix')));
    successMsg.appendChild(text('div', 'tg-msg-time', '4:48 PM'));
    successRow.appendChild(successMsg);
    body.appendChild(successRow);

    win.appendChild(body);
    return win;
  }

  function stepStrip() {
    var wrap = el('div', 'landing-steps');
    wrap.id = 'landing-how';
    wrap.appendChild(text('h2', 'landing-steps-title', t('landing.how_it_works')));
    var list = el('div', 'landing-steps-list');
    [
      ['01', t('landing.step1_title'), t('landing.step1_desc')],
      ['02', t('landing.step2_title'), t('landing.step2_desc')],
      ['03', t('landing.step3_title'), t('landing.step3_desc')],
    ].forEach(function (s) {
      var card = el('div', 'landing-step-card');
      card.appendChild(text('div', 'landing-step-num', s[0]));
      card.appendChild(text('h3', 'landing-step-title', s[1]));
      card.appendChild(text('p', 'landing-step-desc', s[2]));
      list.appendChild(card);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // buildWordmark() — use the shared SVG brand asset so the website and downloadable logo
  // cannot drift apart. The dark navigation variant keeps the supplied wordmark readable.
  function buildWordmark() {
    var logo = el('img', 'landing-wordmark');
    logo.src = 'icons/snapreceipt-wordmark-dark.svg';
    logo.alt = 'Snap Receipt AI';
    return logo;
  }

  // mount(container, opts) -> { el, destroy }
  //   opts.onLogin()    — required, called when "Login" is clicked
  //   opts.onRegister() — required, called when "Register"/"Try for Free" is clicked
  function mount(container, opts) {
    if (!hasDom() || !container) return null;
    opts = opts || {};

    var root = el('div', 'landing-root');

    // --- nav ---
    var nav = el('div', 'landing-nav');
    var navLeft = el('div', 'landing-nav-brand');
    // Wordmark (2026-07-29): two-tone text logo — "Snap" (ink) + "Receipt" (blue) + an "AI"
    // badge (blue pill, white text) — matches the reference wordmark exactly. Built from
    // plain spans/CSS, not an image, so it stays crisp at any size and needs no asset file.
    navLeft.appendChild(buildWordmark());
    nav.appendChild(navLeft);

    var navRight = el('div', 'landing-nav-actions');
    var loginBtn = text('button', 'landing-nav-btn landing-nav-btn--login', t('landing.login'));
    loginBtn.type = 'button';
    loginBtn.addEventListener('click', function () { if (typeof opts.onLogin === 'function') opts.onLogin(); });
    var registerBtn = text('button', 'landing-nav-btn landing-nav-btn--register', t('landing.register'));
    registerBtn.type = 'button';
    registerBtn.addEventListener('click', function () { if (typeof opts.onRegister === 'function') opts.onRegister(); });
    navRight.appendChild(loginBtn);
    navRight.appendChild(registerBtn);
    nav.appendChild(navRight);
    root.appendChild(nav);

    // --- hero ---
    var hero = el('div', 'landing-hero');
    var heroCopy = el('div', 'landing-hero-copy');
    var eyebrow = el('div', 'landing-eyebrow'); eyebrow.textContent = t('landing.eyebrow');
    heroCopy.appendChild(eyebrow);
    var title = el('h1', 'landing-hero-title');
    title.appendChild(document.createTextNode(t('landing.hero_title_1')));
    var em = el('em', ''); Escape.setText(em, t('landing.hero_title_em'));
    title.appendChild(em);
    title.appendChild(document.createTextNode(t('landing.hero_title_2')));
    heroCopy.appendChild(title);
    heroCopy.appendChild(text('p', 'landing-hero-sub', t('landing.hero_sub')));

    var ctaRow = el('div', 'landing-cta-row');
    var tryBtn = text('button', 'landing-btn landing-btn--primary', t('landing.try_free'));
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', function () { if (typeof opts.onRegister === 'function') opts.onRegister(); });
    var learnBtn = text('button', 'landing-btn landing-btn--secondary', t('landing.learn_more'));
    learnBtn.type = 'button';
    learnBtn.addEventListener('click', function () {
      var target = root.querySelector('#landing-how');
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    ctaRow.appendChild(tryBtn);
    ctaRow.appendChild(learnBtn);
    heroCopy.appendChild(ctaRow);
    hero.appendChild(heroCopy);

    var visual = el('div', 'landing-hero-visual');
    visual.appendChild(buildTelegramWindow());
    visual.appendChild(text('div', 'landing-hero-caption', t('landing.hero_caption')));
    hero.appendChild(visual);
    root.appendChild(hero);

    root.appendChild(stepStrip());

    clear(container);
    container.appendChild(root);
    // Full-bleed marketing surface — cancels .app-header/.app-main/.app-footer's
    // padding + centered max-width (and the parchment body backdrop) just while
    // Landing is mounted, so its own dark navbar/hero reach the real edges.
    if (document.body) document.body.classList.add('landing-mode');
    return {
      el: root,
      destroy: function () {
        clear(root);
        if (document.body) document.body.classList.remove('landing-mode');
      },
    };
  }

  return { mount: mount };
});
