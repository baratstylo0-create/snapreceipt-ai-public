// components/tour.js — the auto-play "movie" onboarding tour. A fake cursor moves
// itself around the REAL dashboard, "clicks" real buttons for real, and a
// spotlight+tooltip explain what's happening — the user just watches; Pause/Resume
// and Skip are the only controls (Barat, 2026-08-22: "I WANT ONCE USER CLICK THE
// TOUR THE CURSOR MOVE AUTOMATICALLY AND EXPLAIN TO USER"). This module never
// renders a fake dashboard: every step spotlights a REAL element already on screen
// via app.js's own `deps.switchView`.
//
// Rewrite (2026-08-23, premium onboarding spec): targets now use purpose-built
// `data-tour="..."` attributes (added to overview.js/upload.js/activity.js/nav.js)
// instead of coupling to styling classes; the spotlight's padding is per-step data
// and its border-radius is read live off the target's own computed style (never a
// hardcoded shape); the final step is a genuine completion CARD (no spotlight
// cutout around a random element) with its own "Start Using SnapReceipt AI"
// button instead of a timed auto-advance; a step whose target never appears logs
// one dev-console warning and safely skips instead of leaving dead air.
//
// STEPS is a plain data model (target selector, view to switch to, copy keys,
// autoClick, duration, padding) so the sequence can be read/edited/tested without
// touching the render logic below.
//
// Redesign (2026-08-24, Barat: "I want tour like this" — a Supademo-style walk-
// through): the caption is now one fixed bar bottom-center of the screen instead
// of a speech-bubble tooltip pinned beside each target (that needed an arrow +
// per-side placement math, which broke down on wide targets like the upload drop
// zone). The spotlight alone shows WHERE; the bar explains WHAT — like subtitles.
// Also fixed a real bug found live: the spotlight's accent border/glow box-shadow
// was listed AFTER the dim shadow, so the dim painted over it and every target
// showed as a plain white hole (see tour.css's .tour-spotlight comment).
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

  // padding: how much breathing room the spotlight cutout gives the target, tuned
  // per component KIND (spec: button 5-8px, drop zone/card 6-10px, nav bar 4-8px) —
  // never one fixed number for every shape. radius is intentionally NOT set here;
  // applySpotlight reads the target's own computed border-radius at render time so
  // the cutout always matches the real element instead of a guessed shape.
  // placement/arrow were dropped in the 2026-08-24 redesign — the caption now
  // lives in one fixed bottom-center bar (see tour.css) instead of a speech
  // bubble pinned to each target's side, so there's no per-step side to pick.
  var STEPS = [
    { id: 'welcome', view: null, target: '[data-tour="nav-root"]', padding: 6, titleKey: 'tour.step_1_title', descKey: 'tour.step_1_desc', duration: 4000 },
    { id: 'automation_impact', view: 'overview', target: '[data-tour="automation-impact"]', padding: 8, titleKey: 'tour.step_2_title', descKey: 'tour.step_2_desc', duration: 4500 },
    { id: 'nav_upload', view: 'overview', target: '[data-tour="nav-upload"]', padding: 6, titleKey: 'tour.step_3_title', descKey: 'tour.step_3_desc', autoClick: true, duration: 3000 },
    { id: 'upload_dropzone', view: 'upload', target: '[data-tour="upload-dropzone"]', padding: 8, titleKey: 'tour.step_4_title', descKey: 'tour.step_4_desc', duration: 4500 },
    { id: 'ai_extraction', view: 'upload', target: '[data-tour="ai-extraction-info"]', padding: 6, titleKey: 'tour.step_5_title', descKey: 'tour.step_5_desc', duration: 4500 },
    { id: 'nav_activity', view: 'upload', target: '[data-tour="nav-activity"]', padding: 6, titleKey: 'tour.step_6_title', descKey: 'tour.step_6_desc', autoClick: true, duration: 3000 },
    { id: 'review_toolbar', view: 'activity', target: '[data-tour="review"]', padding: 8, titleKey: 'tour.step_7_title', descKey: 'tour.step_7_desc', duration: 4500 },
    { id: 'anomaly_review', view: 'activity', target: '[data-tour="anomaly-review"]', padding: 8, titleKey: 'tour.step_8_title', descKey: 'tour.step_8_desc', duration: 4500 },
    { id: 'complete', completion: true, titleKey: 'tour.step_9_title', descKey: 'tour.step_9_desc', isLast: true },
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

  var overlayEl, spotlightEl, cursorEl, tooltipEl, stepLabelEl, closeBtn, titleEl, descEl,
    progressBarEl, progressFillEl, skipBtn, pauseBtn, finishBtn;

  function now() { return (root.performance && typeof root.performance.now === 'function') ? root.performance.now() : Date.now(); }
  function raf(fn) { return (root && typeof root.requestAnimationFrame === 'function') ? root.requestAnimationFrame(fn) : setTimeout(fn, 16); }
  function cancelRaf(id) { if (root && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id); else clearTimeout(id); }
  function devWarn(msg) { try { if (root && root.console && typeof root.console.warn === 'function') root.console.warn('[Tour] ' + msg); } catch (e) { /* ignore */ } }

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

    // Completion-only action, hidden the rest of the tour — see renderCompletion().
    finishBtn = el('button', 'tour-tooltip-finish');
    finishBtn.type = 'button';
    finishBtn.hidden = true;
    Escape.setText(finishBtn, t('tour.finish'));
    finishBtn.addEventListener('click', function () { end(true); });
    tooltipEl.appendChild(finishBtn);

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

  // Reads the target's OWN computed border-radius so the spotlight cutout matches
  // its real shape (a circular icon gets a circular cutout, a card gets its own
  // rounded corners) instead of one hardcoded shape for every kind of target.
  function targetRadius(targetEl) {
    try {
      var cs = root.getComputedStyle ? root.getComputedStyle(targetEl) : null;
      var r = cs && cs.borderRadius;
      if (r && r !== '0px') return r;
    } catch (e) { /* ignore */ }
    return 'var(--radius-sm)';
  }

  function applySpotlight(rect, padding, radius) {
    var pad = typeof padding === 'number' ? padding : 8;
    spotlightEl.style.top = (rect.top - pad) + 'px';
    spotlightEl.style.left = (rect.left - pad) + 'px';
    spotlightEl.style.width = (rect.width + pad * 2) + 'px';
    spotlightEl.style.height = (rect.height + pad * 2) + 'px';
    spotlightEl.style.borderRadius = radius || 'var(--radius-sm)';
  }

  // The caption bar (tour.css .tour-tooltip) is fixed bottom-center by CSS —
  // only the spotlight and cursor need repositioning per target now.
  function reposition() {
    if (!active) return;
    if (STEPS[stepIndex] && STEPS[stepIndex].completion) return; // centered by CSS, nothing to recalc
    if (!lastTargetEl) return;
    if (!document.body.contains(lastTargetEl)) { playStep(stepIndex + 1); return; }
    var rect = lastTargetEl.getBoundingClientRect();
    var step = STEPS[stepIndex];
    applySpotlight(rect, step.padding, targetRadius(lastTargetEl));
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

    if (step.completion) { renderCompletion(step); return; }

    try {
      if (step.view && typeof currentDeps.switchView === 'function') currentDeps.switchView(step.view);
    } catch (e) { /* ignore — still try to find the target on whatever view is current */ }

    waitForTarget(step.target, function (targetEl) {
      if (!active || gen !== myGen) return; // superseded by skip/end mid-wait
      if (!targetEl) {
        devWarn('target not found: ' + step.target + ' — skipping step ' + (index + 1));
        playStep(index + 1);
        return;
      }
      proceedWithTarget(targetEl, step, myGen);
    });
  }

  // Runs one step's whole show: label the target, scroll it into view, then once
  // the scroll settles — spotlight it, fly the fake cursor to it, start the
  // progress timer, and (for autoClick steps) actually click it for real.
  function proceedWithTarget(targetEl, step, myGen) {
    setCompletionMode(false);
    if (lastTargetEl && lastTargetEl !== targetEl) lastTargetEl.classList.remove('tour-target');
    lastTargetEl = targetEl;
    targetEl.classList.add('tour-target');

    Escape.setText(stepLabelEl, tp('tour.step_counter', stepIndex + 1, STEPS.length));
    Escape.setText(titleEl, t(step.titleKey));
    Escape.setText(descEl, t(step.descKey));
    Escape.setText(closeBtn, '✕');
    Escape.setText(skipBtn, t('tour.skip'));
    flashCaption();

    try { targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* older browsers */ }

    setTimeout(function () {
      if (gen !== myGen || !active) return;
      var rect = targetEl.getBoundingClientRect();
      applySpotlight(rect, step.padding, targetRadius(targetEl));
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

  // Toggles the tour chrome between "spotlighting a real element" and "centered
  // completion card" — swaps which action row is visible and lets tour.css's
  // .tour-tooltip.tour-complete rule take over centering instead of the
  // bottom-bar position this module leaves to CSS everywhere else.
  function setCompletionMode(on) {
    tooltipEl.classList.toggle('tour-complete', on);
    overlayEl.classList.toggle('tour-complete', on);
    spotlightEl.hidden = on;
    cursorEl.hidden = on;
    progressBarEl.hidden = on;
    skipBtn.hidden = on;
    pauseBtn.hidden = on;
    finishBtn.hidden = !on;
  }

  // Re-triggers the caption bar's fade+rise transition (tour.css .is-visible)
  // every time a new step's text is written in — removing then re-adding the
  // class in the same tick would get coalesced into one paint by the browser,
  // so a forced reflow (reading offsetWidth) sits between the two to make sure
  // the "hidden" state actually commits first.
  function flashCaption() {
    tooltipEl.classList.remove('is-visible');
    void tooltipEl.offsetWidth;
    tooltipEl.classList.add('is-visible');
  }

  // The final step: no target, no timer, no spotlight — a clean completion card
  // (spec: "do not spotlight a random UI element") with one explicit action.
  function renderCompletion(step) {
    stopTimer();
    if (lastTargetEl) { lastTargetEl.classList.remove('tour-target'); lastTargetEl = null; }
    setCompletionMode(true);
    Escape.setText(stepLabelEl, tp('tour.step_counter', stepIndex + 1, STEPS.length));
    Escape.setText(titleEl, t(step.titleKey));
    Escape.setText(descEl, t(step.descKey));
    Escape.setText(closeBtn, '✕');
    Escape.setText(finishBtn, t('tour.finish'));
    flashCaption();
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
