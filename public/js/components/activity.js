// components/activity.js — the Activity screen: the expense table + detail
// drawer + review queue. THIS IS THE PRIMARY STORED-XSS SURFACE: it renders
// untrusted OCR/AI data (merchant, line-item text, ai_raw, anomaly reason,
// remark) that came from hostile receipt images. Iron rule: every value put in
// the DOM goes through Escape.setText / Escape.safeText; we NEVER assign
// innerHTML from data. Cells are built with createElement + textContent.
//
// TWO layers, kept apart so the logic is unit-testable without a DOM:
//   1. PURE helpers — filterSortPage / badgesFor / categoryColor / patchBody.
//      No DOM, no network, no escaping (render owns escaping), never throw on
//      junk. Covered by tests/frontend/activity.test.js.
//   2. RENDER layer (mount + render*) — real DOM via createElement + textContent
//      + Escape.setText. No-ops outside a browser. Loading/empty/error states
//      live here.
//
// UMD shim: window.Activity in the browser; require()-able in Node (render layer
// simply isn't exercised there — no document).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../format'), require('../api'));
  } else {
    root.Activity = factory(root.Escape, root.Format, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api) {
  'use strict';

  // Editable fields the PATCH endpoint accepts (mirror routes/expenses.js `allow`).
  // account_id is DELIBERATELY absent — the server scopes it; the client must
  // never send it.
  var EDITABLE = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark'];
  var KNOWN_CATEGORIES = ['Food', 'Petrol', 'Software', 'Inventory', 'Others'];
  var DEFAULT_PAGE_SIZE = 20;

  // ---- pure helpers -------------------------------------------------------

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  // Category name -> a stable, lowercase class suffix. Case-insensitive; unknown
  // categories (incl. null) bucket into "others". Used by render to pick a pill
  // colour class (.act-pill--food etc). Never returns markup.
  function categoryColor(name) {
    var key = str(name).trim().toLowerCase();
    var known = { food: 'food', petrol: 'petrol', software: 'software', inventory: 'inventory', others: 'others' };
    return known[key] || 'others';
  }

  // Row -> list of badge descriptors (raw data; render escapes). Kinds:
  //   { kind:'anomaly', reason }              — needs-review anomaly
  //   { kind:'low-confidence' }               — some field flagged "low"
  //   { kind:'converted', original, amountOriginal, fxRate } — FX-converted
  function badgesFor(rowObj) {
    if (!rowObj || typeof rowObj !== 'object') return [];
    var out = [];

    var a = rowObj.anomaly;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      // Flagged when flagged===true OR a reason is present without an explicit false.
      var flagged = a.flagged === true || (a.flagged !== false && a.reason != null && a.reason !== '');
      if (flagged) out.push({ kind: 'anomaly', reason: str(a.reason) });
    }

    var c = rowObj.confidence;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      var low = Object.keys(c).some(function (k) { return str(c[k]).toLowerCase() === 'low'; });
      if (low) out.push({ kind: 'low-confidence' });
    }

    if (rowObj.amount_original != null || rowObj.fx_rate != null) {
      out.push({
        kind: 'converted',
        original: str(rowObj.currency_original),
        amountOriginal: rowObj.amount_original != null ? toNum(rowObj.amount_original) : null,
        fxRate: rowObj.fx_rate != null ? toNum(rowObj.fx_rate) : null,
      });
    }
    return out;
  }

  // The searchable haystack for a row (merchant + remark + category + date).
  function haystack(r) {
    return [r && r.merchant, r && r.remark, r && r.category, r && r.expense_date]
      .map(str).join(' ').toLowerCase();
  }

  // expense_date is free-text (OCR-sourced); only treat it as a comparable ISO-ish
  // date (YYYY-MM-DD prefix) for range filtering. Anything else (garbage, empty,
  // null) is "not a date we can range-compare" and is excluded from range filters
  // rather than crashing or being wrongly included.
  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
  function isoDatePrefix(v) {
    var s = str(v).trim();
    return ISO_DATE_RE.test(s) ? s.slice(0, 10) : null;
  }

  // Filter (search + status + category + date range) -> sort (date|amount, asc|desc)
  // -> page. Pure: returns { rows, total, page, pageCount, pageSize }. Never throws.
  function filterSortPage(rows, opts) {
    opts = opts || {};
    var list = Array.isArray(rows) ? rows.slice() : [];

    // filter: search
    var search = str(opts.search).trim().toLowerCase();
    if (search) list = list.filter(function (r) { return haystack(r).indexOf(search) !== -1; });

    // filter: status
    var fs = str(opts.filterStatus).trim();
    if (fs && fs.toLowerCase() !== 'all') list = list.filter(function (r) { return str(r && r.status) === fs; });

    // filter: category
    var fc = str(opts.filterCategory).trim();
    if (fc && fc.toLowerCase() !== 'all') list = list.filter(function (r) { return str(r && r.category) === fc; });

    // filter: date range (inclusive). expense_date is TEXT; ISO (YYYY-MM-DD) strings
    // sort/compare correctly lexically, so plain string comparison is fine. Rows whose
    // expense_date isn't a recognisable ISO-ish date are excluded once a range is active
    // (never included by accident, never thrown on).
    var dateFrom = isoDatePrefix(opts.dateFrom);
    var dateTo = isoDatePrefix(opts.dateTo);
    if (dateFrom || dateTo) {
      list = list.filter(function (r) {
        var d = isoDatePrefix(r && r.expense_date);
        if (d === null) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      });
    }

    // sort
    var sortBy = str(opts.sortBy);
    var dir = str(opts.sortDir).toLowerCase() === 'asc' ? 1 : -1;
    if (sortBy === 'amount') {
      list.sort(function (a, b) { return (toNum(a && a.amount) - toNum(b && b.amount)) * dir; });
    } else if (sortBy === 'date') {
      list.sort(function (a, b) {
        var da = str(a && a.expense_date), db = str(b && b.expense_date);
        return (da < db ? -1 : da > db ? 1 : 0) * dir;
      });
    }

    var total = list.length;
    var pageSize = toNum(opts.pageSize) > 0 ? Math.floor(toNum(opts.pageSize)) : DEFAULT_PAGE_SIZE;
    var pageCount = Math.max(1, Math.ceil(total / pageSize));
    var page = Math.floor(toNum(opts.page)) || 1;
    if (page < 1) page = 1;
    if (page > pageCount) page = pageCount;
    var start = (page - 1) * pageSize;

    return { rows: list.slice(start, start + pageSize), total: total, page: page, pageCount: pageCount, pageSize: pageSize };
  }

  // Diff original vs edited over EDITABLE fields only -> the minimal PATCH body.
  // account_id and any non-editable/unknown field are excluded by construction,
  // so the client can never send account_id (server scopes it).
  function patchBody(original, edited) {
    var o = original && typeof original === 'object' ? original : {};
    var e = edited && typeof edited === 'object' ? edited : {};
    var body = {};
    EDITABLE.forEach(function (k) {
      if (!(k in e)) return;
      // amount is numeric; compare loosely so "10" === 10 is not a false change.
      var changed = (k === 'amount' || k === 'subtotal' || k === 'tax')
        ? toNum(e[k]) !== toNum(o[k])
        : str(e[k]) !== str(o[k]);
      if (changed) body[k] = e[k];
    });
    return body;
  }

  // Pure URL builder for the receipt-image proxy (P6 hardening). Kept separate from the
  // render code so it's unit-testable without a DOM. fileId is untrusted (came from OCR/
  // Telegram) so it's always encodeURIComponent'd — never string-concatenated raw into a URL.
  function receiptPath(fileId) {
    return '/receipt/' + encodeURIComponent(str(fileId));
  }

  var VIEW_MODE_KEY = 'activityViewMode';
  var VIEW_MODES = { table: 'table', cards: 'cards' };

  // Normalise a raw sessionStorage value (or any input) to a known view mode.
  // Unset/null/undefined, anything not exactly 'table' or 'cards', and non-string
  // garbage all fall back to the default ('table' — today's unchanged behavior).
  // Pure, never throws.
  function normaliseViewMode(raw) {
    // hasOwnProperty guard (review finding B#1): a plain `VIEW_MODES[raw]` truthy-check
    // returns an inherited Object.prototype member for keys like 'constructor'/'toString',
    // so a corrupt stored value could resolve to a Function instead of falling back.
    return (raw === 'table' || raw === 'cards') ? raw : 'table';
  }

  // ---- DOM helpers (browser only) ----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function msg(className, text) { var p = el('p', className); Escape.setText(p, text); return p; }

  function textCell(tag, className, value) {
    var n = el(tag, className);
    Escape.setText(n, value);   // untrusted -> textContent (never markup)
    return n;
  }

  function pill(category) {
    var span = el('span', 'act-pill act-pill--' + categoryColor(category));
    Escape.setText(span, str(category) || 'Others');
    return span;
  }

  // Build the small badge chips for a row (anomaly / low-confidence / converted).
  function badgeChips(rowObj) {
    var wrap = el('span', 'act-badges');
    badgesFor(rowObj).forEach(function (b) {
      var chip = el('span', 'act-badge act-badge--' + b.kind);
      if (b.kind === 'anomaly') {
        Escape.setText(chip, 'review');
        if (b.reason) { chip.setAttribute('title', Escape.stripControls(b.reason)); } // title is text, not HTML
      } else if (b.kind === 'low-confidence') {
        Escape.setText(chip, 'low conf');
      } else if (b.kind === 'converted') {
        Escape.setText(chip, 'fx');
        var parts = [];
        if (b.amountOriginal != null) parts.push(Format.formatMoney(b.amountOriginal) + ' ' + (b.original || ''));
        if (b.fxRate != null) parts.push('@ ' + b.fxRate);
        if (parts.length) chip.setAttribute('title', Escape.stripControls(parts.join(' ')));
      }
      wrap.appendChild(chip);
    });
    return wrap;
  }

  // Auth'd receipt-image fetch, shared by the drawer's full-size render and the
  // card view's thumbnail (P6 hardening): /receipt/:fileId requires checkDash, so a
  // plain <img src="/receipt/...">  or <a href> can't carry the bearer token and
  // would 401. Fetch the bytes via Api.fetchBlob (attaches the same Authorization
  // header as every other API call), turn them into a browser-generated blob:
  // object URL, and set it on a real <img> via .src — never innerHTML, never a URL
  // built from unescaped data. imgWrap starts with a loading message and is
  // replaced in place once the fetch resolves/rejects. className/alt let the
  // caller size the thumbnail vs. the full drawer image differently via CSS.
  function loadReceiptImage(fileId, imgWrap, opts) {
    opts = opts || {};
    var imgClassName = opts.imgClassName || 'act-receipt-image';
    var alt = opts.alt || 'Receipt image';
    if (!Api || typeof Api.fetchBlob !== 'function') return;
    Api.fetchBlob(receiptPath(fileId)).then(function (blob) {
      var url = URL.createObjectURL(blob);
      clear(imgWrap);
      var img = el('img', imgClassName);
      img.src = url;          // browser-generated object URL, not derived from untrusted data
      img.alt = alt;
      imgWrap.appendChild(img);
    }).catch(function () {
      clear(imgWrap);
      imgWrap.appendChild(msg('act-receipt-msg muted', 'Could not load the receipt image.'));
    });
  }

  // ---- render: expense table ---------------------------------------------

  function buildToolbar(state, onChange) {
    var bar = el('div', 'act-toolbar');

    var search = el('input', 'act-search');
    search.type = 'search';
    search.setAttribute('placeholder', 'Search merchant / remark…');
    search.setAttribute('aria-label', 'Search expenses');
    search.value = state.search || '';
    search.addEventListener('input', function () { onChange({ search: search.value, page: 1 }); });
    bar.appendChild(search);

    var statusSel = el('select', 'act-filter act-filter--status');
    statusSel.setAttribute('aria-label', 'Filter by status');
    ['all', 'saved', 'needs_review', 'approved', 'rejected'].forEach(function (s) {
      var o = el('option'); o.value = s; Escape.setText(o, s === 'all' ? 'All statuses' : s); statusSel.appendChild(o);
    });
    statusSel.value = state.filterStatus || 'all';
    statusSel.addEventListener('change', function () { onChange({ filterStatus: statusSel.value, page: 1 }); });
    bar.appendChild(statusSel);

    var catSel = el('select', 'act-filter act-filter--category');
    catSel.setAttribute('aria-label', 'Filter by category');
    var allOpt = el('option'); allOpt.value = 'all'; Escape.setText(allOpt, 'All categories'); catSel.appendChild(allOpt);
    KNOWN_CATEGORIES.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); catSel.appendChild(o); });
    catSel.value = state.filterCategory || 'all';
    catSel.addEventListener('change', function () { onChange({ filterCategory: catSel.value, page: 1 }); });
    bar.appendChild(catSel);

    // Date range (native <input type="date">, no picker library). expense_date is
    // TEXT (messy OCR dates normalised to ISO-ish in JS), so these feed the pure
    // dateFrom/dateTo range filter in filterSortPage — string comparison, inclusive.
    var fromWrap = el('label', 'act-filter act-filter--date');
    var fromLab = el('span', 'act-filter-date-label'); Escape.setText(fromLab, 'From'); fromWrap.appendChild(fromLab);
    var dateFrom = el('input', 'act-date-from');
    dateFrom.type = 'date';
    dateFrom.setAttribute('aria-label', 'From date');
    dateFrom.value = state.dateFrom || '';
    dateFrom.addEventListener('change', function () { onChange({ dateFrom: dateFrom.value, page: 1 }); });
    fromWrap.appendChild(dateFrom);
    bar.appendChild(fromWrap);

    var toWrap = el('label', 'act-filter act-filter--date');
    var toLab = el('span', 'act-filter-date-label'); Escape.setText(toLab, 'To'); toWrap.appendChild(toLab);
    var dateTo = el('input', 'act-date-to');
    dateTo.type = 'date';
    dateTo.setAttribute('aria-label', 'To date');
    dateTo.value = state.dateTo || '';
    dateTo.addEventListener('change', function () { onChange({ dateTo: dateTo.value, page: 1 }); });
    toWrap.appendChild(dateTo);
    bar.appendChild(toWrap);

    return bar;
  }

  // Table/Cards view toggle — two pill buttons matching the nav/theme pill style
  // (.nav-link/.nav-theme visual language, see app.css). Default is 'table'
  // (today's behavior, unchanged); the active mode is marked with is-active.
  function buildViewToggle(state, onChange) {
    var wrap = el('div', 'act-view-toggle');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Switch between table and card view');

    function modeBtn(mode, label) {
      var btn = el('button', 'act-view-btn' + (state.viewMode === mode ? ' is-active' : ''));
      btn.type = 'button';
      Escape.setText(btn, label);
      btn.addEventListener('click', function () { onChange({ viewMode: mode }); });
      return btn;
    }

    wrap.appendChild(modeBtn('table', 'Table'));
    wrap.appendChild(modeBtn('cards', 'Cards'));
    return wrap;
  }

  function sortableTh(label, key, state, onChange) {
    var th = el('th', 'act-th act-th--sortable');
    var btn = el('button', 'act-sort');
    btn.type = 'button';
    var arrow = state.sortBy === key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    Escape.setText(btn, label + arrow);
    btn.addEventListener('click', function () {
      var dir = (state.sortBy === key && state.sortDir === 'asc') ? 'desc' : 'asc';
      onChange({ sortBy: key, sortDir: dir });
    });
    th.appendChild(btn);
    return th;
  }

  function buildTable(page, state, handlers) {
    var table = el('table', 'act-table');
    var thead = el('thead');
    var htr = el('tr');
    htr.appendChild(textCell('th', 'act-th', 'Merchant'));
    htr.appendChild(sortableTh('Date', 'date', state, handlers.onChange));
    htr.appendChild(sortableTh('Amount', 'amount', state, handlers.onChange));
    htr.appendChild(textCell('th', 'act-th', 'Category'));
    htr.appendChild(textCell('th', 'act-th', 'Status'));
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el('tbody');
    page.rows.forEach(function (r) {
      var tr = el('tr', 'act-row');
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');

      var mCell = el('td', 'act-td act-td--merchant');
      mCell.appendChild(textCell('span', 'act-merchant', r.merchant));
      mCell.appendChild(badgeChips(r));
      tr.appendChild(mCell);

      tr.appendChild(textCell('td', 'act-td', r.expense_date));

      var amt = el('td', 'act-td act-td--amount');
      Escape.setText(amt, Format.formatMoney(r.amount) + ' ' + str(r.currency));
      tr.appendChild(amt);

      var cat = el('td', 'act-td');
      cat.appendChild(pill(r.category));
      tr.appendChild(cat);

      tr.appendChild(textCell('td', 'act-td act-td--status', r.status));

      tr.addEventListener('click', function () { handlers.onOpen(r); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handlers.onOpen(r); }
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Card view: same filtered/sorted/paginated row set as the table, rendered as a
  // grid of cards instead of <tr>s. Reuses badgeChips/pill (same pure badgesFor
  // descriptors as the table row — no duplicated badge logic) and the shared
  // loadReceiptImage auth'd-fetch helper for the thumbnail. Clicking a card opens
  // the same detail drawer as clicking a table row (handlers.onOpen).
  function buildCard(r, handlers) {
    var card = el('div', 'act-card');
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');

    if (r.receipt_file_id) {
      var thumbWrap = el('div', 'act-card-thumb');
      thumbWrap.appendChild(msg('act-receipt-msg muted', 'Loading…'));
      card.appendChild(thumbWrap);
      loadReceiptImage(r.receipt_file_id, thumbWrap, { imgClassName: 'act-card-thumb-image', alt: 'Receipt thumbnail' });
    }

    var body = el('div', 'act-card-body');

    var head = el('div', 'act-card-head');
    head.appendChild(textCell('span', 'act-card-merchant', r.merchant));
    head.appendChild(pill(r.category));
    body.appendChild(head);

    body.appendChild(badgeChips(r));

    var meta = el('div', 'act-card-meta');
    meta.appendChild(textCell('span', 'act-card-date', r.expense_date));
    var amt = el('span', 'act-card-amount');
    Escape.setText(amt, Format.formatMoney(r.amount) + ' ' + str(r.currency));
    meta.appendChild(amt);
    body.appendChild(meta);

    body.appendChild(textCell('span', 'act-card-status act-td--status', r.status));

    if (r.remark) {
      var remark = el('p', 'act-card-remark');
      Escape.setText(remark, r.remark);                          // untrusted -> textContent
      remark.setAttribute('title', Escape.stripControls(str(r.remark))); // full text on hover, text not HTML
      body.appendChild(remark);
    }

    card.appendChild(body);

    card.addEventListener('click', function () { handlers.onOpen(r); });
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handlers.onOpen(r); }
    });
    return card;
  }

  function buildCardGrid(page, handlers) {
    var grid = el('div', 'act-card-grid');
    page.rows.forEach(function (r) { grid.appendChild(buildCard(r, handlers)); });
    return grid;
  }

  function buildPager(page, onChange) {
    var pager = el('div', 'act-pager');
    var prev = el('button', 'act-page-prev'); prev.type = 'button'; Escape.setText(prev, 'Prev');
    prev.disabled = page.page <= 1;
    prev.addEventListener('click', function () { onChange({ page: page.page - 1 }); });

    var info = el('span', 'act-page-info');
    Escape.setText(info, 'Page ' + page.page + ' of ' + page.pageCount + ' · ' + page.total + ' expenses');

    var next = el('button', 'act-page-next'); next.type = 'button'; Escape.setText(next, 'Next');
    next.disabled = page.page >= page.pageCount;
    next.addEventListener('click', function () { onChange({ page: page.page + 1 }); });

    pager.appendChild(prev); pager.appendChild(info); pager.appendChild(next);
    return pager;
  }

  // ---- render: detail drawer ---------------------------------------------

  function buildDrawer(rowObj, handlers) {
    var drawer = el('aside', 'act-drawer');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Expense detail');

    var head = el('div', 'act-drawer-head');
    head.appendChild(textCell('h3', 'act-drawer-title', rowObj.merchant || 'Expense'));
    var close = el('button', 'act-drawer-close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close'); Escape.setText(close, '×');
    close.addEventListener('click', function () { handlers.onClose(); });
    head.appendChild(close);
    drawer.appendChild(head);

    // Editable fields form
    var form = el('form', 'act-edit-form');
    var edited = {};
    EDITABLE.forEach(function (k) { edited[k] = rowObj[k]; });

    function field(key, label, type) {
      var wrap = el('label', 'act-field');
      var lab = el('span', 'act-field-label'); Escape.setText(lab, label); wrap.appendChild(lab);
      var input;
      if (key === 'category') {
        input = el('select', 'act-field-input');
        KNOWN_CATEGORIES.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); input.appendChild(o); });
        input.value = str(rowObj[key]) || 'Others';
      } else {
        input = el('input', 'act-field-input');
        input.type = type || 'text';
        input.value = str(rowObj[key]);
      }
      input.addEventListener('input', function () { edited[key] = input.value; });
      input.addEventListener('change', function () { edited[key] = input.value; });
      wrap.appendChild(input);
      return wrap;
    }

    form.appendChild(field('merchant', 'Merchant'));
    form.appendChild(field('expense_date', 'Date'));
    form.appendChild(field('amount', 'Amount', 'number'));
    form.appendChild(field('currency', 'Currency'));
    form.appendChild(field('category', 'Category'));
    form.appendChild(field('status', 'Status'));
    form.appendChild(field('remark', 'Remark'));

    var actions = el('div', 'act-drawer-actions');
    var save = el('button', 'act-save'); save.type = 'submit'; Escape.setText(save, 'Save changes');
    var del = el('button', 'act-delete'); del.type = 'button'; Escape.setText(del, 'Delete');
    var status = el('p', 'act-drawer-msg muted');
    actions.appendChild(save); actions.appendChild(del);
    form.appendChild(actions); form.appendChild(status);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var body = patchBody(rowObj, edited);   // never contains account_id
      if (!Object.keys(body).length) { Escape.setText(status, 'No changes to save.'); return; }
      Escape.setText(status, 'Saving…');
      handlers.onSave(rowObj, body, status);
    });

    // Two-step delete confirm (no native confirm(): CSP/UX-friendly inline step).
    var confirming = false;
    del.addEventListener('click', function () {
      if (!confirming) {
        confirming = true;
        Escape.setText(del, 'Confirm delete');
        del.classList.add('is-confirming');
        Escape.setText(status, 'Click again to permanently remove this expense.');
        return;
      }
      Escape.setText(status, 'Deleting…');
      handlers.onDelete(rowObj, status);
    });

    drawer.appendChild(form);

    // Line items (each description via setText — hostile OCR text stays inert).
    var items = Array.isArray(rowObj.line_items) ? rowObj.line_items : [];
    if (items.length) {
      var liWrap = el('div', 'act-lineitems');
      liWrap.appendChild(textCell('h4', 'act-lineitems-title', 'Line items'));
      var ul = el('ul', 'act-lineitems-list');
      items.forEach(function (it) {
        var li = el('li', 'act-lineitem');
        var desc = (it && (it.description || it.name)) || '';
        var amount = it && it.amount != null ? Format.formatMoney(it.amount) : '';
        Escape.setText(li, str(desc) + (amount ? '  —  ' + amount : ''));
        ul.appendChild(li);
      });
      liWrap.appendChild(ul);
      drawer.appendChild(liWrap);
    }

    // Receipt image: full-size render via the shared auth'd-fetch helper (see
    // loadReceiptImage above). Fetched eagerly on drawer-open (not per-row in the
    // table) so opening a list of rows doesn't fan out N image requests before the
    // user asks to see any of them.
    var receipt = el('div', 'act-receipt');
    if (rowObj.receipt_file_id) {
      receipt.appendChild(textCell('span', 'act-receipt-label muted', 'Receipt image'));
      var imgWrap = el('div', 'act-receipt-image-wrap');
      var status2 = el('p', 'act-receipt-msg muted');
      Escape.setText(status2, 'Loading receipt image…');
      imgWrap.appendChild(status2);
      receipt.appendChild(imgWrap);
      loadReceiptImage(rowObj.receipt_file_id, imgWrap, { imgClassName: 'act-receipt-image', alt: 'Receipt image' });
    } else {
      receipt.appendChild(textCell('span', 'act-receipt-label muted', 'No receipt image on file'));
    }
    drawer.appendChild(receipt);

    return drawer;
  }

  // ---- render: review queue ----------------------------------------------

  function buildReviewItem(rowObj, handlers) {
    var card = el('div', 'act-review-item');
    card.appendChild(textCell('span', 'act-review-merchant', rowObj.merchant));
    var amt = el('span', 'act-review-amount');
    Escape.setText(amt, Format.formatMoney(rowObj.amount) + ' ' + str(rowObj.currency));
    card.appendChild(amt);

    var reason = (rowObj.anomaly && typeof rowObj.anomaly === 'object' && rowObj.anomaly.reason) || 'Flagged for review';
    card.appendChild(textCell('p', 'act-review-reason', reason));  // untrusted reason -> escaped

    var actions = el('div', 'act-review-actions');
    var approve = el('button', 'act-review-approve'); approve.type = 'button'; Escape.setText(approve, 'Approve');
    var reject = el('button', 'act-review-reject'); reject.type = 'button'; Escape.setText(reject, 'Reject');
    var st = el('span', 'act-review-msg muted');
    approve.addEventListener('click', function () { handlers.onDecide(rowObj, 'approve', card, st); });
    reject.addEventListener('click', function () { handlers.onDecide(rowObj, 'reject', card, st); });
    actions.appendChild(approve); actions.appendChild(reject); actions.appendChild(st);
    card.appendChild(actions);
    return card;
  }

  // ---- mount --------------------------------------------------------------

  // Guarded sessionStorage accessors for the table/cards view preference — same
  // pattern as app.js's theme persistence (try/catch around a possibly-absent or
  // privacy-mode-blocked sessionStorage; never throws).
  function ss(root) {
    try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (e) { return null; }
  }
  function getStoredViewMode(root) {
    var s = ss(root);
    try { return normaliseViewMode(s ? s.getItem(VIEW_MODE_KEY) : null); } catch (e) { return 'table'; }
  }
  function storeViewMode(root, mode) {
    var s = ss(root);
    try { if (s) s.setItem(VIEW_MODE_KEY, normaliseViewMode(mode)); } catch (e) { /* ignore */ }
  }

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);
    var storageRoot = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);

    var rootEl = el('div', 'act-root');
    section.appendChild(rootEl);

    // Sub-mounts: table area, drawer host, review area.
    var tableArea = el('div', 'act-table-area');
    var drawerHost = el('div', 'act-drawer-host');
    var reviewArea = el('div', 'act-review-area');
    rootEl.appendChild(tableArea);
    rootEl.appendChild(drawerHost);
    var reviewHead = textCell('h3', 'act-review-title', 'Review queue');
    rootEl.appendChild(reviewHead);
    rootEl.appendChild(reviewArea);

    var state = {
      loaded: false, loading: false, rows: [],
      search: '', filterStatus: 'all', filterCategory: 'all', dateFrom: '', dateTo: '',
      sortBy: 'date', sortDir: 'desc', page: 1, pageSize: DEFAULT_PAGE_SIZE,
      viewMode: getStoredViewMode(storageRoot),
    };
    var reviewState = { loading: false, loaded: false, rows: [] };

    function renderTable() {
      clear(tableArea);
      if (state.loading) { tableArea.appendChild(msg('act-loading muted', 'Loading expenses…')); return; }
      if (state.error) { tableArea.appendChild(msg('act-error', 'Could not load your expenses. Please try again shortly.')); return; }
      tableArea.appendChild(buildToolbar(state, onChange));
      tableArea.appendChild(buildViewToggle(state, onChange));
      var pageData = filterSortPage(state.rows, state);
      if (pageData.total === 0) {
        tableArea.appendChild(msg('act-empty muted', state.rows.length ? 'No expenses match your filters.' : 'No expenses yet. Send a receipt to your Telegram bot to get started.'));
        return;
      }
      if (state.viewMode === 'cards') {
        tableArea.appendChild(buildCardGrid(pageData, { onOpen: openDrawer }));
      } else {
        tableArea.appendChild(buildTable(pageData, state, { onChange: onChange, onOpen: openDrawer }));
      }
      tableArea.appendChild(buildPager(pageData, onChange));
    }

    function onChange(patch) {
      Object.assign(state, patch);
      if (patch && 'viewMode' in patch) {
        state.viewMode = normaliseViewMode(state.viewMode);
        storeViewMode(storageRoot, state.viewMode);
      }
      renderTable();
    }

    function closeDrawer() { clear(drawerHost); }

    function openDrawer(rowObj) {
      clear(drawerHost);
      drawerHost.appendChild(buildDrawer(rowObj, {
        onClose: closeDrawer,
        onSave: function (orig, body, statusEl) {
          apiFetch('/api/expenses/' + encodeURIComponent(orig.id), { method: 'PATCH', body: body })
            .then(function (updated) {
              // Merge server truth back into our cached row.
              var idx = state.rows.findIndex(function (r) { return r.id === orig.id; });
              if (idx !== -1) state.rows[idx] = Object.assign({}, state.rows[idx], body, updated && typeof updated === 'object' ? updated : {});
              Escape.setText(statusEl, 'Saved.');
              renderTable();
              // Re-open the row we just saved. On a cache miss (idx === -1) re-open `orig`,
              // NOT state.rows[0] — that would swap the drawer to an unrelated expense (B#2).
              openDrawer(idx !== -1 ? state.rows[idx] : orig);
            })
            .catch(function () { Escape.setText(statusEl, 'Save failed. Please try again.'); });
        },
        onDelete: function (orig, statusEl) {
          apiFetch('/api/expenses/' + encodeURIComponent(orig.id), { method: 'DELETE' })
            .then(function () {
              state.rows = state.rows.filter(function (r) { return r.id !== orig.id; });
              closeDrawer();
              renderTable();
            })
            .catch(function () { Escape.setText(statusEl, 'Delete failed. Please try again.'); });
        },
      }));
    }

    function renderReview() {
      clear(reviewArea);
      if (reviewState.loading) { reviewArea.appendChild(msg('act-loading muted', 'Loading review queue…')); return; }
      if (reviewState.error) { reviewArea.appendChild(msg('act-error', 'Could not load the review queue.')); return; }
      if (!reviewState.rows.length) { reviewArea.appendChild(msg('act-empty muted', 'Nothing to review. 🎉')); return; }
      reviewState.rows.forEach(function (r) {
        reviewArea.appendChild(buildReviewItem(r, {
          onDecide: function (rowObj, decision, card, st) {
            Escape.setText(st, decision === 'approve' ? 'Approving…' : 'Rejecting…');
            apiFetch('/api/review/' + encodeURIComponent(rowObj.id), { method: 'POST', body: { decision: decision } })
              .then(function () {
                reviewState.rows = reviewState.rows.filter(function (x) { return x.id !== rowObj.id; });
                // Also reflect the status change in the main table cache.
                var idx = state.rows.findIndex(function (x) { return x.id === rowObj.id; });
                if (idx !== -1) state.rows[idx].status = decision === 'approve' ? 'approved' : 'rejected';
                renderReview(); renderTable();
              })
              .catch(function () { Escape.setText(st, 'Action failed. Please try again.'); });
          },
        }));
      });
    }

    function loadReview() {
      if (reviewState.loading || !apiFetch) return;
      reviewState.loading = true; reviewState.error = false; renderReview();
      apiFetch('/api/review').then(function (rows) {
        reviewState.loading = false; reviewState.loaded = true;
        reviewState.rows = Array.isArray(rows) ? rows : [];
        renderReview();
      }).catch(function () { reviewState.loading = false; reviewState.error = true; renderReview(); });
    }

    function load(force) {
      if ((state.loading || state.loaded) && !force) { return; }
      if (!apiFetch) return;
      state.loading = true; state.error = false; renderTable();
      apiFetch('/api/expenses').then(function (rows) {
        state.loading = false; state.loaded = true;
        state.rows = Array.isArray(rows) ? rows : [];
        renderTable();
      }).catch(function () { state.loading = false; state.error = true; renderTable(); });
      loadReview();
    }

    return { el: rootEl, load: load };
  }

  return {
    // pure
    filterSortPage: filterSortPage,
    badgesFor: badgesFor,
    categoryColor: categoryColor,
    patchBody: patchBody,
    receiptPath: receiptPath,
    normaliseViewMode: normaliseViewMode,
    // render (browser)
    mount: mount,
  };
});
