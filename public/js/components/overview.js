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
    module.exports = factory(require('../escape'), require('../format'), require('../api'), require('../i18n'));
  } else {
    root.Overview = factory(root.Escape, root.Format, root.Api, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var tp = (I18n && I18n.tp) || function (k) { return k; };

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---- pure helpers: numbers / shapes -------------------------------------

  function overviewSegments() {
    return [
      { id: 'summary', label: t('overview.tab_summary') },
      { id: 'trends', label: t('overview.tab_trends') },
    ];
  }

  function branchFilterOptions(branches, isAdmin) {
    if (!isAdmin) return [];
    var out = [
      { value: 'all', label: t('overview.branch_all') },
      { value: 'mine', label: t('overview.branch_mine') },
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

  // ---- automation-impact metrics (C4 UI) ---------------------------------

  function finiteOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Keep the server contract's null/unavailable distinction intact. In
  // particular, a missing statement audit trail never becomes a fake zero.
  function automationImpactModel(payload) {
    var p = payload && typeof payload === 'object' ? payload : {};
    var client = p.client && typeof p.client === 'object' ? p.client : {};
    var internal = p.internal && typeof p.internal === 'object' ? p.internal : {};
    var meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
    var statementsAvailable = meta.statementsGeneratedAvailable === true;
    var statements = statementsAvailable ? finiteOrNull(client.statementsGenerated) : null;
    var low = Array.isArray(internal.lowConfidenceByField) ? internal.lowConfidenceByField.map(function (r) {
      return { field: str(r && r.field), count: toNum(r && r.count) };
    }).filter(function (r) { return r.field !== ''; }) : [];
    var corrected = Array.isArray(internal.mostCorrectedCategories) ? internal.mostCorrectedCategories.map(function (r) {
      return { category: str(r && r.category), count: toNum(r && r.count) };
    }).filter(function (r) { return r.category !== ''; }) : [];
    return {
      receiptsProcessed: toNum(client.receiptsProcessed),
      noEditPct: toNum(client.noEditPct),
      hoursSaved: toNum(client.hoursSaved),
      statementsGenerated: statements,
      statementsGeneratedAvailable: statementsAvailable,
      manualMinutesPerReceipt: finiteOrNull(meta.manualMinutesPerReceipt),
      attentionRate: toNum(internal.attentionRate),
      avgDwellMinutes: finiteOrNull(internal.avgDwellMinutes),
      lowConfidenceByField: low,
      mostCorrectedCategories: corrected,
    };
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // Returns the selected month plus the inclusive ISO date range accepted by
  // GET /api/metrics. Invalid input falls back to the current local month.
  function metricsPeriod(nowOrValue) {
    var d;
    if (typeof nowOrValue === 'string' && /^\d{4}-\d{2}$/.test(nowOrValue)) {
      var parts = nowOrValue.split('-');
      d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    } else {
      d = new Date(typeof nowOrValue === 'number' ? nowOrValue : Date.now());
    }
    if (!Number.isFinite(d.getTime())) d = new Date();
    var y = d.getFullYear(); var m = d.getMonth();
    var value = y + '-' + pad2(m + 1);
    var last = new Date(y, m + 1, 0).getDate();
    return { value: value, from: value + '-01', to: value + '-' + pad2(last) };
  }

  function metricsPath(period) {
    var p = period && typeof period === 'object' ? period : metricsPeriod();
    return '/api/metrics?from=' + encodeURIComponent(str(p.from)) + '&to=' + encodeURIComponent(str(p.to));
  }

  function str(v) { return v === null || v === undefined ? '' : String(v); }

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

  // Sum byCategoryCount (bill counts, not money) across every bucket ->
  // [{name, count}] sorted biggest-first. Tolerant of buckets that predate
  // byCategoryCount (older report shape) — just contributes nothing for those.
  function categoryCountBreakdown(reports) {
    var totals = {};
    buckets(reports).forEach(function (b) {
      var byCatCount = b && b.byCategoryCount;
      if (!byCatCount || typeof byCatCount !== 'object') return;
      Object.keys(byCatCount).forEach(function (cat) {
        totals[cat] = (totals[cat] || 0) + toNum(byCatCount[cat]);
      });
    });
    var rows = [];
    Object.keys(totals).forEach(function (cat) {
      if (totals[cat] > 0) rows.push({ name: cat, count: totals[cat] });
    });
    rows.sort(function (a, b) { return b.count - a.count; });
    return rows;
  }

  // 'YYYY-MM-DD' -> local calendar date string, or '' for anything malformed.
  function isoDateLocal(now) {
    var d = new Date(typeof now === 'number' ? now : Date.now());
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : String(m)) + '-' + (day < 10 ? '0' + day : String(day));
  }

  // An all-time (period=year) report's buckets -> [{name: 'YYYY', total}],
  // most recent year first. Tolerant of missing/malformed input (never throws).
  function yearlyBreakdown(allTimeReport) {
    var rows = buckets(allTimeReport)
      .map(function (b) { return { name: b && b.key !== undefined && b.key !== null ? String(b.key) : '', total: toNum(b && b.total) }; })
      .filter(function (r) { return r.total > 0; });
    rows.sort(function (a, b) { return b.name < a.name ? -1 : b.name > a.name ? 1 : 0; }); // desc, 'YYYY' sorts lexically fine
    return rows;
  }

  // 'YYYY-MM-DD' start + end -> 'Jan 1 – Jul 6, 2026' (year only shown once,
  // twice if the range spans two years). '' for missing/malformed input.
  function formatDateRange(from, to) {
    function parts(iso) {
      if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
      var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
      if (m < 1 || m > 12 || d < 1 || d > 31) return null;
      return { y: y, m: m, d: d };
    }
    var f = parts(from), t = parts(to);
    if (!f || !t) return '';
    var fromStr = MONTH_LABELS[f.m - 1] + ' ' + f.d + (f.y !== t.y ? ', ' + f.y : '');
    var toStr = MONTH_LABELS[t.m - 1] + ' ' + t.d + ', ' + t.y;
    return fromStr + ' – ' + toStr;
  }

  // reports totals -> KPI cards [{label, value, sub?, breakdown?}]. Values are
  // display strings; the top-category name is kept RAW so the render layer
  // escapes it (asserted by the tests). Never throws on null/undefined.
  // `now` is an injectable clock (like overviewReportsPath), defaulting to
  // Date.now(), so the "until today" sub-label is deterministic under test.
  function kpiModel(reports, now) {
    var r = reports || {};
    var top = topCategory(r);
    var year = (r && typeof r.from === 'string' && r.from.length >= 4)
      ? r.from.slice(0, 4) : String(new Date(typeof now === 'number' ? now : Date.now()).getFullYear());
    return [
      // "start date and until [today]" — the year's start through the day the
      // Overview was actually viewed (not the query's Dec-31 upper bound,
      // which hasn't happened yet if the year isn't over).
      { label: t('overview.kpi_total_spend'), value: Format.formatMoney(r.total), sub: formatDateRange(year + '-01-01', isoDateLocal(now)) },
      // "Expenses" was ambiguous (expenses as in cost, or as in a count?) —
      // Owner request 2026-07-05: make plain that this counts saved receipts.
      { label: t('overview.kpi_total_bills'), value: Format.formatCount(r.count), breakdown: categoryCountBreakdown(r) },
      // Computed from the year-scoped `r`, but showed as a bare category name
      // with no context — Owner request 2026-07-06: a small "in <year>"
      // sub-label, same idea as Total spend's date range. "Months with
      // expenses" (the 4th card this used to sit beside) was dropped the same
      // day — Owner said it wasn't needed, freeing that slot for the
      // all-time/overall-spending card instead (see renderInto).
      { label: t('overview.kpi_top_category'), value: top ? top.name : '—', sub: tp('overview.kpi_top_category_sub', year) },
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

  // Category name -> a stable palette class suffix ('c0'..'c17', or 'others').
  // Duplicated rather than imported to keep components independently
  // loadable — same pattern as chartModel/categoryBreakdown existing
  // independently in reports.js. Never returns markup; never throws.
  //
  // Bug fix (owner report 2026-07-06): this used to be a pure hash into only
  // 10 slots. With 17 real built-in categories (lib/categorize.js CATEGORIES),
  // that's guaranteed collisions by pigeonhole — e.g. "Fuel & Auto" and
  // "Office Supplies" both hashed to the same colour. Two different
  // categories showing the identical colour made it LOOK like "colours
  // change" whenever a delete/edit changed which categories were visible
  // (a colliding pair appearing/disappearing), even though no single
  // category's colour ever actually moved. Fixed by giving every KNOWN
  // built-in category its own permanently-reserved slot (CATEGORY_ORDER,
  // 0-16); only a genuinely custom/unrecognised category name still falls
  // back to the hash (across all 18 slots — rare enough to accept).
  var PALETTE_SIZE = 18;
  // Same order as lib/categorize.js's CATEGORIES (minus 'Others', which is
  // handled separately below) — keep in sync if that list ever changes.
  var CATEGORY_ORDER = [
    'meals & entertainment', 'groceries', 'fuel & auto', 'travel', 'lodging',
    'software & subscriptions', 'office supplies', 'utilities', 'rent & lease',
    'professional services', 'marketing & advertising', 'inventory & cogs',
    'equipment & hardware', 'shipping & postage', 'bank & fees', 'healthcare',
    'education & training',
  ];
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  // Shared key normalisation (trim + lowercase) — used both by categoryColor's
  // lookup/hash AND by the custom-colour override map below, so "Rent & Lease"
  // and " rent & lease " always resolve to the exact same override entry.
  function normaliseCategoryKey(name) {
    return String(name === null || name === undefined ? '' : name).trim().toLowerCase();
  }
  function categoryColor(name) {
    var key = normaliseCategoryKey(name);
    if (key === '' || key === 'others') return 'others';
    var fixedIndex = CATEGORY_ORDER.indexOf(key);
    if (fixedIndex !== -1) return 'c' + fixedIndex;
    return 'c' + (hashString(key) % PALETTE_SIZE);
  }

  // ---- custom category colours (Owner request 2026-07-05) -----------------
  // Lets a user override the auto-assigned donut/legend colour per category by
  // clicking its swatch. Stored client-side (localStorage) as {normalisedName:
  // '#hexcolor'}, so it persists across visits on this device/browser without
  // needing a backend column + migration for what is a per-user display
  // preference. Pure lookup/merge helpers here; localStorage I/O lives in the
  // render layer (hasDom-gated) below.
  var COLOR_OVERRIDES_KEY = 'ov_category_colors';

  // A curated set of picker choices (10 palette defaults + a few extras) shown
  // in the popup, plus a native colour input for anything else.
  var COLOR_PRESETS = [
    '#3f8fd1', '#5a6bd8', '#8a5fd6', '#b558c9', '#d858a8',
    '#e0567e', '#e0574f', '#e88a2f', '#e0b21f', '#a3a821',
    '#41716b', '#5f7a47', '#8a6a44', '#b06746', '#6b6b6b',
  ];

  // name -> resolved hex colour, or null if no override is set for it (falls
  // back to the default hashed palette in that case). Never throws.
  function resolveCategoryOverride(name, overrides) {
    var map = overrides && typeof overrides === 'object' ? overrides : {};
    var key = normaliseCategoryKey(name);
    var v = key && typeof map[key] === 'string' ? map[key].trim() : '';
    return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
  }

  function formatPercent(v) { return (Math.round(toNum(v) * 10) / 10) + '%'; }

  // Overview scopes to the CURRENT YEAR. A monthly chart pulled with no date range
  // buckets every year in the data side-by-side (2018-01, 2023-12, 2024-04, 2026-05…) —
  // meaningless at a glance. The Reports screen's Year tab is where other years are
  // explored; the Overview is "this year so far". Pure, injectable clock for testing.
  function overviewReportsPath(now, filter, session) {
    var y = new Date(typeof now === 'number' ? now : Date.now()).getFullYear();
    return appendBranchQuery('/api/reports?period=month&from=' + y + '-01-01&to=' + y + '-12-31', filter, session);
  }

  // All-time (no date bounds) — powers the "Total spending until now" box.
  // It remains account-wide for All branches, or carries the selected branch
  // for an admin's My uploads/specific-branch view.
  function allTimeReportsPath(filter, session) { return appendBranchQuery('/api/reports?period=year', filter, session); }

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
    // Bug fix (2026-08-09, found via a real account with ONE category at 100% of spend):
    // a span of exactly 360deg puts the start and end points at the identical (x,y) —
    // sin/cos are periodic — so the SVG arc command degenerates to a zero-length path
    // and the whole donut renders invisible even though the data is correct. Clamping
    // just short of a full circle keeps start/end distinct; the 0.01deg gap is not
    // visible at any real render size.
    if (e - s >= 360) e = s + 359.99;
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

  // Guarded localStorage access — same defensive pattern as activity.js's ss()
  // (privacy mode / disabled storage can make these throw; never let a
  // display-preference feature break the page). Returns {} / no-ops on failure.
  function loadColorOverrides() {
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(COLOR_OVERRIDES_KEY) : null;
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }
  function saveColorOverrides(map) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(COLOR_OVERRIDES_KEY, JSON.stringify(map)); }
    catch (e) { /* ignore — storage full/disabled, override just won't persist */ }
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function textCell(tag, className, value) {
    var node = el(tag, className);
    Escape.setText(node, value);
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

  // One KPI card as its own grid cell. `areaClass` places it in the Overview
  // grid (grid-template-areas); `accent` gives the hero card the filled-accent
  // treatment. Big number renders above its label (reference-dashboard style).
  // Untrusted text (e.g. a category name) is escaped.
  function renderKpiCard(card, areaClass, accent) {
    var node = el('div', 'ov-kpi' + (areaClass ? ' ' + areaClass : '') + (accent ? ' ov-kpi--accent' : ''));
    var value = el('div', 'ov-kpi-value');
    Escape.setText(value, card.value);
    var label = el('div', 'ov-kpi-label');
    Escape.setText(label, card.label);
    node.appendChild(value);
    node.appendChild(label);
    if (card.sub) {
      var sub = el('div', 'ov-kpi-sub');
      Escape.setText(sub, card.sub);
      node.appendChild(sub);
    }
    if (Array.isArray(card.breakdown) && card.breakdown.length) {
      var list = el('ul', 'ov-kpi-breakdown');
      card.breakdown.forEach(function (row) {
        var li = el('li', 'ov-kpi-breakdown-row');
        var name = el('span', 'ov-kpi-breakdown-name');
        Escape.setText(name, row.name);
        var count = el('span', 'ov-kpi-breakdown-count');
        // Category rows carry a bill count (Total bills card); year rows carry
        // a money total (Overall-spending card) — format whichever is present.
        Escape.setText(count, typeof row.total === 'number' ? Format.formatMoney(row.total) : Format.formatCount(row.count));
        li.appendChild(name);
        li.appendChild(count);
        list.appendChild(li);
      });
      node.appendChild(list);
    }
    return node;
  }

  // Horizontal smooth line/area chart (reference-dashboard style): months run
  // left-to-right along the x-axis (Jan..Dec), spend rises up the y-axis. Soft
  // horizontal gridlines + a rounded y-axis scale give it the "Visitors" look.
  // Each point's exact amount shows in a popup on hover/focus (a <title> is also
  // present as an accessible fallback for keyboard/AT users who can't hover).
  var lineChartClipCounter = 0;

  function renderLineChart(rows, year) {
    var figure = el('figure', 'ov-linechart');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, tp('overview.chart_caption_month', year));
    figure.appendChild(caption);

    var width = 720, height = 300;
    // calloutZone is dedicated headroom ABOVE the plotted line so a peak's value
    // pill never has to overlap its own dot (bug: "449 hidden on dot") — the
    // pill has real room to sit above the highest point instead of being
    // clamped against the top of the viewBox.
    var calloutZone = 34;
    var padTop = 10, padBottom = 28, padLeft = 46, padRight = 16;
    var plotW = width - padLeft - padRight;
    var plotTop = padTop + calloutZone;
    var plotH = height - plotTop - padBottom;
    var baseY = plotTop + plotH;
    var n = rows.length;
    var max = rows.reduce(function (m, r) { return r.value > m ? r.value : m; }, 0);
    var denom = max > 0 ? max : 1;

    var points = rows.map(function (r, i) {
      return {
        x: n > 1 ? padLeft + (i / (n - 1)) * plotW : padLeft + plotW / 2,
        y: plotTop + plotH - (r.value / denom) * plotH,
        label: r.label,
        value: r.value,
      };
    });

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('class', 'ov-linechart-svg');
    svg.setAttribute('role', 'img');

    // Bug fix: the Catmull-Rom smoothing (smoothPathD) can overshoot past a
    // zero-value point when the neighbouring month is a big spike, drawing the
    // curve/area a few px BELOW the x-axis line ("graph flow go under x axis
    // line"). Clip the line+area to the plot rectangle so nothing ever renders
    // past the baseline. A per-render id avoids collisions if this ever mounts
    // more than once on the same page.
    var clipId = 'ov-line-clip-' + (++lineChartClipCounter);
    var clipPath = document.createElementNS(SVG_NS, 'clipPath');
    clipPath.setAttribute('id', clipId);
    var clipRect = document.createElementNS(SVG_NS, 'rect');
    clipRect.setAttribute('x', padLeft);
    clipRect.setAttribute('y', plotTop);
    clipRect.setAttribute('width', plotW);
    clipRect.setAttribute('height', plotH);
    clipPath.appendChild(clipRect);
    svg.appendChild(clipPath);

    // horizontal gridlines + a rounded y-axis value scale (5 steps)
    var STEPS = 4;
    for (var s = 0; s <= STEPS; s++) {
      var gy = baseY - (s / STEPS) * plotH;
      var grid = document.createElementNS(SVG_NS, 'line');
      grid.setAttribute('x1', padLeft); grid.setAttribute('y1', gy);
      grid.setAttribute('x2', padLeft + plotW); grid.setAttribute('y2', gy);
      grid.setAttribute('class', 'ov-chart-grid');
      svg.appendChild(grid);

      var vlbl = document.createElementNS(SVG_NS, 'text');
      vlbl.setAttribute('x', padLeft - 8);
      vlbl.setAttribute('y', gy + 3);
      vlbl.setAttribute('class', 'ov-bar-label');
      vlbl.setAttribute('text-anchor', 'end');
      Escape.setText(vlbl, String(Math.round((s / STEPS) * max)));
      svg.appendChild(vlbl);
    }

    // month labels along the bottom (x-axis)
    points.forEach(function (p) {
      var lbl = document.createElementNS(SVG_NS, 'text');
      lbl.setAttribute('x', p.x);
      lbl.setAttribute('y', baseY + 18);
      lbl.setAttribute('class', 'ov-bar-label');
      lbl.setAttribute('text-anchor', 'middle');
      Escape.setText(lbl, p.label);
      svg.appendChild(lbl);
    });

    var lineD = smoothPathD(points);
    if (points.length > 1) {
      var last = points[points.length - 1], first = points[0];
      var areaD = lineD + ' L' + last.x + ',' + baseY + ' L' + first.x + ',' + baseY + ' Z';
      var area = document.createElementNS(SVG_NS, 'path');
      area.setAttribute('d', areaD);
      area.setAttribute('class', 'ov-chart-area');
      area.setAttribute('clip-path', 'url(#' + clipId + ')');
      svg.appendChild(area);
    }

    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', lineD);
    line.setAttribute('class', 'ov-chart-line');
    line.setAttribute('fill', 'none');
    line.setAttribute('clip-path', 'url(#' + clipId + ')');
    svg.appendChild(line);

    figure.appendChild(svg);

    // Always-visible value callouts (reference-dashboard style): a small
    // rounded pill sits above every point showing its exact amount, all the
    // time — not just on hover. Built as one SVG <g> per point so the pill
    // scales and positions together with its little pointer/tail.
    points.forEach(function (p) {
      var text = Format.formatMoney(p.value).replace(/\.00$/, '');
      var pillW = Math.max(30, text.length * 8.5 + 14);
      var pillH = 22;
      var pillX = Math.min(Math.max(p.x - pillW / 2, padLeft), padLeft + plotW - pillW);
      // Clamp against the top of the reserved calloutZone (not 0) so the pill
      // never rides up over the dot at the highest point on the chart.
      var pillY = Math.max(p.y - pillH - 14, padTop);

      var group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'ov-chart-callout');

      var pill = document.createElementNS(SVG_NS, 'rect');
      pill.setAttribute('x', pillX);
      pill.setAttribute('y', pillY);
      pill.setAttribute('width', pillW);
      pill.setAttribute('height', pillH);
      pill.setAttribute('rx', 6);
      pill.setAttribute('class', 'ov-chart-callout-bg');
      group.appendChild(pill);

      var label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', pillX + pillW / 2);
      label.setAttribute('y', pillY + pillH / 2 + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'ov-chart-callout-text');
      Escape.setText(label, text);
      group.appendChild(label);

      svg.appendChild(group);
    });

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
      svg.appendChild(dot);
    });

    return figure;
  }

  // Category-breakdown donut: percent share of this year's spend, with the
  // year's total in the center (matches the reference design) and a legend
  // list (colour swatch + name + percent) below/beside it.
  //
  // opts.overrides: {normalisedName: '#hex'} custom colours (Owner request
  // 2026-07-05) — when set for a category, it wins over the default hashed
  // palette class, applied as an inline style (so it overrides the CSS class
  // regardless of specificity) on BOTH the slice and its legend swatch.
  // opts.onSwatchClick(name, swatchEl): called when the user clicks a legend
  // swatch — the mount()-level caller owns opening the colour-picker popup.
  function renderDonut(rows, yearTotal, year, opts) {
    opts = opts || {};
    var overrides = opts.overrides || {};
    var wrap = el('div', 'ov-donut-wrap');
    var caption = el('figcaption', 'ov-chart-caption');
    Escape.setText(caption, tp('overview.chart_caption_category', year));
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
      wrap.appendChild(renderMessage('rp-categories-empty muted', t('overview.donut_empty')));
      return wrap;
    }

    var angle = 0;
    rows.forEach(function (r) {
      var span = r.frac * 360;
      var custom = resolveCategoryOverride(r.name, overrides);
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', donutSlicePath(cx, cy, rO, rI, angle, angle + span));
      path.setAttribute('class', 'ov-donut-slice ov-donut-slice--' + categoryColor(r.name));
      if (custom) path.style.fill = custom;
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
    Escape.setText(centerCaption, t('overview.donut_total'));
    svg.appendChild(centerCaption);

    body.appendChild(svg);

    var legend = el('ul', 'ov-donut-legend');
    rows.forEach(function (r) {
      var li = el('li', 'ov-donut-legend-row');
      var custom = resolveCategoryOverride(r.name, overrides);

      // The swatch is a real <button> now (was a plain <span>) — clicking it
      // opens the colour-picker popup so the user can set their own colour
      // for this category, instead of only ever getting the auto palette.
      var swatch = el('button', 'ov-donut-swatch ov-donut-swatch--' + categoryColor(r.name));
      swatch.type = 'button';
      swatch.setAttribute('aria-label', tp('overview.colorpicker_change', str(r.name)));
      swatch.title = tp('overview.colorpicker_click', str(r.name));
      if (custom) swatch.style.background = custom;
      if (typeof opts.onSwatchClick === 'function') {
        swatch.addEventListener('click', function () { opts.onSwatchClick(r.name, swatch); });
      }
      li.appendChild(swatch);

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

  // Small popup anchored under a clicked legend swatch: a grid of preset
  // colour choices, a native colour input for anything else, and a "Use
  // default" reset. Owner request 2026-07-05: "put multiple color option on
  // categories name when user click the small color icon, popup small
  // multiple color window so user can set own colors". Dismiss via the
  // transparent backdrop, Escape, or picking a colour (which also dismisses).
  function openColorPicker(anchorEl, currentColor, onPick, onReset) {
    var backdrop = el('div', 'ov-colorpick-backdrop');
    var pop = el('div', 'ov-colorpick');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('overview.colorpicker_choose'));

    var grid = el('div', 'ov-colorpick-grid');
    COLOR_PRESETS.forEach(function (hex) {
      var swatchBtn = el('button', 'ov-colorpick-swatch');
      swatchBtn.type = 'button';
      swatchBtn.style.background = hex;
      swatchBtn.setAttribute('aria-label', hex);
      if (currentColor && currentColor.toLowerCase() === hex.toLowerCase()) swatchBtn.classList.add('is-selected');
      swatchBtn.addEventListener('click', function () { onPick(hex); close(); });
      grid.appendChild(swatchBtn);
    });
    pop.appendChild(grid);

    var customRow = el('div', 'ov-colorpick-custom');
    var customLabel = el('label', 'ov-colorpick-custom-label');
    Escape.setText(customLabel, t('overview.colorpicker_custom'));
    var customInput = el('input', 'ov-colorpick-input');
    customInput.type = 'color';
    customInput.value = currentColor || '#5f7a47';
    customInput.addEventListener('input', function () { onPick(customInput.value); });
    customLabel.appendChild(customInput);
    customRow.appendChild(customLabel);
    pop.appendChild(customRow);

    var resetBtn = el('button', 'ov-colorpick-reset');
    resetBtn.type = 'button';
    Escape.setText(resetBtn, t('overview.colorpicker_use_default'));
    resetBtn.addEventListener('click', function () { onReset(); close(); });
    pop.appendChild(resetBtn);

    backdrop.appendChild(pop);
    document.body.appendChild(backdrop);

    // Position the popup just under the swatch that was clicked, clamped so
    // it never runs off the right edge of the viewport.
    var rect = anchorEl.getBoundingClientRect();
    var popW = 216;
    var left = Math.min(rect.left, (typeof window !== 'undefined' ? window.innerWidth : 1024) - popW - 16);
    pop.style.position = 'fixed';
    pop.style.top = (rect.bottom + 8) + 'px';
    pop.style.left = Math.max(8, left) + 'px';

    function onKeydown(ev) { if (ev.key === 'Escape') close(); }
    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener('keydown', onKeydown);
    }
    document.addEventListener('keydown', onKeydown);
    backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(); });
  }

  function metricText(n, digits) {
    var value = toNum(n).toFixed(digits == null ? 0 : digits);
    return value.replace(/\.0+$/, '');
  }

  function metricTile(label, value, sub) {
    var tile = el('div', 'ov-metric-tile');
    tile.appendChild(textCell('span', 'ov-metric-label', label));
    tile.appendChild(textCell('strong', 'ov-metric-value', value));
    if (sub) tile.appendChild(textCell('span', 'ov-metric-sub muted', sub));
    return tile;
  }

  function renderMetricsBand(host, model, session, period, onPeriodChange, detailsOpen, onDetailsToggle) {
    if (!hasDom() || !host) return;
    clear(host);
    var band = el('section', 'ov-metrics-band');
    var heading = el('div', 'ov-metrics-heading');
    heading.appendChild(textCell('h3', 'ov-metrics-title', t('overview.metrics_title')));
    var periodLabel = el('label', 'ov-metrics-period-label');
    periodLabel.appendChild(textCell('span', 'ov-metrics-period-caption', t('overview.metrics_period')));
    var periodInput = el('input', 'ov-metrics-period');
    periodInput.type = 'month';
    periodInput.value = period && period.value ? period.value : '';
    periodInput.setAttribute('aria-label', t('overview.metrics_period_aria'));
    periodInput.addEventListener('change', function () {
      if (typeof onPeriodChange === 'function') onPeriodChange(periodInput.value);
    });
    periodLabel.appendChild(periodInput);
    heading.appendChild(periodLabel);
    band.appendChild(heading);

    if (!model) {
      band.appendChild(textCell('p', 'ov-metrics-loading muted', ''));
      host.appendChild(band);
      return;
    }

    var tiles = el('div', 'ov-metrics-tiles');
    tiles.appendChild(metricTile(t('overview.metrics_receipts_processed'), metricText(model.receiptsProcessed), t('overview.metrics_receipts_processed_sub')));
    tiles.appendChild(metricTile(t('overview.metrics_no_edit_pct'), metricText(model.noEditPct, 1) + '%', t('overview.metrics_no_edit_sub')));
    var assumption = model.manualMinutesPerReceipt == null
      ? t('overview.metrics_time_unavailable')
      : tp('overview.metrics_time_assumption', metricText(model.manualMinutesPerReceipt, 1));
    tiles.appendChild(metricTile(t('overview.metrics_hours_saved'), metricText(model.hoursSaved, 1), assumption));
    if (model.statementsGeneratedAvailable) {
      tiles.appendChild(metricTile(t('overview.metrics_statements'), model.statementsGenerated == null ? '—' : metricText(model.statementsGenerated), t('overview.metrics_statements_sub')));
    }
    band.appendChild(tiles);

    if (session && session.role === 'admin') {
      var detailsBtn = el('button', 'ov-metrics-details-toggle');
      detailsBtn.type = 'button';
      detailsBtn.setAttribute('aria-expanded', detailsOpen ? 'true' : 'false');
      Escape.setText(detailsBtn, detailsOpen ? t('overview.metrics_hide_details') : t('overview.metrics_show_details'));
      detailsBtn.addEventListener('click', function () { if (typeof onDetailsToggle === 'function') onDetailsToggle(); });
      band.appendChild(detailsBtn);
      if (detailsOpen) {
        var details = el('div', 'ov-metrics-details');
        details.appendChild(metricTile(t('overview.metrics_attention_rate'), metricText(model.attentionRate, 1) + '%'));
        details.appendChild(metricTile(t('overview.metrics_avg_dwell'), model.avgDwellMinutes == null ? '—' : metricText(model.avgDwellMinutes, 1) + ' min'));
        var low = el('div', 'ov-metrics-detail-list');
        low.appendChild(textCell('h4', 'ov-metrics-detail-title', t('overview.metrics_low_confidence')));
        if (!model.lowConfidenceByField.length) low.appendChild(textCell('p', 'muted', t('overview.metrics_none_recorded')));
        else {
          var lowList = el('ul');
          model.lowConfidenceByField.forEach(function (r) { lowList.appendChild(textCell('li', '', r.field + ': ' + metricText(r.count))); });
          low.appendChild(lowList);
        }
        details.appendChild(low);
        var corrected = el('div', 'ov-metrics-detail-list');
        corrected.appendChild(textCell('h4', 'ov-metrics-detail-title', t('overview.metrics_most_corrected')));
        if (!model.mostCorrectedCategories.length) corrected.appendChild(textCell('p', 'muted', t('overview.metrics_none_recorded')));
        else {
          var correctedList = el('ul');
          model.mostCorrectedCategories.forEach(function (r) { correctedList.appendChild(textCell('li', '', r.category + ': ' + metricText(r.count))); });
          corrected.appendChild(correctedList);
        }
        details.appendChild(corrected);
        band.appendChild(details);
      }
    }
    host.appendChild(band);
  }

  // Render the whole Overview into `container` from a (year-scoped) reports
  // object. `allTimeReport` is the unscoped (period=year) reports response —
  // its `.total` is every year's spend combined, and its `.buckets` (one per
  // year) become the "past years" list under the number. Owner request
  // 2026-07-06 (final layout): this card lives in the bottom-right's LEFT
  // cell (where "Top category" used to sit), Top category moved into the
  // RIGHT cell (where "Months with expenses" used to sit, now dropped
  // entirely) — no more separate full-width banner row. Missing/malformed
  // `allTimeReport` just skips the card (never throws). `donutOpts`
  // ({overrides, onSwatchClick}) is forwarded straight to renderDonut for the
  // custom-colour picker.
  function renderInto(container, reports, allTimeReport, donutOpts) {
    if (!hasDom() || !container) return;
    clear(container);
    var rows = chartModel(reports);
    var hasData = (reports && toNum(reports.count) > 0) || rows.length > 0;

    if (!hasData) {
      container.appendChild(renderMessage('ov-empty', t('overview.empty')));
      return;
    }

    // Derive the displayed year from the report's own `from` (set by
    // overviewReportsPath) rather than re-reading the live clock here, so the
    // year on screen always matches the data that was actually fetched.
    var year = (reports && typeof reports.from === 'string' && reports.from.length >= 4)
      ? reports.from.slice(0, 4) : String(new Date().getFullYear());

    // Each piece is a direct grid child placed into a named area (see .ov-root
    // grid-template-areas in app.css): stat cards in the narrow left rail, the
    // wide trend chart top-right, the category donut on the bottom-left, and
    // the all-time / top-category pair on the bottom-right.
    var cards = kpiModel(reports);   // [Total spend, Total bills, Top category]
    container.appendChild(renderKpiCard(cards[0], 'ov-cell-spend', true));
    container.appendChild(renderKpiCard(cards[1], 'ov-cell-count'));
    container.appendChild(renderLineChart(monthlySeries(reports, Number(year)), year));
    container.appendChild(renderDonut(categoryPercentBreakdown(reports), reports.total, year, donutOpts));
    if (allTimeReport && typeof allTimeReport === 'object' && Number.isFinite(toNum(allTimeReport.total))) {
      container.appendChild(renderKpiCard(
        { label: t('overview.kpi_alltime_label'), value: Format.formatMoney(allTimeReport.total), breakdown: yearlyBreakdown(allTimeReport) },
        'ov-cell-alltime'
      ));
    }
    container.appendChild(renderKpiCard(cards[2], 'ov-cell-topcat'));
  }

  // Mount point wired by app.js. Builds the section content: a loading state,
  // then fetches /api/reports (year-scoped + all-time) and swaps in data /
  // empty / error. Idempotent: only fetches once unless force===true.
  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);
    var Reports = opts.Reports || (typeof root !== 'undefined' && root.Reports) || null;

    var shell = el('div', 'ov-shell');
    section.appendChild(shell);

    var isAdmin = !!(opts.session && opts.session.role === 'admin');
    // Default an admin to the whole-company view ("All branches") rather than
    // "My uploads" (their own branch only): an admin who doesn't personally
    // upload much would otherwise open Overview to a near-empty screen and read
    // it as data loss. "My uploads" is still one click away in the dropdown.
    // A clerk stays 'all' as before — they have no dropdown and the server
    // scopes them to their own branch regardless (scopeEq).
    var branchState = { filter: 'all', branches: [], loaded: false };
    var branchSelect = null;
    if (isAdmin) {
      var branchToolbar = el('div', 'ov-filter-toolbar');
      branchSelect = el('select', 'ov-branch-filter');
      branchSelect.setAttribute('aria-label', t('overview.branch_filter_aria'));
      branchToolbar.appendChild(branchSelect);
      shell.appendChild(branchToolbar);
    }

    var metricsHost = el('div', 'ov-metrics-host');
    shell.appendChild(metricsHost);

    var segmentBar = el('div', 'ov-segments');
    var segmentButtons = {};
    overviewSegments().forEach(function (seg) {
      var btn = el('button', 'ov-segment-btn');
      btn.type = 'button';
      btn.setAttribute('data-overview-segment', seg.id);
      Escape.setText(btn, seg.label);
      segmentBar.appendChild(btn);
      segmentButtons[seg.id] = btn;
    });
    shell.appendChild(segmentBar);

    var summaryPanel = el('div', 'ov-segment-panel');
    summaryPanel.setAttribute('data-overview-panel', 'summary');
    var trendsPanel = el('div', 'ov-segment-panel');
    trendsPanel.setAttribute('data-overview-panel', 'trends');
    shell.appendChild(summaryPanel);
    shell.appendChild(trendsPanel);

    var container = el('div', 'ov-root');
    summaryPanel.appendChild(container);

    var reportInst = null;
    if (Reports && typeof Reports.mount === 'function') {
      reportInst = Reports.mount(trendsPanel, opts);
    } else {
      trendsPanel.appendChild(renderMessage('view-placeholder muted', t('overview.trends_unavailable')));
    }

    // Custom category colours are stored server-side (account-scoped, so they
    // follow the user across browsers/devices — owner request 2026-07-05), with
    // localStorage kept as an offline cache so the first paint is instant and a
    // colour still shows if the network is down. colorOverrides is seeded from
    // that cache, then reconciled to the server truth once /api/settings loads.
    // It is mutated in place (never reassigned) so the donutOpts object closed
    // over below always sees the latest values.
    var state = { loaded: false, loading: false, lastReports: null, lastAllTime: null, colorOverrides: loadColorOverrides(), activeSegment: 'summary', trendsLoaded: false };
    var metricsState = { period: metricsPeriod(), model: null, loading: false, detailsOpen: false };

    function renderMetrics() {
      renderMetricsBand(metricsHost, metricsState.model, opts.session, metricsState.period,
        function (value) { loadMetrics(value); }, metricsState.detailsOpen,
        function () { metricsState.detailsOpen = !metricsState.detailsOpen; renderMetrics(); });
    }

    function renderBranchFilter() {
      if (!branchSelect) return;
      clear(branchSelect);
      branchFilterOptions(branchState.branches, isAdmin).forEach(function (option) {
        var item = el('option', 'ov-branch-option');
        item.value = option.value;
        Escape.setText(item, option.label);
        branchSelect.appendChild(item);
      });
      branchSelect.value = branchState.filter;
    }

    function loadBranches() {
      if (!isAdmin || branchState.loaded || !apiFetch) return Promise.resolve();
      branchState.loaded = true;
      return apiFetch('/api/branches').then(function (payload) {
        branchState.branches = payload && Array.isArray(payload.branches) ? payload.branches : [];
        renderBranchFilter();
      }).catch(function () { renderBranchFilter(); });
    }

    function loadMetrics(periodValue) {
      metricsState.period = metricsPeriod(periodValue || metricsState.period.value);
      metricsState.model = null;
      metricsState.loading = true;
      renderMetrics();
      if (!apiFetch) { metricsState.loading = false; return; }
      apiFetch(metricsPath(metricsState.period)).then(function (payload) {
        metricsState.loading = false;
        metricsState.model = automationImpactModel(payload);
        renderMetrics();
      }).catch(function () {
        // Metrics are additive UX: an outage must never replace or block the
        // existing Overview reports/charts. Leave the quiet period shell in place.
        metricsState.loading = false;
        metricsState.model = null;
        renderMetrics();
      });
    }

    function showSegment(id) {
      if (id !== 'trends') id = 'summary';
      state.activeSegment = id;
      summaryPanel.hidden = id !== 'summary';
      trendsPanel.hidden = id !== 'trends';
      Object.keys(segmentButtons).forEach(function (key) {
        segmentButtons[key].classList.toggle('is-active', key === id);
      });
      if (id === 'trends' && !state.trendsLoaded) {
        state.trendsLoaded = true;
        if (reportInst && typeof reportInst.load === 'function') reportInst.load();
      }
    }
    segmentButtons.summary.addEventListener('click', function () { showSegment('summary'); });
    segmentButtons.trends.addEventListener('click', function () { showSegment('trends'); });
    showSegment('summary');

    // Best-effort push of the whole colour map to the server. Fire-and-forget:
    // a failure (offline / no token) is non-fatal — the change is already saved
    // to localStorage, so it still applies locally and will re-push next time.
    function pushColorsToServer() {
      if (!apiFetch) return;
      apiFetch('/api/settings/category-colors', {
        method: 'PUT',
        body: { colors: state.colorOverrides },
      }).catch(function () { /* offline / unauthed — localStorage already has it */ });
    }

    // Replace the in-memory map's contents in place (keep the same object
    // reference donutOpts holds) with `next`.
    function replaceOverrides(next) {
      Object.keys(state.colorOverrides).forEach(function (k) { delete state.colorOverrides[k]; });
      Object.keys(next || {}).forEach(function (k) { state.colorOverrides[k] = next[k]; });
    }

    // Re-render with whatever reports data we last successfully fetched —
    // used after a colour is picked/reset so the change shows immediately
    // without a network round-trip.
    function rerender() {
      if (state.lastReports) renderInto(container, state.lastReports, state.lastAllTime, donutOpts);
    }

    var donutOpts = {
      overrides: state.colorOverrides,
      onSwatchClick: function (categoryName, swatchEl) {
        var current = resolveCategoryOverride(categoryName, state.colorOverrides);
        openColorPicker(swatchEl, current, function (hex) {
          state.colorOverrides[normaliseCategoryKey(categoryName)] = hex;
          saveColorOverrides(state.colorOverrides); // instant local cache
          rerender();
          pushColorsToServer();                     // sync across devices
        }, function () {
          delete state.colorOverrides[normaliseCategoryKey(categoryName)];
          saveColorOverrides(state.colorOverrides);
          rerender();
          pushColorsToServer();
        });
      },
    };

    // Pull the server's saved colours and reconcile to them (server is the
    // source of truth for cross-device sync). Only overwrites when the request
    // actually succeeds — offline, we keep the localStorage cache untouched.
    function syncColorsFromServer() {
      if (!apiFetch) return;
      apiFetch('/api/settings/category-colors').then(function (resp) {
        var serverColors = resp && resp.colors && typeof resp.colors === 'object' ? resp.colors : {};
        replaceOverrides(serverColors);
        saveColorOverrides(state.colorOverrides); // keep the offline cache in step
        rerender();
      }).catch(function () { /* keep the localStorage cache we already rendered */ });
    }

    function load(force) {
      if (state.loading || (!force && state.loaded) || !apiFetch) return;
      state.loading = true;
      // Bug fix (2026-08-21, Barat: "dashboard keeps refreshing, going blank and
      // coming back" during normal use): startLiveUpdates()'s 25s background poll
      // calls load(true) while state.loaded is already true (real data on screen).
      // This used to unconditionally clear() the container and show "Loading…"
      // on EVERY poll tick, blanking already-correct data for no reason. Only do
      // that teardown on a genuine first load (state.loaded still false) — a
      // background refresh now fetches silently and swaps content in once via
      // the existing renderInto() call below, no visible flash in between.
      var isBackgroundRefresh = state.loaded;
      if (!isBackgroundRefresh) {
        clear(container);
        container.appendChild(renderMessage('ov-loading muted', t('overview.loading')));
      }
      // Year-scoped report drives the chart/KPIs; the all-time (period=year)
      // report supplies the "Overall spending until now" box —
      // its `.total` for the big number, its per-year `.buckets` for the
      // "past years" list underneath. Fetched in parallel, non-fatal if it
      // fails (the rest of the Overview still renders; the all-time card
      // just doesn't show).
      var allTimePromise = apiFetch(allTimeReportsPath(branchState.filter, opts.session)).catch(function () { return null; });
      apiFetch(overviewReportsPath(undefined, branchState.filter, opts.session)).then(function (reports) {
        return allTimePromise.then(function (allTime) {
          state.loading = false;
          state.loaded = true;
          state.lastReports = reports;
          state.lastAllTime = (allTime && Number.isFinite(toNum(allTime.total))) ? allTime : null;
          renderInto(container, reports, state.lastAllTime, donutOpts);
          syncColorsFromServer(); // reconcile local cache -> server truth
        });
      }).catch(function () {
        state.loading = false;
        // Leave loaded=false so a later revisit can retry.
        if (!state.lastReports) {
          clear(container);
          container.appendChild(renderMessage('ov-error', t('overview.error')));
        } else {
          renderInto(container, state.lastReports, state.lastAllTime, donutOpts);
        }
      });
    }

    var refreshTimer = null;
    function visible() { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }
    function refreshIfVisible() { if (visible()) load(true); }
    function onVisibilityChange() { if (visible()) refreshIfVisible(); }
    function startLiveUpdates() {
      if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', refreshIfVisible);
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibilityChange);
      if (typeof setInterval === 'function') refreshTimer = setInterval(refreshIfVisible, 25000);
    }
    function stopLiveUpdates() {
      if (refreshTimer !== null && typeof clearInterval === 'function') clearInterval(refreshTimer);
      refreshTimer = null;
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', refreshIfVisible);
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reportInst && typeof reportInst.destroy === 'function') reportInst.destroy();
    }
    if (branchSelect) {
      branchSelect.addEventListener('change', function () {
        branchState.filter = branchSelect.value || 'all';
        state.loaded = false;
        load();
      });
    }
    renderBranchFilter();

    // Metrics are independent of the Reports tab and fetch once on mount;
    // period changes call loadMetrics directly. No polling belongs to C4 (C7).
    renderMetrics();
    loadMetrics();
    loadBranches();
    startLiveUpdates();

    return {
      el: shell,
      load: function () {
        if (state.activeSegment === 'trends') showSegment('trends');
        else load();
      },
      renderInto: function (r, allTime) { state.lastReports = r; state.lastAllTime = allTime; renderInto(container, r, allTime, donutOpts); },
      destroy: stopLiveUpdates,
    };
  }

  return {
    // pure
    chartModel: chartModel,
    kpiModel: kpiModel,
    automationImpactModel: automationImpactModel,
    metricsPeriod: metricsPeriod,
    metricsPath: metricsPath,
    topCategory: topCategory,
    categoryCountBreakdown: categoryCountBreakdown,
    overviewSegments: overviewSegments,
    yearlyBreakdown: yearlyBreakdown,
    formatDateRange: formatDateRange,
    monthlySeries: monthlySeries,
    categoryPercentBreakdown: categoryPercentBreakdown,
    categoryColor: categoryColor,
    normaliseCategoryKey: normaliseCategoryKey,
    resolveCategoryOverride: resolveCategoryOverride,
    COLOR_PRESETS: COLOR_PRESETS,
    formatPercent: formatPercent,
    overviewReportsPath: overviewReportsPath,
    allTimeReportsPath: allTimeReportsPath,
    branchFilterOptions: branchFilterOptions,
    branchQueryValue: branchQueryValue,
    appendBranchQuery: appendBranchQuery,
    // pure geometry
    smoothPathD: smoothPathD,
    donutSlicePath: donutSlicePath,
    // render (browser)
    mount: mount,
    renderInto: renderInto,
  };
});
