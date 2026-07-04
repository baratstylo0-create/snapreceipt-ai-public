// components/overview.js — the Overview screen: KPI cards, an all-time
// "spending until now" box, a vertical smooth line/area chart (months listed
// down the y-axis, spend running left-to-right, a popup on hover/focus per
// month), and a category-breakdown donut (percent of this year's spend).
//
// THREE layers, kept apart so the math is unit-testable without a DOM:
//   1. PURE data transforms (chartModel / kpiModel / topCategory / monthlySeries
//      / categoryPercentBreakdown / categoryColor) — reports JSON -> plain
//      arrays. No DOM, no escaping (the render layer owns escaping), never
//      throws on junk input. Covered by tests/frontend/overview.test.js.
//   2. PURE geometry (smoothPathD / donutSlicePath) — points/angles -> an SVG
//      path 'd' string. No DOM.
//   3. RENDER layer (mount + render*) — builds real DOM with createElement /
//      createElementNS + textContent + Escape.setText. NEVER innerHTML with
//      data. No-ops outside a browser. Loading / empty / error states live here.
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
  var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---- pure helpers: numbers / shapes -------------------------------------

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

  // Zero-filled Jan..Dec series for `year`, from a period=month report (bucket
  // keys 'YYYY-MM'). Real data is overlaid on a 12-row zero grid so every
  // month always has a point, even with no expenses. Never throws.
  function monthlySeries(reports, year) {
    var y = Number.isInteger(year) ? year : new Date().getFullYear();
    var totals = {};
    buckets(reports).forEach(function (b) {
      var k = b && b.key !== undefined && b.key !== null ? String(b.key) : '';
      totals[k] = toNum(b && b.total);
    });
    var rows = [];
    for (var m = 1; m <= 12; m++) {
      var key = y + '-' + (m < 10 ? '0' + m : String(m));
      rows.push({ label: MONTH_LABELS[m - 1], value: totals[key] || 0 });
    }
    return rows;
  }

  // Category totals -> [{name, total, pct, frac}] sorted desc. `frac` (0-1,
  // exact) drives slice angles so rounding in the displayed `pct` (0-100, one
  // decimal) never leaves a visible gap/overlap in the donut. [] when there's
  // no positive category spend. Never throws.
  function categoryPercentBreakdown(reports) {
    var totals = {};
    buckets(reports).forEach(function (b) {
      var byCat = b && b.byCategory;
      if (!byCat || typeof byCat !== 'object') return;
      Object.keys(byCat).forEach(function (cat) {
        totals[cat] = (totals[cat] || 0) + toNum(byCat[cat]);
      });
    });
    var rows = [];
    var grand = 0;
    Object.keys(totals).forEach(function (cat) {
      if (totals[cat] > 0) { rows.push({ name: cat, total: totals[cat] }); grand += totals[cat]; }
    });
    rows.sort(function (a, b) { return b.total - a.total; });
    return rows.map(function (r) {
      var frac = grand > 0 ? r.total / grand : 0;
      return { name: r.name, total: r.total, pct: Math.round(frac * 1000) / 10, frac: frac };
    });
  }

  // Category name -> a stable palette class suffix ('c0'..'c9', or 'others').
  // Mirrors activity.js's categoryColor exactly (same hash, same palette size)
  // so a category's colour matches everywhere in the app (pills, donut).
  // Duplicated rather than imported to keep components independently
  // loadable — same pattern as chartModel/categoryBreakdown existing
  // independently in reports.js. Never returns markup; never throws.
  var PALETTE_SIZE = 10;
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  function categoryColor(name) {
    var key = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
    if (key === '' || key === 'others') return 'others';
    return 'c' + (hashString(key) % PALETTE_SIZE);
  }

  function formatPercent(v) { return (Math.round(toNum(v) * 10) / 10) + '%'; }

  // Overview scopes to the CURRENT YEAR. A monthly chart pulled with no date range
  // buckets every year in the data side-by-side (2018-01, 2023-12, 2024-04, 2026-05…) —
  // meaningless at a glance. The Reports screen's Year tab is where other years are
  // explored; the Overview is "this year so far". Pure, injectable clock for testing.
  function overviewReportsPath(now) {
    var y = new Date(typeof now === 'number' ? now : Date.now()).getFullYear();
    return '/api/reports?period=month&from=' + y + '-01-01&to=' + y + '-12-31';
  }

  // All-time (no date bounds) — powers the "Total spending until now" box.
  // Deliberately UNSCOPED (unlike overviewReportsPath), since "until now" means
  // every expense ever recorded, not just this year.
  function allTimeReportsPath() { return '/api/reports?period=year'; }

  // ---- pure geometry -------------------------------------------------------

  // Catmull-Rom -> cubic-Bezier smoothing through an ordered list of {x,y}
  // points -> an SVG path 'd' string (starts with M). 0 points -> ''; 1 point
  // -> a bare M (no line). Never throws.
  function smoothPathD(points) {
    var pts = Array.isArray(points) ? points : [];
    if (!pts.length) return '';
    if (pts.length === 1) return 'M' + pts[0].x + ',' + pts[0].y;
    var d = 'M' + pts[0].x + ',' + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i === 0 ? i : i - 1];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2.x + ',' + p2.y;
    }
    return d;
  }

  function polarToXY(cx, cy, r, angleDeg) {
    var rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  // A donut-slice path 'd' from startAngle to endAngle (degrees, 0 = top,
  // clockwise), outer radius rO, inner radius rI (rI=0 -> a plain pie slice).
  // '' for a zero/negative/garbage span — never throws.
  function donutSlicePath(cx, cy, rO, rI, startAngle, endAngle) {
    var s = toNum(startAngle), e = toNum(endAngle);
    if (e <= s) return '';
    var large = (e - s) > 180 ? 1 : 0;
    var oStart = polarToXY(cx, cy, rO, s), oEnd = polarToXY(cx, cy, rO, e);
    var iStart = polarToXY(cx, cy, rI, e), iEnd = polarToXY(cx, cy, rI, s);
    return 'M' + oStart.x + ',' + oStart.y +
      ' A' + rO + ',' + rO + ' 0 ' + large + ' 1 ' + oEnd.x + ',' + oEnd.y +
      ' L' + iStart.x + ',' + iStart.y +
      ' A' + rI + ',' + rI + ' 0 ' + large + ' 0 ' + iEnd.x + ',' + iEnd.y +
      ' Z';
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

  function renderMessage(className, text) {
    var p = el('p', className);
    Escape.setText(p, text);
    return p;
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

  // The small "Total spending until now" box — a lifetime total, distinct from
  // the (current-year) "Total spend" KPI above it.
  function renderAllTimeBox(total) {
    var card = el('div', 'ov-alltime');
    var label = el('div', 'ov-alltime-label');
    Escape.setText(label, 'Total spending until now');
    var value = el('div', 'ov-alltime-value');
    Escape.setText(value, Format.formatMoney(total));
    card.appendChild(label);
    card.appendChild(value);
    return card;
  }

  // Vertical smooth line/area chart: months run down the y-axis (top-to-bottom,
  // Jan..Dec), spend runs left-to-right along x. No numeric x-axis scale is
  // drawn — the caption above carries the title, and each point's exact amount
  // shows in a popup on hover/focus (a <title> is also present as an
  // accessible fallback for keyboard/AT users who can't hover).
  function renderLineChart(rows, year) {
    var figure = el('figure', 'ov-linechart');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, 'Expenses by Month — ' + year);
    figure.appendChild(caption);

    var width = 460, height = 520;
    var padTop = 14, padBottom = 14, padLeft = 44, padRight = 20;
    var plotW = width - padLeft - padRight;
    var plotH = height - padTop - padBottom;
    var n = rows.length;
    var rowH = n > 0 ? plotH / n : plotH;
    var max = rows.reduce(function (m, r) { return r.value > m ? r.value : m; }, 0);
    var denom = max > 0 ? max : 1;

    var points = rows.map(function (r, i) {
      return {
        x: padLeft + (r.value / denom) * plotW,
        y: padTop + i * rowH + rowH / 2,
        label: r.label,
        value: r.value,
      };
    });

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('class', 'ov-linechart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('preserveAspectRatio', 'none');

    // baseline (the "$0" vertical line every point measures out from)
    var axis = document.createElementNS(SVG_NS, 'line');
    axis.setAttribute('x1', padLeft); axis.setAttribute('y1', padTop);
    axis.setAttribute('x2', padLeft); axis.setAttribute('y2', padTop + plotH);
    axis.setAttribute('class', 'ov-chart-axis');
    svg.appendChild(axis);

    // month row labels — the "y-axis" list of months.
    points.forEach(function (p) {
      var lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', padLeft - 8);
      lbl.setAttribute('y', p.y + 4);
      lbl.setAttribute('class', 'ov-bar-label');
      lbl.setAttribute('text-anchor', 'end');
      Escape.setText(lbl, p.label);
      svg.appendChild(lbl);
    });

    var lineD = smoothPathD(points);
    if (points.length > 1) {
      var last = points[points.length - 1], first = points[0];
      var areaD = lineD + ' L' + padLeft + ',' + last.y + ' L' + padLeft + ',' + first.y + ' Z';
      var area = document.createElementNS(SVG_NS, 'path');
      area.setAttribute('d', areaD);
      area.setAttribute('class', 'ov-chart-area');
      svg.appendChild(area);
    }

    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', lineD);
    line.setAttribute('class', 'ov-chart-line');
    line.setAttribute('fill', 'none');
    svg.appendChild(line);

    figure.appendChild(svg);

    // Custom popup — a real DOM overlay (not just the native <title> tooltip),
    // positioned in percentage coordinates so it tracks the SVG's scaled size
    // without a resize observer. Shown on hover AND keyboard focus.
    var tip = el('div', 'ov-chart-tip');
    tip.setAttribute('role', 'status');
    figure.appendChild(tip);

    points.forEach(function (p) {
      var dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', 4.5);
      dot.setAttribute('class', 'ov-chart-dot');
      dot.setAttribute('tabindex', '0');
      var title = document.createElementNS(SVG_NS, 'title');
      Escape.setText(title, p.label + ': ' + Format.formatMoney(p.value));
      dot.appendChild(title);

      function showTip() {
        Escape.setText(tip, p.label + ': ' + Format.formatMoney(p.value));
        tip.style.left = ((p.x / width) * 100) + '%';
        tip.style.top = ((p.y / height) * 100) + '%';
        tip.classList.add('is-visible');
      }
      function hideTip() { tip.classList.remove('is-visible'); }
      dot.addEventListener('pointerenter', showTip);
      dot.addEventListener('pointerleave', hideTip);
      dot.addEventListener('focus', showTip);
      dot.addEventListener('blur', hideTip);
      svg.appendChild(dot);
    });

    return figure;
  }

  // Category-breakdown donut: percent share of this year's spend, with the
  // year's total in the center (matches the reference design) and a legend
  // list (colour swatch + name + percent) below/beside it.
  function renderDonut(rows, yearTotal, year) {
    var wrap = el('div', 'ov-donut-wrap');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, 'Spend by category — ' + year);
    wrap.appendChild(caption);

    var body = el('div', 'ov-donut-body');
    var cx = 90, cy = 90, rO = 82, rI = 50;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 180 180');
    svg.setAttribute('class', 'ov-donut-svg');
    svg.setAttribute('role', 'img');

    if (!rows.length) {
      body.appendChild(svg);
      wrap.appendChild(body);
      wrap.appendChild(renderMessage('rp-categories-empty muted', 'No category spend for this period.'));
      return wrap;
    }

    var angle = 0;
    rows.forEach(function (r) {
      var span = r.frac * 360;
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, rO, rI, angle, angle + span));
      path.setAttribute('class', 'ov-donut-slice ov-donut-slice--' + categoryColor(r.name));
      var title = document.createElementNS(SVG_NS, 'title');
      Escape.setText(title, r.name + ': ' + formatPercent(r.pct));
      path.appendChild(title);
      svg.appendChild(path);
      angle += span;
    });

    var centerValue = document.createElementNS(SVG_NS, 'text');
    centerValue.setAttribute('x', cx); centerValue.setAttribute('y', cy - 3);
    centerValue.setAttribute('class', 'ov-donut-center-value');
    centerValue.setAttribute('text-anchor', 'middle');
    Escape.setText(centerValue, Format.formatMoney(yearTotal));
    svg.appendChild(centerValue);

    var centerCaption = document.createElementNS(SVG_NS, 'text');
    centerCaption.setAttribute('x', cx); centerCaption.setAttribute('y', cy + 15);
    centerCaption.setAttribute('class', 'ov-donut-center-caption');
    centerCaption.setAttribute('text-anchor', 'middle');
    Escape.setText(centerCaption, 'TOTAL');
    svg.appendChild(centerCaption);

    body.appendChild(svg);

    var legend = el('ul', 'ov-donut-legend');
    rows.forEach(function (r) {
      var li = el('li', 'ov-donut-legend-row');
      li.appendChild(el('span', 'ov-donut-swatch ov-donut-swatch--' + categoryColor(r.name)));
      var name = el('span', 'ov-donut-legend-name');
      Escape.setText(name, r.name);           // untrusted (customer FieldSpec) -> escaped
      li.appendChild(name);
      var pct = el('span', 'ov-donut-legend-pct');
      Escape.setText(pct, formatPercent(r.pct));
      li.appendChild(pct);
      legend.appendChild(li);
    });
    body.appendChild(legend);

    wrap.appendChild(body);
    return wrap;
  }

  // Render the whole Overview into `container` from a (year-scoped) reports
  // object plus the separately-fetched all-time total.
  function renderInto(container, reports, allTimeTotal) {
    if (!hasDom() || !container) return;
    clear(container);
    var rows = chartModel(reports);
    var hasData = (reports && toNum(reports.count) > 0) || rows.length > 0;

    if (!hasData) {
      container.appendChild(renderMessage('ov-empty', 'No expenses yet. Send a receipt to your Telegram bot to get started.'));
      return;
    }

    // Derive the displayed year from the report's own `from` (set by
    // overviewReportsPath) rather than re-reading the live clock here, so the
    // year on screen always matches the data that was actually fetched.
    var year = (reports && typeof reports.from === 'string' && reports.from.length >= 4)
      ? reports.from.slice(0, 4) : String(new Date().getFullYear());

    var topRow = el('div', 'ov-top-row');
    topRow.appendChild(renderKpis(kpiModel(reports)));
    topRow.appendChild(renderAllTimeBox(allTimeTotal));
    container.appendChild(topRow);

    var chartsRow = el('div', 'ov-charts-row');
    chartsRow.appendChild(renderLineChart(monthlySeries(reports, Number(year)), year));
    chartsRow.appendChild(renderDonut(categoryPercentBreakdown(reports), reports.total, year));
    container.appendChild(chartsRow);
  }

  // Mount point wired by app.js. Builds the section content: a loading state,
  // then fetches /api/reports (year-scoped + all-time) and swaps in data /
  // empty / error. Idempotent: only fetches once unless force===true.
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
      Promise.all([apiFetch(overviewReportsPath()), apiFetch(allTimeReportsPath())]).then(function (results) {
        state.loading = false;
        state.loaded = true;
        var reports = results[0], allTime = results[1];
        renderInto(container, reports, allTime && allTime.total);
      }).catch(function () {
        state.loading = false;
        // Leave loaded=false so a later revisit can retry.
        clear(container);
        container.appendChild(renderMessage('ov-error', 'Could not load your overview. Please try again shortly.'));
      });
    }

    return { el: container, load: load, renderInto: function (r, allTime) { renderInto(container, r, allTime); } };
  }

  return {
    // pure
    chartModel: chartModel,
    kpiModel: kpiModel,
    topCategory: topCategory,
    monthlySeries: monthlySeries,
    categoryPercentBreakdown: categoryPercentBreakdown,
    categoryColor: categoryColor,
    formatPercent: formatPercent,
    overviewReportsPath: overviewReportsPath,
    allTimeReportsPath: allTimeReportsPath,
    // pure geometry
    smoothPathD: smoothPathD,
    donutSlicePath: donutSlicePath,
    // render (browser)
    mount: mount,
    renderInto: renderInto,
  };
});
