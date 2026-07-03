// components/ratemeter.js — the "% used" rate-limit meter (like Claude's usage bar).
// Reads the RateLimit-* trio that lib/ratelimit.js emits (Barat, PR #56), surfaced by
// api.js's onRateLimit subscriber. Renders a small header chip that stays quiet when
// there's plenty of headroom and turns a warning colour near the edge.
//
// The caps are generous (upload/agent 120/min; reads bypass the limiter entirely), so
// this only ever moves on the cost-heavy actions — which is exactly when a user wants
// to see it. Until the first limited response arrives there's no data, so the chip is
// hidden (never a misleading "100%").
//
// TWO layers: a PURE `rateModel` (unit-tested, no DOM) + a render layer (browser only).
// UMD shim: window.RateMeter in the browser; require()-able in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../escape'), require('../api'));
  else root.RateMeter = factory(root.Escape, root.Api);
})(typeof self !== 'undefined' ? self : this, function (Escape, Api) {
  'use strict';

  // ---- pure helper --------------------------------------------------------
  // rate = { limit, remaining, reset } (numbers) -> view model, or null when there's
  // no usable data. usedPct = how much of the window is spent; level drives the colour.
  function rateModel(rate) {
    if (!rate) return null;
    var limit = Number(rate.limit);
    if (!isFinite(limit) || limit <= 0) return null;
    var remaining = Number(rate.remaining);
    if (!isFinite(remaining)) return null;
    remaining = Math.max(0, Math.min(limit, remaining));      // clamp into [0, limit]
    var usedPct = Math.round(((limit - remaining) / limit) * 100);
    var reset = Number(rate.reset);
    reset = isFinite(reset) && reset > 0 ? Math.floor(reset) : 0;
    var level = usedPct >= 90 ? 'critical' : usedPct >= 70 ? 'warn' : 'ok';
    return { limit: limit, remaining: remaining, usedPct: usedPct, level: level, reset: reset };
  }

  // A short human label for the chip. ok = quiet count; warn/critical = adds the reset hint.
  function label(model) {
    if (!model) return '';
    if (model.level === 'ok') return 'Rate ' + model.remaining + '/' + model.limit;
    return model.remaining + ' of ' + model.limit + ' left · resets in ' + model.reset + 's';
  }

  // ---- render layer (browser only) ---------------------------------------
  function hasDom() { return typeof document !== 'undefined'; }

  // mount(container, opts?) -> { update }. Appends a hidden chip; subscribes to Api's
  // rate-limit updates and reveals/repaints it. opts.onRateLimit lets tests inject a fake
  // subscriber instead of the real Api.
  function mount(container, opts) {
    if (!hasDom() || !container) return null;
    opts = opts || {};
    var api = opts.Api || Api;

    var chip = document.createElement('div');
    chip.className = 'rm-chip';
    chip.hidden = true;
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');

    var fill = document.createElement('span');
    fill.className = 'rm-fill';
    var text = document.createElement('span');
    text.className = 'rm-text';
    chip.appendChild(fill);
    chip.appendChild(text);
    container.appendChild(chip);

    function paint(rate) {
      var m = rateModel(rate);
      if (!m) { chip.hidden = true; return; }
      chip.hidden = false;
      chip.className = 'rm-chip rm-chip--' + m.level;
      fill.style.width = m.usedPct + '%';
      Escape.setText(text, label(m));
      chip.setAttribute('title', label(m));
    }

    // paint any value already seen, then subscribe for future ones.
    var subscribe = opts.onRateLimit || (api && api.onRateLimit);
    var current = (api && api.getRateLimit) ? api.getRateLimit() : null;
    if (current) paint(current);
    if (typeof subscribe === 'function') subscribe(paint);

    return { update: paint, el: chip };
  }

  return { rateModel: rateModel, label: label, mount: mount };
});
