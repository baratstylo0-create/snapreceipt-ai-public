// components/reports.js — the Reports screen (Task F): a period selector
// (day/week/month/year + optional date range) driving GET /api/reports, the
// SAME inline-SVG bar-chart technique as overview.js, a per-category breakdown,
// and an "Export to Excel" button that downloads GET /api/excel as a Blob.
//
// TWO layers, kept apart so the math is unit-testable without a DOM:
//   1. PURE transforms (chartModel / categoryBreakdown / buildReportsQuery /
//      excelFilename / exportErrorMessage) — no DOM, no network, never throw on
//      junk input. Covered by tests/frontend/reports.test.js.
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
    module.exports = factory(require('../escape'), require('../format'), require('../api'));
  } else {
    root.Reports = factory(root.Escape, root.Format, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PERIODS = ['day', 'week', 'month', 'year'];

  // ---- pure helpers -------------------------------------------------------

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function buckets(reports) {
    return reports && Array.isArray(reports.buckets) ? reports.buckets : [];
  }

  // reports.buckets -> [{label, value}] in bucket order. Mirrors overview.js's
  // chartModel exactly. Raw labels (escaped at render time), coerced numeric
  // values, tolerant of missing/garbage fields.
  function chartModel(reports) {
    return buckets(reports).map(function (b) {
      var key = b && b.key !== undefined && b.key !== null ? String(b.key) : '';
      return { label: key, value: toNum(b && b.total) };
    });
  }

  // Sum byCategory across every bucket and return the FULL sorted-desc list of
  // {name, total}, filtering non-positive totals. Mirrors overview.js's
  // topCategory aggregation logic, but returns everything instead of only the
  // winner. Never throws on null/garbage input.
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

  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isIsoShaped(v) { return typeof v === 'string' && ISO_DATE_RE.test(v); }

  var YEAR_RE = /^\d{4}$/;
  // A 4-digit year STRING (query values are strings) -> that year's full-calendar range.
  // Anything else (2-digit, non-numeric, a number, null) -> null. Never throws.
  function yearRange(year) {
    if (typeof year !== 'string' || !YEAR_RE.test(year)) return null;
    return { from: year + '-01-01', to: year + '-12-31' };
  }

  // Pull the distinct 4-digit year keys out of a period=year report's buckets, sorted
  // descending (newest first) — used to populate the Year selector from real data.
  // Tolerant of junk/empty/missing; never throws.
  function yearsFromReport(report) {
    var bs = report && Array.isArray(report.buckets) ? report.buckets : [];
    var seen = {};
    var out = [];
    bs.forEach(function (b) {
      var k = b && b.key !== undefined && b.key !== null ? String(b.key) : '';
      if (YEAR_RE.test(k) && !seen[k]) { seen[k] = true; out.push(k); }
    });
    out.sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; }); // desc
    return out;
  }

  // Which year the selector should default to: the current year if the data has it,
  // otherwise the most recent year present, otherwise the current year. Never throws.
  function pickDefaultYear(years, currentYear) {
    var list = Array.isArray(years) ? years : [];
    var cur = String(currentYear);
    if (list.indexOf(cur) !== -1) return cur;
    return list.length ? list[0] : cur;
  }

  // Validate period (day/week/month/year, default 'month') and from/to
  // (YYYY-MM-DD-shaped strings, dropped if malformed/missing). Returns a
  // query-string-ready object. Never throws on garbage input.
  //
  // BUG FIX (2026-07-04): month/week (and day) with NO explicit range used to bucket
  // across EVERY year in the data at once (e.g. 2018-01, 2024-04, 2026-05 side by side).
  // When a `year` is supplied and the caller hasn't set an explicit from/to, scope the
  // query to that whole year (Jan 1 – Dec 31) so the chart shows ONE year's periods.
  // The `year` period itself is deliberately NOT scoped — it exists to compare years.
  function buildReportsQuery(period, from, to, year) {
    var p = PERIODS.indexOf(period) !== -1 ? period : 'month';
    var q = { period: p };
    var hasFrom = isIsoShaped(from), hasTo = isIsoShaped(to);
    if (hasFrom) q.from = from;
    if (hasTo) q.to = to;
    if (!hasFrom && !hasTo && p !== 'year') {
      var yr = yearRange(year);
      if (yr) { q.from = yr.from; q.to = yr.to; }
    }
    return q;
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
      case 401: return 'Your access token is missing or invalid. Please try again.';
      case 502: return 'Could not export to Excel right now. Please try again shortly.';
      default:  return 'Could not export to Excel. Please try again.';
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

  function renderCategoryBreakdown(rows) {
    var wrap = el('div', 'rp-categories');
    var title = el('h4', 'rp-categories-title');
    Escape.setText(title, 'By category');
    wrap.appendChild(title);

    if (!rows.length) {
      wrap.appendChild(msg('rp-categories-empty muted', 'No category spend for this period.'));
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

  // Render the whole Reports body into `container` from a reports object.
  function renderInto(container, reports) {
    if (!hasDom() || !container) return;
    clear(container);
    var rows = chartModel(reports);
    var hasData = (reports && toNum(reports.count) > 0) || rows.length > 0;

    if (reports && reports.truncated) {
      container.appendChild(msg('up-notice rp-notice', 'This report only covers the first ' +
        Format.formatCount(reports.fetched_count) + ' matching expenses (there may be more).'));
    }

    if (!hasData) {
      container.appendChild(msg('ov-empty', 'No expenses for this period.'));
      return;
    }

    var totalCard = renderKpis([
      { label: 'Total spend', value: Format.formatMoney(reports.total) },
      { label: 'Expenses', value: Format.formatCount(reports.count) },
      { label: 'Periods', value: Format.formatCount(rows.length) },
    ]);
    container.appendChild(totalCard);
    container.appendChild(renderChart(rows));
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

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var rootEl = el('div', 'rp-root');
    section.appendChild(rootEl);

    // --- toolbar: period buttons + optional from/to date inputs ---
    var toolbar = el('div', 'rp-toolbar');

    var periodGroup = el('div', 'rp-period-group');
    var periodButtons = {};
    PERIODS.forEach(function (p) {
      var btn = el('button', 'rp-period-btn');
      btn.type = 'button';
      Escape.setText(btn, p.charAt(0).toUpperCase() + p.slice(1));
      btn.addEventListener('click', function () {
        if (state.period === p) return;
        state.period = p;
        setActivePeriod(p);
        fetchAndRender();
      });
      periodGroup.appendChild(btn);
      periodButtons[p] = btn;
    });
    toolbar.appendChild(periodGroup);

    // --- Year selector (bug fix): scopes day/week/month to one year so the chart
    // shows that year's periods, not every year's mixed together. Hidden for the
    // 'year' period (which compares across years). Populated from real data on load. ---
    var yearGroup = el('div', 'rp-year-group');
    var yearLabel = el('label', 'rp-range-label');
    yearLabel.setAttribute('for', 'rp-year-select');
    Escape.setText(yearLabel, 'Year');
    var yearSelect = el('select', 'rp-year-select');
    yearSelect.id = 'rp-year-select';
    yearGroup.appendChild(yearLabel);
    yearGroup.appendChild(yearSelect);
    toolbar.appendChild(yearGroup);

    var rangeGroup = el('div', 'rp-range-group');

    var fromLabel = el('label', 'rp-range-label');
    fromLabel.setAttribute('for', 'rp-from-input');
    Escape.setText(fromLabel, 'From');
    var fromInput = el('input', 'rp-date-input');
    fromInput.type = 'date';
    fromInput.id = 'rp-from-input';
    rangeGroup.appendChild(fromLabel);
    rangeGroup.appendChild(fromInput);

    var toLabel = el('label', 'rp-range-label');
    toLabel.setAttribute('for', 'rp-to-input');
    Escape.setText(toLabel, 'To');
    var toInput = el('input', 'rp-date-input');
    toInput.type = 'date';
    toInput.id = 'rp-to-input';
    rangeGroup.appendChild(toLabel);
    rangeGroup.appendChild(toInput);

    toolbar.appendChild(rangeGroup);

    var exportBtn = el('button', 'rp-export-btn');
    exportBtn.type = 'button';
    Escape.setText(exportBtn, 'Export to Excel');
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

    var state = { loaded: false, loading: false, period: 'month', year: String(new Date().getFullYear()), yearsLoaded: false };
    setActivePeriod(state.period);

    // The Year selector is meaningful for the sub-year granularities; hidden for 'year'
    // (which is the cross-year comparison view) — mirrors buildReportsQuery's scoping rule.
    function updateYearVisibility() {
      yearGroup.style.display = (state.period === 'year') ? 'none' : '';
    }
    updateYearVisibility();

    function populateYearSelect(years) {
      clear(yearSelect);
      var list = (years && years.length) ? years : [String(new Date().getFullYear())];
      list.forEach(function (y) {
        var opt = el('option'); opt.value = y; Escape.setText(opt, y); yearSelect.appendChild(opt);
      });
    }

    // Discover which years the account actually has data in (one period=year query),
    // populate the selector, and default to the current year (or the latest present).
    // Runs once; subsequent calls invoke the callback immediately.
    function ensureYearsLoaded(cb) {
      if (state.yearsLoaded || !apiFetch) { cb(); return; }
      apiFetch('/api/reports?period=year').then(function (report) {
        state.yearsLoaded = true;
        var years = yearsFromReport(report);
        populateYearSelect(years);
        state.year = pickDefaultYear(years, new Date().getFullYear());
        yearSelect.value = state.year;
        cb();
      }).catch(function () {
        state.yearsLoaded = true;                 // don't wedge the screen on a discovery failure
        populateYearSelect([state.year]);
        yearSelect.value = state.year;
        cb();
      });
    }

    function currentQuery() {
      return buildReportsQuery(state.period, fromInput.value, toInput.value, state.year);
    }

    function fetchAndRender() {
      if (!apiFetch) return;
      state.loading = true;
      clear(body);
      body.appendChild(msg('ov-loading muted', 'Loading report…'));
      ensureYearsLoaded(function () {
        updateYearVisibility();
        var q = currentQuery();
        var params = [];
        Object.keys(q).forEach(function (k) { params.push(k + '=' + encodeURIComponent(q[k])); });
        var path = '/api/reports' + (params.length ? '?' + params.join('&') : '');
        apiFetch(path).then(function (reports) {
          state.loading = false;
          state.loaded = true;
          renderInto(body, reports);
        }).catch(function () {
          state.loading = false;
          clear(body);
          body.appendChild(msg('ov-error', 'Could not load your report. Please try again shortly.'));
        });
      });
    }

    yearSelect.addEventListener('change', function () {
      state.year = yearSelect.value;
      fetchAndRender();
    });
    fromInput.addEventListener('change', fetchAndRender);
    toInput.addEventListener('change', fetchAndRender);

    var exportBusy = false;
    exportBtn.addEventListener('click', function () {
      if (exportBusy) return;
      exportBusy = true;
      exportBtn.disabled = true;
      Escape.setText(exportStatus, 'Preparing your export…');
      exportExcel(currentQuery()).then(function () {
        exportBusy = false;
        exportBtn.disabled = false;
        Escape.setText(exportStatus, 'Export downloaded.');
      }).catch(function (err) {
        exportBusy = false;
        exportBtn.disabled = false;
        var status = err && typeof err === 'object' ? err.status : 0;
        Escape.setText(exportStatus, exportErrorMessage(status));
      });
    });

    // Lazy-load on first view (mirrors overview.js's load-on-first-show pattern).
    function load() {
      if (state.loading || state.loaded || !apiFetch) return;
      fetchAndRender();
    }

    return { el: rootEl, load: load, renderInto: function (r) { renderInto(body, r); } };
  }

  return {
    // pure
    chartModel: chartModel,
    categoryBreakdown: categoryBreakdown,
    buildReportsQuery: buildReportsQuery,
    yearRange: yearRange,
    yearsFromReport: yearsFromReport,
    pickDefaultYear: pickDefaultYear,
    excelFilename: excelFilename,
    exportErrorMessage: exportErrorMessage,
    // render (browser)
    mount: mount,
    renderInto: renderInto,
  };
});
