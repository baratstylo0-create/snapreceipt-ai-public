// components/reports.js — the Reports screen (Task F): Day/Week/Month/Year
// tabs that each "drill down" one level, driving GET /api/reports, the SAME
// inline-SVG bar-chart technique as overview.js, a per-category breakdown,
// and an "Export to Excel" button that downloads GET /api/excel as a Blob.
//
// Drill-down design (2026-07-05 redesign, replacing the old date-range picker):
//   Day   -> ONE calendar day.  No time chart (a single day has no smaller time
//            unit) — just the category breakdown for that day.
//   Week  -> ONE calendar week (Sunday-Saturday). Bars = Sun..Sat, zero-filled.
//   Month -> ONE calendar month. Bars = W1..W4 (simple day-count chunks: days
//            1-7/8-14/15-21/22-end; the trailing days of a 29-31 day month
//            fold into W4), zero-filled.
//   Year  -> ONE calendar year. Bars = Jan..Dec, zero-filled.
// Each tab shows Prev/Next arrows to step to the adjacent unit. The underlying
// /api/reports contract is untouched (period=day|week|month|year&from=&to=) —
// we just always send an EXPLICIT from/to computed from the current anchor,
// requesting day-level granularity for Week/Month (so we can re-bucket into
// weekdays / week-chunks ourselves) and month-level granularity for Year.
//
// TWO layers, kept apart so the math is unit-testable without a DOM:
//   1. PURE transforms (date math, bucket builders, buildAnchorQuery,
//      categoryBreakdown, excelFilename, exportErrorMessage) — no DOM, no
//      network, never throw on junk. Covered by tests/frontend/reports.test.js.
//   2. RENDER layer (mount + render*) — builds real DOM with createElement /
//      createElementNS + textContent + Escape.setText. NEVER innerHTML with
//      data. No-ops outside a browser. Loading / empty / error states live here.
//
// Endpoint contracts (read from routes/reports.js + lib/reports.js + routes/excel.js):
//   GET /api/reports?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
//     -> 200 { period, from, to, total, count,
//              buckets:[{key,total,count,byCategory}], fetched_count, truncated }
//     buckets are sorted asc by key (lib/reports.js buildReport).
//   GET /api/excel?from=&to=
//     -> 200 binary .xlsx (Content-Type: application/vnd.openxmlformats...,
//        Content-Disposition: attachment; filename="...", optional
//        X-Truncated: true header)
//     -> non-2xx JSON { error } (502 on upstream failure) — body text ignored,
//        fixed friendly message per status (house convention, same as
//        upload.js's errorMessage: never surface 5xx/4xx internals).
//   This is a FILE DOWNLOAD, not JSON — it is NOT routed through Api.apiFetch
//   (which assumes JSON/text parsing). We do a raw fetch with the same bearer
//   header Api.apiFetch attaches (via Api.getToken()), read the response as a
//   Blob, and trigger a synthetic <a> click to save it.
//
// UMD shim: window.Reports in the browser; require()-able in Node (the render
// layer simply isn't exercised there — no document/Blob/fetch).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../format'), require('../api'), require('../exportGuards'), require('../i18n'));
  } else {
    root.Reports = factory(root.Escape, root.Format, root.Api, root.ExportGuards, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api, ExportGuards, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var tp = (I18n && I18n.tp) || function (k) { return k; };

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PERIODS = ['day', 'week', 'month', 'year'];
  var WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
  var round2 = function (v) { return Math.round((toNum(v) + Number.EPSILON) * 100) / 100; };

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function branchFilterOptions(branches, isAdmin) {
    if (!isAdmin) return [];
    var out = [
      { value: 'all', label: t('reports.branch_all') },
      { value: 'mine', label: t('reports.branch_mine') },
    ];
    (Array.isArray(branches) ? branches : []).forEach(function (branch) {
      if (!branch || branch.id === undefined || branch.id === null || String(branch.id) === '') return;
      out.push({ value: String(branch.id), label: branch.office ? String(branch.office) : String(branch.id) });
    });
    return out;
  }

  function branchQueryValue(filter, session) {
    if (!filter || filter === 'all') return null;
    if (filter === 'mine') {
      var own = session && session.branch_id !== undefined && session.branch_id !== null ? String(session.branch_id) : '';
      return own || null;
    }
    return String(filter);
  }

  function appendBranchQuery(path, filter, session) {
    var branch = branchQueryValue(filter, session);
    if (!branch) return String(path || '');
    var base = String(path || '');
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'branch=' + encodeURIComponent(branch);
  }

  function buckets(reports) {
    return reports && Array.isArray(reports.buckets) ? reports.buckets : [];
  }

  // reports.buckets -> { 'key': total, ... }, tolerant of junk. Used to overlay
  // real data onto a zero-filled label grid (weekday / week-chunk / month).
  function bucketTotalsByKey(reports) {
    var map = {};
    buckets(reports).forEach(function (b) {
      var k = b && b.key !== undefined && b.key !== null ? String(b.key) : '';
      map[k] = toNum(b && b.total);
    });
    return map;
  }

  // Sum byCategory across every bucket and return the FULL sorted-desc list of
  // {name, total}, filtering non-positive totals. Never throws on null/garbage.
  function categoryBreakdown(reports) {
    var totals = {};
    buckets(reports).forEach(function (b) {
      var byCat = b && b.byCategory;
      if (!byCat || typeof byCat !== 'object') return;
      Object.keys(byCat).forEach(function (cat) {
        totals[cat] = (totals[cat] || 0) + toNum(byCat[cat]);
      });
    });
    var rows = [];
    Object.keys(totals).forEach(function (cat) {
      if (totals[cat] > 0) rows.push({ name: cat, total: totals[cat] });
    });
    rows.sort(function (a, b) { return b.total - a.total; });
    return rows;
  }

  // ---- pure helpers: date math (UTC-based, mirrors lib/reports.js's isoWeekKey) --

  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isIsoShaped(v) { return typeof v === 'string' && ISO_DATE_RE.test(v); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function isoOf(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); } // m is 1-12

  // Parse an ISO date string -> {y, m, d} (m is 1-12). Malformed input yields
  // NaN fields; callers that need safety should validate with isIsoShaped first.
  function parseIso(iso) {
    var parts = String(iso || '').split('-').map(Number);
    return { y: parts[0], m: parts[1], d: parts[2] };
  }

  // Last day-of-month for (year, month 1-12). Date.UTC(y, m, 0) = "day 0 of the
  // NEXT month" = the last day of THIS month; a well-known trick, avoids a
  // hand-rolled leap-year table.
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function addDaysIso(iso, n) {
    var p = parseIso(iso);
    var dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  // 0=Sun..6=Sat for an ISO date (UTC, so it never shifts across a DST edge).
  function weekdayIndex(iso) {
    var p = parseIso(iso);
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }

  // The Sunday on/before `iso` — the start of the week that contains it.
  function startOfWeekIso(iso) { return addDaysIso(iso, -weekdayIndex(iso)); }

  function monthRangeFor(year, month) {
    return { from: isoOf(year, month, 1), to: isoOf(year, month, daysInMonth(year, month)) };
  }
  function weekRangeFor(weekStartIso) { return { from: weekStartIso, to: addDaysIso(weekStartIso, 6) }; }
  function yearRangeFor(year) { return { from: year + '-01-01', to: year + '-12-31' }; }

  // Anchor stepping — Prev/Next moves exactly one unit of the active period.
  function shiftDay(iso, delta) { return addDaysIso(iso, delta); }
  function shiftWeek(weekStartIso, delta) { return addDaysIso(weekStartIso, delta * 7); }
  // Month arithmetic via a flat "months since epoch" count sidesteps Date's
  // day-of-month rollover quirks (e.g. Jan 31 + 1 month silently becoming Mar 3).
  function shiftMonth(year, month, delta) {
    var total = (year * 12 + (month - 1)) + delta;
    var y = Math.floor(total / 12);
    var m = (total - y * 12) + 1;
    return { year: y, month: m };
  }
  function shiftYear(year, delta) { return year + delta; }

  function todayIso() {
    var d = new Date();
    return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  // Owner request 2026-07-06: the Export button now asks "which timeframe?"
  // every time, instead of silently exporting whatever's currently browsed.
  // These 4 choices are always anchored to TODAY (not whatever period/anchor
  // the user happens to be viewing on screen) — "Day" = today, "Week" = this
  // calendar week, "Month" = this calendar month, "Overall" = no date bounds
  // at all (routes/excel.js treats a missing from/to as "every expense ever").
  var EXPORT_CHOICES = ['day', 'week', 'month', 'overall'];
  function exportChoiceLabel(choice) {
    if (choice === 'day') return t('reports.export_today');
    if (choice === 'week') return t('reports.export_this_week');
    if (choice === 'month') return t('reports.export_this_month');
    return t('reports.export_overall');
  }
  function exportRangeFor(choice, now) {
    var today = isIsoShaped(now) ? now : todayIso();
    if (choice === 'day') return { from: today, to: today };
    if (choice === 'week') {
      var wr = weekRangeFor(startOfWeekIso(today));
      return { from: wr.from, to: wr.to };
    }
    if (choice === 'month') {
      var mr = monthRangeFor(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
      return { from: mr.from, to: mr.to };
    }
    return { from: null, to: null }; // overall — no bounds
  }

  // ---- pure helpers: query + bucket builders ------------------------------

  // Build the actual /api/reports query for a UI period + its anchor. Anchor
  // shapes: day/week -> an ISO date string (week anchor = its Sunday); month ->
  // {year, month}; year -> a year number. Week/Month request DAY-level
  // granularity (so we can re-bucket into weekdays / week-chunks ourselves);
  // Year requests MONTH-level granularity. Tolerant of a malformed anchor
  // (falls back to today) — never throws.
  function buildAnchorQuery(uiPeriod, anchor) {
    var p = PERIODS.indexOf(uiPeriod) !== -1 ? uiPeriod : 'month';
    if (p === 'week') {
      var wAnchor = isIsoShaped(anchor) ? anchor : todayIso();
      var wr = weekRangeFor(wAnchor);
      return { period: 'day', from: wr.from, to: wr.to };
    }
    if (p === 'month') {
      var mAnchor = isPlainObject(anchor) && Number.isInteger(anchor.year) && anchor.month >= 1 && anchor.month <= 12
        ? anchor : { year: Number(todayIso().slice(0, 4)), month: Number(todayIso().slice(5, 7)) };
      var mr = monthRangeFor(mAnchor.year, mAnchor.month);
      return { period: 'day', from: mr.from, to: mr.to };
    }
    if (p === 'year') {
      var yAnchor = Number.isInteger(anchor) ? anchor : Number(todayIso().slice(0, 4));
      var yr = yearRangeFor(yAnchor);
      return { period: 'month', from: yr.from, to: yr.to };
    }
    // day
    var dAnchor = isIsoShaped(anchor) ? anchor : todayIso();
    return { period: 'day', from: dAnchor, to: dAnchor };
  }

  // Week view: 7 bars Sun..Sat, zero-filled, from a period=day report over that
  // week's range.
  function weekdayBuckets(reports, weekStartIso) {
    var totals = bucketTotalsByKey(reports);
    var anchor = isIsoShaped(weekStartIso) ? weekStartIso : todayIso();
    var rows = [];
    for (var i = 0; i < 7; i++) {
      var iso = addDaysIso(anchor, i);
      rows.push({ label: WEEKDAY_LABELS[i], value: totals[iso] || 0 });
    }
    return rows;
  }

  // Month view: exactly 4 bars W1..W4 (day-count chunks: 1-7/8-14/15-21/22-end;
  // W4 absorbs any trailing days of a 29-31 day month), zero-filled, from a
  // period=day report over that month's range.
  function monthWeekBuckets(reports, year, month) {
    var y = Number.isInteger(year) ? year : Number(todayIso().slice(0, 4));
    var m = (Number.isInteger(month) && month >= 1 && month <= 12) ? month : Number(todayIso().slice(5, 7));
    var totals = bucketTotalsByKey(reports);
    var last = daysInMonth(y, m);
    var sums = [0, 0, 0, 0];
    for (var d = 1; d <= last; d++) {
      var idx = d <= 7 ? 0 : d <= 14 ? 1 : d <= 21 ? 2 : 3;
      sums[idx] += totals[isoOf(y, m, d)] || 0;
    }
    return sums.map(function (v, i) { return { label: 'W' + (i + 1), value: round2(v) }; });
  }

  // Year view: 12 bars Jan..Dec, zero-filled, from a period=month report over
  // that year's range.
  function yearMonthBuckets(reports, year) {
    var y = Number.isInteger(year) ? year : Number(todayIso().slice(0, 4));
    var totals = bucketTotalsByKey(reports);
    var rows = [];
    for (var m = 1; m <= 12; m++) {
      rows.push({ label: MONTH_LABELS[m - 1], value: totals[y + '-' + pad2(m)] || 0 });
    }
    return rows;
  }

  // ---- pure helpers: heading labels (what Prev/Next steps between) -------

  function formatDayHeading(iso) {
    var v = isIsoShaped(iso) ? iso : todayIso();
    var p = parseIso(v);
    var wd = WEEKDAY_LABELS[weekdayIndex(v)];
    return wd + ', ' + MONTH_LABELS[p.m - 1] + ' ' + p.d + ', ' + p.y;
  }
  function formatWeekHeading(weekStartIso) {
    var v = isIsoShaped(weekStartIso) ? weekStartIso : todayIso();
    var endIso = addDaysIso(v, 6);
    var s = parseIso(v), e = parseIso(endIso);
    var startStr = MONTH_LABELS[s.m - 1] + ' ' + s.d;
    var endStr = MONTH_LABELS[e.m - 1] + ' ' + e.d;
    return startStr + '–' + endStr + ', ' + e.y;
  }
  function formatMonthHeading(year, month) {
    var y = Number.isInteger(year) ? year : Number(todayIso().slice(0, 4));
    var m = (Number.isInteger(month) && month >= 1 && month <= 12) ? month : Number(todayIso().slice(5, 7));
    return MONTH_LABELS[m - 1] + ' ' + y;
  }
  function formatYearHeading(year) {
    return String(Number.isInteger(year) ? year : Number(todayIso().slice(0, 4)));
  }

  // Extract a filename from a Content-Disposition header value
  // (attachment; filename="..."). Falls back to a sensible default built from
  // the from/to used for the request. Never throws.
  var CD_FILENAME_RE = /filename="?([^";]+)"?/i;
  function excelFilename(contentDisposition, fallbackFrom, fallbackTo) {
    if (typeof contentDisposition === 'string') {
      var m = contentDisposition.match(CD_FILENAME_RE);
      if (m && m[1]) return m[1];
    }
    var from = isIsoShaped(fallbackFrom) ? fallbackFrom : (typeof fallbackFrom === 'string' && fallbackFrom ? fallbackFrom : null);
    var to = isIsoShaped(fallbackTo) ? fallbackTo : (typeof fallbackTo === 'string' && fallbackTo ? fallbackTo : null);
    return 'expenses-' + (from || 'all') + '-' + (to || 'export') + '.xlsx';
  }

  // Map an HTTP status to a fixed, friendly message. Status-only (mirrors
  // upload.js's errorMessage) — body text is never surfaced (house convention:
  // never leak server internals). Never throws.
  function exportErrorMessage(status) {
    switch (Number(status)) {
      case 401: return t('reports.export_err_401');
      case 502: return t('reports.export_err_502');
      default:  return t('reports.export_err_default');
    }
  }

  // ---- DOM helpers (browser only) ----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function msg(className, text) { var p = el('p', className); Escape.setText(p, text); return p; }

  function renderKpis(cards) {
    var wrap = el('div', 'ov-kpis');
    cards.forEach(function (c) {
      var card = el('div', 'ov-kpi');
      var label = el('div', 'ov-kpi-label');
      Escape.setText(label, c.label);
      var value = el('div', 'ov-kpi-value');
      Escape.setText(value, c.value);
      card.appendChild(label);
      card.appendChild(value);
      wrap.appendChild(card);
    });
    return wrap;
  }

  // Plain inline SVG bar chart — SAME technique as overview.js's renderChart
  // (no library; bars scaled to the max value; label/value via textContent).
  // Owner request 2026-07-05: show every bar's exact total as an always-visible
  // pill above the bar (not just an on-hover <title>), matching the Overview
  // line chart's callouts.
  function renderChart(rows) {
    var figure = el('figure', 'ov-chart');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, t('reports.spend_by_period'));
    figure.appendChild(caption);

    var width = 640, height = 260, padL = 8, padR = 8, padBottom = 30;
    // calloutZone: headroom above the tallest bar so its value pill has room
    // to sit above the bar instead of overlapping it.
    var calloutZone = 30;
    var padTop = 8 + calloutZone;
    var plotW = width - padL - padR;
    var plotH = height - padTop - padBottom;
    var max = rows.reduce(function (m, r) { return r.value > m ? r.value : m; }, 0);
    // Owner report 2026-07-05: on a view with a single bar (e.g. the Week tab
    // showing just "W1"), that one bar IS the max by definition, so it always
    // filled the entire plot height — looking oversized/exaggerated compared
    // to views with several bars. Reserve a fixed 25% headroom above the
    // tallest bar on EVERY view (1 bar or 12), so a lone bar renders at the
    // same "standard" scale instead of always maxing out the chart.
    var denom = max > 0 ? max / 0.75 : 1;
    var n = rows.length;
    var slot = n > 0 ? plotW / n : plotW;
    // Cap bar width too — with 1 slot, 60% of the full plot width is still a
    // huge block; clamp so a lone bar matches the width a bar would have in a
    // normal multi-bar view instead of ballooning to fill the space.
    var barW = Math.max(1, Math.min(slot * 0.6, 70));

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('class', 'ov-chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('preserveAspectRatio', 'none');

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
      var title = document.createElementNS(SVG_NS, 'title');
      Escape.setText(title, r.label + ': ' + Format.formatMoney(r.value));
      rect.appendChild(title);
      svg.appendChild(rect);

      var lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', x + barW / 2);
      lbl.setAttribute('y', padTop + plotH + 18);
      lbl.setAttribute('class', 'ov-bar-label');
      lbl.setAttribute('text-anchor', 'middle');
      Escape.setText(lbl, r.label);
      svg.appendChild(lbl);

      // Always-visible value pill above the bar (skip a true-zero bar — nothing
      // to show above an invisible bar, and it would sit right on the axis).
      if (r.value > 0) {
        var text = Format.formatMoney(r.value).replace(/\.00$/, '');
        var pillW = Math.max(28, text.length * 7.5 + 12);
        var pillH = 18;
        var pillX = Math.min(Math.max(x + barW / 2 - pillW / 2, 0), width - pillW);
        var pillY = Math.max(y - pillH - 8, 0);

        var group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'ov-chart-callout');
        var pill = document.createElementNS(SVG_NS, 'rect');
        pill.setAttribute('x', pillX);
        pill.setAttribute('y', pillY);
        pill.setAttribute('width', pillW);
        pill.setAttribute('height', pillH);
        pill.setAttribute('rx', 5);
        pill.setAttribute('class', 'ov-chart-callout-bg');
        group.appendChild(pill);

        var plabel = document.createElementNS(SVG_NS, 'text');
        plabel.setAttribute('x', pillX + pillW / 2);
        plabel.setAttribute('y', pillY + pillH / 2 + 3.5);
        plabel.setAttribute('text-anchor', 'middle');
        plabel.setAttribute('class', 'ov-chart-callout-text ov-chart-callout-text--sm');
        Escape.setText(plabel, text);
        group.appendChild(plabel);
        svg.appendChild(group);
      }
    });

    figure.appendChild(svg);
    return figure;
  }

  function renderCategoryBreakdown(rows) {
    var wrap = el('div', 'rp-categories');
    var title = el('h4', 'rp-categories-title');
    Escape.setText(title, t('reports.by_category'));
    wrap.appendChild(title);

    if (!rows.length) {
      wrap.appendChild(msg('rp-categories-empty muted', t('reports.no_category_spend')));
      return wrap;
    }

    var list = el('ul', 'rp-category-list');
    rows.forEach(function (r) {
      var li = el('li', 'rp-category-row');
      var name = el('span', 'rp-category-name');
      Escape.setText(name, r.name);           // untrusted (category can come from customer FieldSpec) -> escaped
      var total = el('span', 'rp-category-total');
      Escape.setText(total, Format.formatMoney(r.total));
      li.appendChild(name);
      li.appendChild(total);
      list.appendChild(li);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // Pick the right zero-filled bucket rows for the active UI period. Day has
  // no time chart (a single day has no smaller time unit) — returns [].
  function rowsForPeriod(uiPeriod, reports, anchor) {
    if (uiPeriod === 'week') return weekdayBuckets(reports, anchor);
    if (uiPeriod === 'month') return monthWeekBuckets(reports, anchor && anchor.year, anchor && anchor.month);
    if (uiPeriod === 'year') return yearMonthBuckets(reports, anchor);
    return []; // day
  }

  // Render the whole Reports body into `container` from a reports object.
  function renderInto(container, reports, uiPeriod, anchor) {
    if (!hasDom() || !container) return;
    clear(container);
    var period = PERIODS.indexOf(uiPeriod) !== -1 ? uiPeriod : 'month';
    var hasData = reports && toNum(reports.count) > 0;

    if (reports && reports.truncated) {
      container.appendChild(msg('up-notice rp-notice', tp('reports.truncated_notice', Format.formatCount(reports.fetched_count))));
    }

    if (!hasData) {
      container.appendChild(msg('ov-empty', t('reports.no_expenses_period')));
      return;
    }

    container.appendChild(renderKpis([
      { label: t('reports.kpi_total_spend'), value: Format.formatMoney(reports.total) },
      { label: t('reports.kpi_total_bills'), value: Format.formatCount(reports.count) },
    ]));
    if (period !== 'day') container.appendChild(renderChart(rowsForPeriod(period, reports, anchor)));
    container.appendChild(renderCategoryBreakdown(categoryBreakdown(reports)));
  }

  // ---- Excel export (raw fetch -> Blob download, NOT Api.apiFetch) --------

  function currentToken() {
    try { return (Api && Api.getToken) ? Api.getToken() : null; } catch (e) { return null; }
  }

  // Trigger a browser download of `blob` named `filename` via a synthetic <a>
  // click. No navigation, no innerHTML — purely DOM node creation + a Blob URL.
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Release the Blob URL shortly after the click has been dispatched.
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // Fetch /api/excel with the bearer token attached, handle the response as a
  // Blob (never JSON-parsed), and trigger a download on success. On failure,
  // parse the JSON error body (used only to confirm shape — its text is never
  // shown) and reject with a status so the caller can render a friendly message.
  function exportExcel(query) {
    var params = [];
    if (query && query.from) params.push('from=' + encodeURIComponent(query.from));
    if (query && query.to) params.push('to=' + encodeURIComponent(query.to));
    var url = '/api/excel' + (params.length ? '?' + params.join('&') : '');

    var headers = {};
    var token = currentToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    return fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null; }).then(function () {
          var err = new Error('export failed');
          err.status = res.status;
          throw err;
        });
      }
      var cd = res.headers && res.headers.get ? res.headers.get('content-disposition') : null;
      var filename = excelFilename(cd, query && query.from, query && query.to);
      return res.blob().then(function (blob) {
        triggerDownload(blob, filename);
      });
    });
  }

  // Small popup asking "which timeframe?" before export — same
  // backdrop/Escape/outside-click-to-close pattern already used by
  // templates.js's showConfirmDialog and overview.js's colour picker.
  // onPick(choice) fires once, when a real choice button is clicked (never
  // on Cancel/outside-click/Escape). No-op outside a browser.
  function showExportChoiceDialog(onPick) {
    if (!hasDom()) return;
    var backdrop = el('div', 'rp-confirm-host');
    var card = el('div', 'rp-confirm-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.appendChild(msg('rp-confirm-title', t('reports.export_which_timeframe')));

    var choices = el('div', 'rp-confirm-choices');
    EXPORT_CHOICES.forEach(function (choice) {
      var btn = el('button', 'rp-confirm-choice');
      btn.type = 'button';
      Escape.setText(btn, exportChoiceLabel(choice));
      btn.addEventListener('click', function () { close(); onPick(choice); });
      choices.appendChild(btn);
    });
    card.appendChild(choices);

    var cancelBtn = el('button', 'rp-confirm-cancel');
    cancelBtn.type = 'button';
    Escape.setText(cancelBtn, t('reports.cancel'));
    cancelBtn.addEventListener('click', close);
    card.appendChild(cancelBtn);

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    function onKeydown(ev) { if (ev.key === 'Escape') close(); }
    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener('keydown', onKeydown);
    }
    document.addEventListener('keydown', onKeydown);
    backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(); });
  }

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);
    // Owner follow-up (2026-07-10): the export-reminder popup's "Review" button navigates to
    // Activity — same shared switcher Upload's "View in Activity" button already uses.
    var switchView = typeof opts.switchView === 'function' ? opts.switchView : null;

    var rootEl = el('div', 'rp-root');
    section.appendChild(rootEl);
    var isAdmin = !!(opts.session && opts.session.role === 'admin');
    // Demo/UX consistency (2026-07-16): default an admin to the whole-company
    // "All branches" view, matching Overview + Activity. Defaulting to "My
    // uploads" (own branch) made an admin who doesn't personally upload open to
    // an empty screen that reads as data loss. "My uploads" stays selectable.
    var branchState = { filter: 'all', branches: [], loaded: false };

    // --- toolbar: period tabs + Prev/current-unit/Next drill-down nav ---
    var toolbar = el('div', 'rp-toolbar');

    var periodGroup = el('div', 'rp-period-group');
    var periodButtons = {};
    PERIODS.forEach(function (p) {
      var btn = el('button', 'rp-period-btn');
      btn.type = 'button';
      Escape.setText(btn, t('reports.period_' + p));
      btn.addEventListener('click', function () {
        if (state.uiPeriod === p) return;
        state.uiPeriod = p;
        setActivePeriod(p);
        updateNavLabel();
        fetchAndRender();
      });
      periodGroup.appendChild(btn);
      periodButtons[p] = btn;
    });
    toolbar.appendChild(periodGroup);

    var branchSelect = null;
    if (isAdmin) {
      branchSelect = el('select', 'rp-branch-filter');
      branchSelect.setAttribute('aria-label', t('reports.filter_branch_aria'));
      toolbar.appendChild(branchSelect);
    }

    var navGroup = el('div', 'rp-nav-group');
    var prevBtn = el('button', 'rp-nav-btn');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t('reports.previous'));
    Escape.setText(prevBtn, '‹');
    var navLabel = el('span', 'rp-nav-label');
    var nextBtn = el('button', 'rp-nav-btn');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t('reports.next'));
    Escape.setText(nextBtn, '›');
    navGroup.appendChild(prevBtn);
    navGroup.appendChild(navLabel);
    navGroup.appendChild(nextBtn);
    toolbar.appendChild(navGroup);

    var exportBtn = el('button', 'rp-export-btn');
    exportBtn.type = 'button';
    Escape.setText(exportBtn, t('reports.export_to_excel'));
    toolbar.appendChild(exportBtn);

    rootEl.appendChild(toolbar);

    var exportStatus = msg('tp-msg rp-export-status', '');
    rootEl.appendChild(exportStatus);

    var body = el('div', 'rp-body');
    rootEl.appendChild(body);

    function setActivePeriod(p) {
      PERIODS.forEach(function (key) {
        periodButtons[key].classList.toggle('is-active', key === p);
      });
    }

    var today = todayIso();
    var todayYear = Number(today.slice(0, 4)), todayMonth = Number(today.slice(5, 7));
    var state = {
      loaded: false, loading: false, uiPeriod: 'month',
      dayAnchor: today,
      weekAnchor: startOfWeekIso(today),
      monthAnchor: { year: todayYear, month: todayMonth },
      yearAnchor: todayYear,
      lastReports: null,
    };
    setActivePeriod(state.uiPeriod);

    function renderBranchFilter() {
      if (!branchSelect) return;
      clear(branchSelect);
      branchFilterOptions(branchState.branches, isAdmin).forEach(function (option) {
        var item = el('option', 'rp-branch-option');
        item.value = option.value;
        Escape.setText(item, option.label);
        branchSelect.appendChild(item);
      });
      branchSelect.value = branchState.filter;
    }

    function loadBranches() {
      if (!isAdmin || branchState.loaded || !apiFetch) return;
      branchState.loaded = true;
      apiFetch('/api/branches').then(function (payload) {
        branchState.branches = payload && Array.isArray(payload.branches) ? payload.branches : [];
        renderBranchFilter();
      }).catch(function () { renderBranchFilter(); });
    }

    function currentAnchor() {
      if (state.uiPeriod === 'day') return state.dayAnchor;
      if (state.uiPeriod === 'week') return state.weekAnchor;
      if (state.uiPeriod === 'month') return state.monthAnchor;
      return state.yearAnchor;
    }

    function updateNavLabel() {
      var text = state.uiPeriod === 'day' ? formatDayHeading(state.dayAnchor)
        : state.uiPeriod === 'week' ? formatWeekHeading(state.weekAnchor)
        : state.uiPeriod === 'month' ? formatMonthHeading(state.monthAnchor.year, state.monthAnchor.month)
        : formatYearHeading(state.yearAnchor);
      Escape.setText(navLabel, text);
    }
    updateNavLabel();

    function shiftAnchor(delta) {
      if (state.uiPeriod === 'day') state.dayAnchor = shiftDay(state.dayAnchor, delta);
      else if (state.uiPeriod === 'week') state.weekAnchor = shiftWeek(state.weekAnchor, delta);
      else if (state.uiPeriod === 'month') state.monthAnchor = shiftMonth(state.monthAnchor.year, state.monthAnchor.month, delta);
      else state.yearAnchor = shiftYear(state.yearAnchor, delta);
    }

    function currentQuery() { return buildAnchorQuery(state.uiPeriod, currentAnchor()); }

    // silent (2026-08-21, same fix as overview.js's load()): the 25s background
    // poll used to unconditionally clear() the whole report and show "Loading…"
    // on every tick, blanking already-correct data for no reason — the "keeps
    // refreshing, goes blank and comes back" complaint. refreshIfVisible() now
    // passes silent=true so a background tick fetches quietly and swaps content
    // in only once, via the same renderInto() call already below; every
    // user-driven call (period/prev/next/branch change) still shows the loading
    // state, since those really do invalidate what's on screen.
    function fetchAndRender(silent) {
      if (!apiFetch) return;
      state.loading = true;
      if (!silent) {
        clear(body);
        body.appendChild(msg('ov-loading muted', t('reports.loading_report')));
      }
      var q = currentQuery();
      var params = [];
      Object.keys(q).forEach(function (k) { params.push(k + '=' + encodeURIComponent(q[k])); });
      var path = appendBranchQuery('/api/reports' + (params.length ? '?' + params.join('&') : ''), branchState.filter, opts.session);
      var period = state.uiPeriod, anchor = currentAnchor();
      apiFetch(path).then(function (reports) {
        state.loading = false;
        state.loaded = true;
        state.lastReports = reports;
        renderInto(body, reports, period, anchor);
      }).catch(function () {
        state.loading = false;
        if (!state.lastReports) {
          clear(body);
          body.appendChild(msg('ov-error', t('reports.load_failed')));
        } else if (!silent) {
          // Keep the last-known-good report on screen — same "stale cache is
          // fine" rule this app already uses elsewhere, so a real user-driven
          // reload doesn't blank the page just because a refetch failed.
          renderInto(body, state.lastReports, period, anchor);
        }
      });
    }

    prevBtn.addEventListener('click', function () { shiftAnchor(-1); updateNavLabel(); fetchAndRender(); });
    nextBtn.addEventListener('click', function () { shiftAnchor(1); updateNavLabel(); fetchAndRender(); });

    var exportBusy = false;
    exportBtn.addEventListener('click', function () {
      if (exportBusy) return;
      // A3 (Owner 2026-07-10): only remind if there are unreviewed receipts; export straight
      // through otherwise. runExportGuard keeps the empty-data guard + fetches the scoped review
      // count itself.
      ExportGuards.runExportGuard({
        data: state.lastReports,
        apiFetch: apiFetch,
        onEmpty: function (m) { Escape.setText(exportStatus, m); },
        onReview: switchView ? function () { switchView('activity'); } : undefined,
        onProceed: function () {
          // Owner request 2026-07-06: ask which timeframe every time, instead of
          // silently exporting whatever period/anchor happens to be on screen.
          showExportChoiceDialog(function (choice) {
            exportBusy = true;
            exportBtn.disabled = true;
            Escape.setText(exportStatus, t('reports.preparing_export'));
            exportExcel(exportRangeFor(choice)).then(function () {
              exportBusy = false;
              exportBtn.disabled = false;
              Escape.setText(exportStatus, t('reports.export_downloaded'));
            }).catch(function (err) {
              exportBusy = false;
              exportBtn.disabled = false;
              var status = err && typeof err === 'object' ? err.status : 0;
              Escape.setText(exportStatus, exportErrorMessage(status));
            });
          });
        },
      });
    });

    if (branchSelect) {
      branchSelect.addEventListener('change', function () {
        branchState.filter = branchSelect.value || 'all';
        state.loaded = false;
        fetchAndRender();
      });
    }
    renderBranchFilter();
    loadBranches();

    var refreshTimer = null;
    function visible() { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }
    function refreshIfVisible() { if (visible() && !state.loading) fetchAndRender(true); }
    function onVisibilityChange() { if (visible()) refreshIfVisible(); }
    function startLiveUpdates() {
      if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', refreshIfVisible);
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibilityChange);
      if (typeof setInterval === 'function') refreshTimer = setInterval(refreshIfVisible, 25000);
    }
    function destroy() {
      if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
      refreshTimer = null;
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', refreshIfVisible);
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    startLiveUpdates();

    // Lazy-load on first view (mirrors overview.js's load-on-first-show pattern).
    function load() {
      if (state.loading || state.loaded || !apiFetch) return;
      fetchAndRender();
    }

    return { el: rootEl, load: load, renderInto: function (r) { renderInto(body, r, state.uiPeriod, currentAnchor()); }, destroy: destroy };
  }

  return {
    // pure
    categoryBreakdown: categoryBreakdown,
    buildAnchorQuery: buildAnchorQuery,
    weekdayBuckets: weekdayBuckets,
    monthWeekBuckets: monthWeekBuckets,
    yearMonthBuckets: yearMonthBuckets,
    formatDayHeading: formatDayHeading,
    formatWeekHeading: formatWeekHeading,
    formatMonthHeading: formatMonthHeading,
    formatYearHeading: formatYearHeading,
    startOfWeekIso: startOfWeekIso,
    addDaysIso: addDaysIso,
    shiftDay: shiftDay,
    shiftWeek: shiftWeek,
    shiftMonth: shiftMonth,
    shiftYear: shiftYear,
    monthRangeFor: monthRangeFor,
    weekRangeFor: weekRangeFor,
    yearRangeFor: yearRangeFor,
    excelFilename: excelFilename,
    exportErrorMessage: exportErrorMessage,
    EXPORT_CHOICES: EXPORT_CHOICES,
    exportChoiceLabel: exportChoiceLabel,
    exportRangeFor: exportRangeFor,
    branchFilterOptions: branchFilterOptions,
    branchQueryValue: branchQueryValue,
    appendBranchQuery: appendBranchQuery,
    // render (browser)
    mount: mount,
    renderInto: renderInto,
  };
});
