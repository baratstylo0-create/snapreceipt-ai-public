// components/overview.js — the Overview screen: KPI cards + a Profit&Loss-style
// bar chart drawn from GET /api/reports.
//
// TWO layers, kept apart so the math is unit-testable without a DOM:
//   1. PURE transforms (chartModel / kpiModel / topCategory) — reports JSON ->
//      plain arrays of {label,value}. No DOM, no escaping (the render layer owns
//      escaping), no throwing on junk input. Covered by tests/frontend/overview.test.js.
//   2. RENDER layer (mount + render*) — builds real DOM with createElement /
//      createElementNS + textContent + Escape.setText. NEVER innerHTML with data.
//      No-ops outside a browser. Loading / empty / error states live here.
//
// UMD shim: window.Overview in the browser; require()-able in Node (where the
// render layer simply isn't exercised — no document).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../format'), require('../api'));
  } else {
    root.Overview = factory(root.Escape, root.Format, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---- pure helpers -------------------------------------------------------

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function buckets(reports) {
    return reports && Array.isArray(reports.buckets) ? reports.buckets : [];
  }

  // reports.buckets -> [{label, value}] in bucket order. Raw labels (escaped at
  // render time), coerced numeric values, tolerant of missing/garbage fields.
  function chartModel(reports) {
    return buckets(reports).map(function (b) {
      var key = b && b.key !== undefined && b.key !== null ? String(b.key) : '';
      return { label: key, value: toNum(b && b.total) };
    });
  }

  // Sum byCategory across every bucket and return the biggest {name, total},
  // or null when there is no positive category spend.
  function topCategory(reports) {
    var totals = {};
    buckets(reports).forEach(function (b) {
      var byCat = b && b.byCategory;
      if (!byCat || typeof byCat !== 'object') return;
      Object.keys(byCat).forEach(function (cat) {
        totals[cat] = (totals[cat] || 0) + toNum(byCat[cat]);
      });
    });
    var best = null;
    Object.keys(totals).forEach(function (cat) {
      if (totals[cat] > 0 && (!best || totals[cat] > best.total)) best = { name: cat, total: totals[cat] };
    });
    return best;
  }

  // reports totals -> KPI cards [{label, value}]. Values are display strings;
  // the top-category name is kept RAW so the render layer escapes it (asserted
  // by the tests). Never throws on null/undefined.
  function kpiModel(reports) {
    var r = reports || {};
    var top = topCategory(r);
    return [
      { label: 'Total spend', value: Format.formatMoney(r.total) },
      { label: 'Expenses', value: Format.formatCount(r.count) },
      { label: 'Top category', value: top ? top.name : '—' },
      { label: 'Periods', value: Format.formatCount(buckets(r).length) },
    ];
  }

  // ---- DOM helpers (browser only) ----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // Clear a node without innerHTML.
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function renderKpis(cards) {
    var wrap = el('div', 'ov-kpis');
    cards.forEach(function (c) {
      var card = el('div', 'ov-kpi');
      var label = el('div', 'ov-kpi-label');
      Escape.setText(label, c.label);
      var value = el('div', 'ov-kpi-value');
      Escape.setText(value, c.value);        // untrusted (e.g. category name) -> escaped
      card.appendChild(label);
      card.appendChild(value);
      wrap.appendChild(card);
    });
    return wrap;
  }

  // Plain inline SVG bar chart (no library). Bars scaled to the max value;
  // each bar labelled with its bucket key and value, both via Escape.setText on
  // <title>/<text> textContent. Returns the <figure> wrapper.
  function renderChart(rows) {
    var figure = el('figure', 'ov-chart');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, 'Spend by period');
    figure.appendChild(caption);

    var width = 640, height = 260, padL = 8, padR = 8, padTop = 8, padBottom = 44;
    var plotW = width - padL - padR;
    var plotH = height - padTop - padBottom;
    var max = rows.reduce(function (m, r) { return r.value > m ? r.value : m; }, 0);
    var denom = max > 0 ? max : 1;
    var n = rows.length;
    var slot = n > 0 ? plotW / n : plotW;
    var barW = Math.max(1, slot * 0.6);

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('class', 'ov-chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('preserveAspectRatio', 'none');

    // baseline
    var axis = document.createElementNS(SVG_NS, 'line');
    axis.setAttribute('x1', padL);
    axis.setAttribute('y1', padTop + plotH);
    axis.setAttribute('x2', padL + plotW);
    axis.setAttribute('y2', padTop + plotH);
    axis.setAttribute('class', 'ov-chart-axis');
    svg.appendChild(axis);

    rows.forEach(function (r, i) {
      var h = Math.max(0, (r.value / denom) * plotH);
      var x = padL + i * slot + (slot - barW) / 2;
      var y = padTop + (plotH - h);

      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', barW);
      rect.setAttribute('height', h);
      rect.setAttribute('class', 'ov-bar');
      // Accessible tooltip text — textContent, never markup.
      var title = document.createElementNS(SVG_NS, 'title');
      Escape.setText(title, r.label + ': ' + Format.formatMoney(r.value));
      rect.appendChild(title);
      svg.appendChild(rect);

      // x-axis label (bucket key), rotated for legibility.
      var lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', x + barW / 2);
      lbl.setAttribute('y', padTop + plotH + 14);
      lbl.setAttribute('class', 'ov-bar-label');
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('transform', 'rotate(-35 ' + (x + barW / 2) + ' ' + (padTop + plotH + 14) + ')');
      Escape.setText(lbl, r.label);
      svg.appendChild(lbl);
    });

    figure.appendChild(svg);
    return figure;
  }

  function renderMessage(className, text) {
    var p = el('p', className);
    Escape.setText(p, text);
    return p;
  }

  // Render the whole Overview into `container` from a reports object.
  function renderInto(container, reports) {
    if (!hasDom() || !container) return;
    clear(container);
    var rows = chartModel(reports);
    var hasData = (reports && toNum(reports.count) > 0) || rows.length > 0;

    if (!hasData) {
      container.appendChild(renderMessage('ov-empty', 'No expenses yet. Send a receipt to your Telegram bot to get started.'));
      return;
    }
    container.appendChild(renderKpis(kpiModel(reports)));
    container.appendChild(renderChart(rows));
  }

  // Mount point wired by app.js. Builds the section content: a loading state,
  // then fetches /api/reports and swaps in data / empty / error. Idempotent:
  // only fetches once unless force===true.
  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var container = el('div', 'ov-root');
    section.appendChild(container);

    var state = { loaded: false, loading: false };

    function load() {
      if (state.loading || state.loaded || !apiFetch) return;
      state.loading = true;
      clear(container);
      container.appendChild(renderMessage('ov-loading muted', 'Loading overview…'));
      apiFetch('/api/reports').then(function (reports) {
        state.loading = false;
        state.loaded = true;
        renderInto(container, reports);
      }).catch(function () {
        state.loading = false;
        // Leave loaded=false so a later revisit can retry.
        clear(container);
        container.appendChild(renderMessage('ov-error', 'Could not load your overview. Please try again shortly.'));
      });
    }

    return { el: container, load: load, renderInto: function (r) { renderInto(container, r); } };
  }

  return {
    // pure
    chartModel: chartModel,
    kpiModel: kpiModel,
    topCategory: topCategory,
    // render (browser)
    mount: mount,
    renderInto: renderInto,
  };
});
