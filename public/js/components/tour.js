// components/tour.js — the auto-play "movie" onboarding tour (2026-08-22, Barat:
// "I WANT ONCE USER CLICK THE TOUR THE CURSOR MOVE AUTOMATICALLY AND EXPLAIN TO
// USER" — rewritten from the earlier click-through design after live QA both
// confirmed it worked AND surfaced that Barat wanted something else entirely).
// This module never renders a fake dashboard: every step spotlights a REAL element
// already on screen (nav buttons, metric tiles, the upload zone, the review queue)
// via app.js's own `deps.switchView`. A fake on-screen cursor glides to each target;
// for `autoClick` steps it then calls the REAL element's `.click()` — firing the
// app's own handlers, genuine navigation, never simulated input on a fake UI. The
// user just watches a per-step progress bar fill and auto-advance; Pause/Resume and
// Skip are the only controls.
//
// STEPS is a plain data model (target selector, view to switch to, copy keys,
// autoClick, duration) so the sequence can be read/edited/tested without touching
// the render logic below.
//
// CSP: every node is createElement/createElementNS + Escape.setText (no innerHTML);
// positioning uses element.style.top/left assignments, the same pattern already used
// by render.js's buildInfoIcon and overview.js's info popovers under this app's
// strict CSP.
//
// UMD shim: window.Tour in the browser; require()-able in Node (start() no-ops
// without a DOM, so the module — and its pure STEPS export — is test-safe).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../i18n'));
  } else {
    root.Tour = factory(root.Escape, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, I18n) {
  'use strict';

  var root = typeof self !== 'undefined' ? self : this;
  var STORAGE_KEY = 'tour_completed';

  var STEPS = [
    { id: 'welcome', view: null, target: 'nav.nav', placement: 'bottom', titleKey: 'tour.step_1_title', descKey: 'tour.step_1_desc', duration: 4000 },
    { id: 'metrics', view: 'overview', target: '.ov-metrics-tiles', placement: 'bottom', titleKey: 'tour.step_2_title', descKey: 'tour.step_2_desc', duration: 4000 },
    { id: 'nav_upload', view: 'overview', target: 'button[data-view="upload"]', placement: 'bottom', titleKey: 'tour.step_3_title', descKey: 'tour.step_3_desc', autoClick: true, duration: 3000 },
    { id: 'upload_zone', view: 'upload', target: '.up-zone', placement: 'top', titleKey: 'tour.step_4_title', descKey: 'tour.step_4_desc', duration: 4000 },
    { id: 'nav_activity', view: 'upload', target: 'button[data-view="activity"]', placement: 'bottom', titleKey: 'tour.step_5_title', descKey: 'tour.step_5_desc', autoClick: true, duration: 3000 },
    { id: 'activity_toolbar', view: 'activity', target: '.act-toolbar', placement: 'bottom', titleKey: 'tour.step_6_title', descKey: 'tour.step_6_desc', duration: 4000 },
    { id: 'activity_review', view: 'activity', target: '.act-review-area', placement: 'top', titleKey: 'tour.step_7_title', descKey: 'tour.step_7_desc', duration: 4000 },
    { id: 'settings', view: 'activity', target: 'button[data-view="settings"]', placement: 'bottom', titleKey: 'tour.step_8_title', descKey: 'tour.step_8_desc', autoClick: true, duration: 3000 },
    { id: 'finish', view: 'settings', target: 'nav.nav', placement: 'bottom', titleKey: 'tour.step_9_title', descKey: 'tour.step_9_desc', duration: 5000, isLast: true },
  ];

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function ls() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function isCompleted() {
    var s = ls();
    try { return !!s && s.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }
  function markCompleted() {
    var s = ls();
    try { if (s) s.setItem(STORAGE_KEY, '1'); } catch (e) { /* ignore */ }
  }
  function resetCompleted() {
    var s = ls();
    try { if (s) s.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  // --- single-instance runtime state (only one tour can run at a time) ---
  var active = false;
  var currentDeps = null;
  var stepIndex = 0;
  var lastTargetEl = null;
  var resizeTimer = null;
  // Bumped every time a step starts; async callbacks (waitForTarget, the cursor's
  // travel/click setTimeouts, the progress rAF loop) capture the value at their
  // start and bail if it's moved on — the single guard that replaces the old
  // per-callsite `stepIndex !== index` checks now that several async chains can be
  // in flight for one step (move → click → progress) instead of just one.
  var gen = 0;
  var paused = false;
  var pausedAccumulator = 0;
  var pauseStartTs = 0;
  var stepStartTs = 0;
  var currentDuration = 0;
  var timerRAF = null;

  var CURSOR_TRAVEL_MS = 650; // just past tour.css's 0.6s cursor transition
  var CLICK_FIRE_DELAY_MS = 150; // lets the click animation read before the real click fires

  var overlayEl, spotlightEl, cursorEl, tooltipEl, arrowEl, stepLabelEl, closeBtn, titleEl, descEl, progressBarEl, progressFillEl, skipBtn, pauseBtn;

  function now() { return (root.performance && typeof root.performance.now === 'function') ? root.performance.now() : Date.now(); }
  function raf(fn) { return (root && typeof root.requestAnimationFrame === 'function') ? root.requestAnimationFrame(fn) : setTimeout(fn, 16); }
  function cancelRaf(id) { if (root && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id); else clearTimeout(id); }

  function t(key) {
    var I = (currentDeps && currentDeps.I18n) || I18n;
    return (I && typeof I.t === 'function') ? I.t(key) : key;
  }
  function tp(key) {
    var I = (currentDeps && currentDeps.I18n) || I18n;
    var args = Array.prototype.slice.call(arguments, 1);
    if (I && typeof I.tp === 'function') return I.tp.apply(I, [key].concat(args));
    return key;
  }

  // A simple pointer/arrow glyph — createElementNS throughout (never innerHTML) to
  // stay inside the app's strict CSP.
  function buildCursorSvg() {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'tour-cursor-arrow');
    path.setAttribute('d', 'M3 2 L21 12 L12.5 13.5 L9 21 Z');
    svg.appendChild(path);
    return svg;
  }

  function buildChrome() {
    overlayEl = el('div', 'tour-overlay');
    spotlightEl = el('div', 'tour-spotlight');

    cursorEl = el('div', 'tour-cursor');
    cursorEl.appendChild(buildCursorSvg());

    tooltipEl = el('div', 'tour-tooltip');
    tooltipEl.setAttribute('role', 'dialog');
    tooltipEl.setAttribute('aria-modal', 'false');
    arrowEl = el('div', 'tour-tooltip-arrow');
    tooltipEl.appendChild(arrowEl);

    var header = el('div', 'tour-tooltip-header');
    stepLabelEl = el('span', 'tour-tooltip-step');
    header.appendChild(stepLabelEl);
    closeBtn = el('button', 'tour-tooltip-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('tour.close_aria'));
    Escape.setText(closeBtn, '✕');
    closeBtn.addEventListener('click', function () { end(true); });
    header.appendChild(closeBtn);
    tooltipEl.appendChild(header);

    titleEl = el('h3', 'tour-tooltip-title');
    tooltipEl.appendChild(titleEl);
    descEl = el('p', 'tour-tooltip-desc');
    tooltipEl.appendChild(descEl);

    progressBarEl = el('div', 'tour-progress-bar');
    progressFillEl = el('div', 'tour-progress-fill');
    progressBarEl.appendChild(progressFillEl);
    tooltipEl.appendChild(progressBarEl);

    var actions = el('div', 'tour-tooltip-actions');
    skipBtn = el('button', 'tour-tooltip-skip');
    skipBtn.type = 'button';
    Escape.setText(skipBtn, t('tour.skip'));
    skipBtn.addEventListener('click', function () { end(true); });
    actions.appendChild(skipBtn);

    pauseBtn = el('button', 'tour-tooltip-pause');
    pauseBtn.type = 'button';
    Escape.setText(pauseBtn, t('tour.pause'));
    pauseBtn.addEventListener('click', function () { togglePause(); });
    actions.appendChild(pauseBtn);

    tooltipEl.appendChild(actions);

    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
    document.body.appendChild(cursorEl);
    document.body.appendChild(tooltipEl);
  }

  function removeChrome() {
    [overlayEl, spotlightEl, cursorEl, tooltipEl].forEach(function (n) {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
    overlayEl = spotlightEl = cursorEl = tooltipEl = null;
  }

  function waitForTarget(selector, cb) {
    var tries = 0;
    var maxTries = 20; // ~3s at 150ms — long enough for a lazy view load, short enough to feel responsive
    (function attempt() {
      var found = null;
      try { found = document.querySelector(selector); } catch (e) { found = null; }
      if (found && document.body.contains(found)) { cb(found); return; }
      tries += 1;
      if (tries >= maxTries) { cb(null); return; }
      setTimeout(attempt, 150);
    })();
  }

  function applySpotlight(rect) {
    var pad = 8;
    spotlightEl.style.top = (rect.top - pad) + 'px';
    spotlightEl.style.left = (rect.left - pad) + 'px';
    spotlightEl.style.width = (rect.width + pad * 2) + 'px';
    spotlightEl.style.height = (rect.height + pad * 2) + 'px';
  }

  // Places the tooltip next to `rect`, flipping across the axis if the preferred
  // side has no room, clamping to a 16px viewport margin, then nudging the arrow
  // so it still points at the target's own center even after clamping.
  function positionTooltip(rect, placement) {
    // documentElement.clientWidth/Height (the layout viewport) is what `position: fixed`
    // is actually constrained by; root.innerWidth/Height can diverge from it (mobile
    // browser chrome, pinch-zoom, some emulated viewports) and clamping against the
    // wrong one lets the tooltip render past the real edge of the screen.
    var vw = document.documentElement.clientWidth || (root && root.innerWidth) || 320;
    var vh = document.documentElement.clientHeight || (root && root.innerHeight) || 480;
    var margin = 16, gap = 14;
    var tw = tooltipEl.offsetWidth || 340;
    var th = tooltipEl.offsetHeight || 160;
    var vertical = placement === 'top' || placement === 'bottom';
    var side = placement;

    if (vertical) {
      var roomBelow = vh - rect.bottom;
      var roomAbove = rect.top;
      if (side === 'bottom' && roomBelow < th + gap + margin && roomAbove > roomBelow) side = 'top';
      if (side === 'top' && roomAbove < th + gap + margin && roomBelow > roomAbove) side = 'bottom';
      var top = side === 'bottom' ? rect.bottom + gap : rect.top - th - gap;
      top = clamp(top, margin, vh - th - margin);
      var targetCenterX = rect.left + rect.width / 2;
      var left = clamp(targetCenterX - tw / 2, margin, vw - tw - margin);
      tooltipEl.style.top = top + 'px';
      tooltipEl.style.left = left + 'px';
      var arrowX = clamp(targetCenterX - left - 7, margin, tw - margin - 14);
      arrowEl.style.left = arrowX + 'px';
      arrowEl.style.top = '';
    } else {
      var roomRight = vw - rect.right;
      var roomLeft = rect.left;
      if (side === 'right' && roomRight < tw + gap + margin && roomLeft > roomRight) side = 'left';
      if (side === 'left' && roomLeft < tw + gap + margin && roomRight > roomLeft) side = 'right';
      var leftPos = side === 'right' ? rect.right + gap : rect.left - tw - gap;
      leftPos = clamp(leftPos, margin, vw - tw - margin);
      var targetCenterY = rect.top + rect.height / 2;
      var topPos = clamp(targetCenterY - th / 2, margin, vh - th - margin);
      tooltipEl.style.top = topPos + 'px';
      tooltipEl.style.left = leftPos + 'px';
      var arrowY = clamp(targetCenterY - topPos - 7, margin, th - margin - 14);
      arrowEl.style.top = arrowY + 'px';
      arrowEl.style.left = '';
    }
    tooltipEl.setAttribute('data-placement', side);
  }

  function reposition() {
    if (!active || !lastTargetEl) return;
    if (!document.body.contains(lastTargetEl)) { playStep(stepIndex + 1); return; }
    var rect = lastTargetEl.getBoundingClientRect();
    applySpotlight(rect);
    positionTooltip(rect, STEPS[stepIndex].placement || 'bottom');
    moveCursorTo(rect);
  }

  function moveCursorTo(rect) {
    cursorEl.style.left = (rect.left + rect.width / 2) + 'px';
    cursorEl.style.top = (rect.top + rect.height / 2) + 'px';
  }

  function playClickAnimation(rect) {
    cursorEl.classList.add('is-clicking');
    setTimeout(function () { cursorEl.classList.remove('is-clicking'); }, 420);

    var ripple = el('div', 'tour-cursor-ripple');
    ripple.style.left = (rect.left + rect.width / 2) + 'px';
    ripple.style.top = (rect.top + rect.height / 2) + 'px';
    document.body.appendChild(ripple);
    setTimeout(function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 520);
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reposition, 100);
  }

  function onKeydown(ev) {
    if (ev.key === 'Escape' && active) end(true);
  }

  function stopTimer() {
    if (timerRAF != null) { cancelRaf(timerRAF); timerRAF = null; }
  }

  function updatePauseBtn() {
    Escape.setText(pauseBtn, paused ? t('tour.resume') : t('tour.pause'));
  }

  function togglePause() {
    if (!active) return;
    if (paused) {
      pausedAccumulator += now() - pauseStartTs;
      paused = false;
    } else {
      paused = true;
      pauseStartTs = now();
    }
    updatePauseBtn();
  }

  // Fills the progress bar over `duration`, auto-advancing to the next step when
  // it completes — this is the tour's only forward motion now that nothing waits
  // for a click. `myGen` pins this loop to the step that started it: if `gen` has
  // moved on (skip, end, or a later step already started) the loop quietly stops.
  function startTimer(duration, myGen) {
    currentDuration = duration;
    stepStartTs = now();
    pausedAccumulator = 0;
    paused = false;
    updatePauseBtn();
    progressFillEl.style.width = '0%';
    tickProgress(myGen);
  }

  function tickProgress(myGen) {
    if (gen !== myGen || !active) return;
    if (paused) {
      timerRAF = raf(function () { tickProgress(myGen); });
      return;
    }
    var elapsed = now() - stepStartTs - pausedAccumulator;
    var pct = clamp((elapsed / currentDuration) * 100, 0, 100);
    progressFillEl.style.width = pct + '%';
    if (elapsed >= currentDuration) { playStep(stepIndex + 1); return; }
    timerRAF = raf(function () { tickProgress(myGen); });
  }

  function playStep(index) {
    if (!active) return;
    stopTimer();
    if (index < 0) index = 0;
    if (index >= STEPS.length) { end(true); return; }
    var step = STEPS[index];
    stepIndex = index;
    var myGen = ++gen;

    try {
      if (step.view && typeof currentDeps.switchView === 'function') currentDeps.switchView(step.view);
    } catch (e) { /* ignore — still try to find the target on whatever view is current */ }

    waitForTarget(step.target, function (targetEl) {
      if (!active || gen !== myGen) return; // superseded by skip/end mid-wait
      if (!targetEl) { playStep(index + 1); return; }
      proceedWithTarget(targetEl, step, myGen);
    });
  }

  // Runs one step's whole show: label the target, scroll it into view, then once
  // the scroll settles — spotlight it, fly the fake cursor to it, start the
  // progress timer, and (for autoClick steps) actually click it for real.
  function proceedWithTarget(targetEl, step, myGen) {
    if (lastTargetEl && lastTargetEl !== targetEl) lastTargetEl.classList.remove('tour-target');
    lastTargetEl = targetEl;
    targetEl.classList.add('tour-target');

    Escape.setText(stepLabelEl, tp('tour.step_counter', stepIndex + 1, STEPS.length));
    Escape.setText(titleEl, t(step.titleKey));
    Escape.setText(descEl, t(step.descKey));
    Escape.setText(closeBtn, '✕');
    Escape.setText(skipBtn, t('tour.skip'));

    try { targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* older browsers */ }

    setTimeout(function () {
      if (gen !== myGen || !active) return;
      var rect = targetEl.getBoundingClientRect();
      applySpotlight(rect);
      positionTooltip(rect, step.placement || 'bottom');
      moveCursorTo(rect);
      startTimer(step.duration || 4000, myGen);

      if (step.autoClick) {
        setTimeout(function () {
          if (gen !== myGen || !active) return;
          playClickAnimation(targetEl.getBoundingClientRect());
          setTimeout(function () {
            if (gen !== myGen || !active) return;
            // The real element's own click — fires the app's own handlers (real
            // navigation), never a simulated event on a fake UI.
            try { targetEl.click(); } catch (e) { /* ignore */ }
          }, CLICK_FIRE_DELAY_MS);
        }, CURSOR_TRAVEL_MS);
      }
    }, 400); // let the smooth scroll settle before measuring/animating
  }

  function end(markDone) {
    active = false;
    gen++; // invalidate any in-flight waitForTarget/cursor/progress callbacks
    stopTimer();
    clearTimeout(resizeTimer);
    if (root && root.removeEventListener) {
      root.removeEventListener('resize', onResize);
      root.removeEventListener('scroll', onResize, true);
    }
    document.removeEventListener('keydown', onKeydown);
    if (lastTargetEl) { lastTargetEl.classList.remove('tour-target'); lastTargetEl = null; }
    removeChrome();
    if (markDone) markCompleted();
  }

  function start(deps) {
    if (!hasDom() || active) return;
    currentDeps = deps || {};
    active = true;
    stepIndex = 0;
    paused = false;
    pausedAccumulator = 0;
    buildChrome();
    document.addEventListener('keydown', onKeydown);
    if (root && root.addEventListener) {
      root.addEventListener('resize', onResize);
      root.addEventListener('scroll', onResize, true);
    }
    playStep(0);
  }

  return {
    start: start,
    end: function () { end(true); },
    isCompleted: isCompleted,
    reset: resetCompleted,
    STEPS: STEPS,
  };
});
