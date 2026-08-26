// components/grid.js — the excel-lite "Ledger" grid (ADR-021 Phase 6, redesigned).
//
// Business mode only. A table over /api/expenses, READ-ONLY BY DEFAULT with an explicit
// "Edit cells" toggle (Owner-provided design reference: a CSV editor with a read-only/edit
// mode split, search, pagination, safe CSV export, and a blank-template export). Adapted to
// OUR architecture rather than copied: the reference makes every cell an <input> at once in
// edit mode with a plain onChange — fine for a client-only CSV, wrong here where every edit
// is a live server PATCH. We keep the existing click-one-cell / Enter-saves / Esc-cancels
// mechanic (validated, optimistic-concurrency-guarded) and simply gate it behind the toggle:
// read-only mode = inert text cells; edit mode = the same safe per-cell editor as before.
//
// VALUES ONLY: no column add/remove/rename (v1 scope, per the plan). Payment fields are
// deliberately not editable here (that's the Payments view / admin-only endpoint). The
// server enforces clerk branch isolation on both the list and the write.
//
// Conventions: pure DOM (createElement/textContent), UMD shim, pure helpers node-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../exportGuards'), require('../i18n'));
  else root.Grid = factory(root.ExportGuards, root.I18n);
})(typeof self !== 'undefined' ? self : this, function (ExportGuards, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var tp = (I18n && I18n.tp) || function (k) { return k; };

  var PAGE_SIZE = 25;

  // The v1 editable columns, in display order. Mirrors sanitizeExpensePatch's allow-list
  // (minus status/subtotal/tax/currency — not cell-edit material) so a valid cell edit can
  // never be rejected server-side for the field itself.
  var EDITABLE = ['expense_date', 'merchant', 'category', 'amount', 'remark'];
  function labels() {
    return { expense_date: t('grid.col_date'), merchant: t('grid.col_merchant'), category: t('grid.col_category'), amount: t('grid.col_amount'), remark: t('grid.col_remark') };
  }
  function exportColumns() {
    return [
      { key: 'expense_date', label: t('grid.col_date') },
      { key: 'merchant', label: t('grid.col_merchant') },
      { key: 'amount', label: t('grid.col_amount') },
      { key: 'currency', label: t('grid.col_currency') },
      { key: 'category', label: t('grid.col_category') },
      { key: 'branch_id', label: t('grid.col_branch') },
      { key: 'staff_user_id', label: t('grid.col_staff') },
      { key: 'payment_status', label: t('grid.col_status') },
      { key: 'receipt_url', label: t('grid.col_receipt_url') },
    ];
  }

  // Export buttons the Data-editor toolbar renders (QA 2026-07-13, Untitled document.md:
  // trimmed to just these two — Export CSV / Export PDF (with receipts) / Export template /
  // Statement Excel were removed to de-clutter). The `format` is deliberately unchanged
  // ('xlsx' for the managed export, 'pdf' for the statement) so the produced files are
  // byte-for-byte identical to before — only the button set shrinks. These are the single
  // source of truth the toolbar builds from (grid.test.js locks the set).
  function managedExportButtons() { return [{ label: t('grid.export_excel'), format: 'xlsx' }]; }
  function statementExportButtons() { return [{ label: t('grid.statement_pdf'), format: 'pdf' }]; }

  // Edit-mode hook class for the ledger table — CSS greens the editable columns while on.
  function ledgerTableClass(editMode) { return 'ledger-table' + (editMode ? ' is-editing' : ''); }

  // ---- pure logic (node-tested) ------------------------------------------------

  // buildCellPatch(row, field, rawValue) -> { ok:true, patch } | { ok:false, error?, noop? }.
  // Client-side mirror of the server rules (fail fast): amount must be a finite number,
  // expense_date must be YYYY-MM-DD, text is trimmed. An unchanged value is a no-op (no
  // PATCH fired). expected_updated_at rides along whenever the row has one, so a stale
  // edit 409s server-side instead of silently overwriting a newer change.
  function buildCellPatch(row, field, rawValue) {
    if (!row || EDITABLE.indexOf(field) === -1) return { ok: false, error: 'not editable' };
    var value;
    if (field === 'amount') {
      var s = String(rawValue == null ? '' : rawValue).trim();
      var n = Number(s);
      if (s === '' || !isFinite(n)) return { ok: false, error: t('grid.amount_must_be_number') };
      value = n;
    } else if (field === 'expense_date') {
      var d = String(rawValue == null ? '' : rawValue).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: t('grid.date_must_be_iso') };
      value = d;
    } else {
      value = String(rawValue == null ? '' : rawValue).trim();
    }
    var current = row[field];
    var same = field === 'amount' ? Number(current) === value : String(current == null ? '' : current) === value;
    if (same) return { ok: false, noop: true };
    var patch = {};
    patch[field] = value;
    if (row.updated_at) patch.expected_updated_at = String(row.updated_at);
    return { ok: true, patch: patch };
  }

  // filterRows(rows, term) -> rows whose EDITABLE field values contain `term`
  // (case-insensitive substring, matches ANY field). Empty/whitespace term -> all rows.
  // Garbage input never throws.
  function filterRows(rows, term) {
    var list = Array.isArray(rows) ? rows : [];
    var q = String(term || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (row) {
      if (!row) return false;
      return EDITABLE.some(function (f) {
        var v = row[f];
        return v != null && String(v).toLowerCase().indexOf(q) !== -1;
      });
    });
  }

  // filterByPeriod(rows, period) -> rows whose expense_date falls in the given "YYYY-MM"
  // period (matches the Statement month picker, reused as the table's own month filter —
  // 2026-07-22 fix: the picker used to only drive the Statement PDF/submission, so the table
  // below it showed every year regardless of what month was selected, which read as broken).
  // An empty/invalid period (or a row with no/garbage expense_date) never throws; invalid
  // period -> every row unchanged, matching filterRows' own "empty term = no filter" contract.
  function filterByPeriod(rows, period) {
    var list = Array.isArray(rows) ? rows : [];
    var p = String(period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(p)) return list;
    return list.filter(function (row) {
      return !!(row && typeof row.expense_date === 'string' && row.expense_date.slice(0, 7) === p);
    });
  }

  var FULL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // periodLabel("2026-08") -> "August, 2026" — the human-readable label for the Month
  // filter that's actually driving this export (2026-08-19, Barat: the exported XLSX
  // title used to show a single receipt's own date instead of the filter the user
  // actually picked, e.g. "2026-08-09" instead of "August, 2026" when every visible
  // receipt happened to share one date). Invalid/empty period -> '' (caller falls back
  // to the server's own default). Pure, never throws.
  function periodLabel(period) {
    var p = String(period || '').trim();
    var m = /^(\d{4})-(\d{2})$/.exec(p);
    if (!m) return '';
    var idx = Number(m[2]) - 1;
    if (idx < 0 || idx > 11) return '';
    return FULL_MONTH_NAMES[idx] + ', ' + m[1];
  }

  // paginate(rows, page, pageSize) -> { pageRows, page, totalPages, total }. page is
  // clamped into [1, totalPages] (a stale page number after a filter shrinks the set
  // never produces an out-of-range slice). Empty input -> page 1 of 1, zero rows.
  function paginate(rows, page, pageSize) {
    var list = Array.isArray(rows) ? rows : [];
    var size = Number(pageSize) > 0 ? Number(pageSize) : PAGE_SIZE;
    var totalPages = Math.max(1, Math.ceil(list.length / size));
    var p = Math.min(Math.max(1, Number(page) || 1), totalPages);
    var start = (p - 1) * size;
    return { pageRows: list.slice(start, start + size), page: p, totalPages: totalPages, total: list.length };
  }

  // escapeCSVValue(value) -> a single CSV-safe field. Two protections, matching the Owner's
  // reference implementation: (1) formula-injection guard — a field starting with = + - @
  // opens as a live formula in Excel/Sheets if the CSV is ever reopened there, so it's
  // prefixed with a literal quote to force text; (2) standard CSV quoting when the value
  // contains a comma, quote, or newline (doubled internal quotes, per RFC 4180).
  function escapeCSVValue(value) {
    var raw = value == null ? '' : String(value);
    var safe = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
    if (/[",\n\r]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
    return safe;
  }

  function receiptLink(row) {
    if (!row || !row.id || (!row.receipt_url && !row.receipt_file_id)) return '';
    // ADR-027: `/api/receipt/*` (not legacy `/receipt/*`) so the image rides the `/api/*`
    // → :3005 nginx catch-all the co-tenant app never claims — collision-proof. See DECISIONS.
    return '/api/receipt/by-id/' + encodeURIComponent(row.id);
  }

  function exportValue(row, key) {
    if (!row) return '';
    if (key === 'receipt_url') return receiptLink(row);
    return row[key];
  }

  // rowsToCSV(rows) -> a full CSV string (header + one row per expense), EDITABLE fields
  // only, in display order — the same shape a spreadsheet user would expect to reopen.
  function rowsToCSV(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var cols = exportColumns();
    var header = cols.map(function (c) { return escapeCSVValue(c.label); }).join(',');
    var lines = list.map(function (row) {
      return cols.map(function (c) { return escapeCSVValue(exportValue(row, c.key)); }).join(',');
    });
    return [header].concat(lines).join('\r\n');
  }

  // blankTemplateCSV() -> just the header row — for a clerk who wants to prep data offline
  // in the exact column shape this view accepts.
  function blankTemplateCSV() {
    var lbl = labels();
    return EDITABLE.map(function (f) { return escapeCSVValue(lbl[f]); }).join(',');
  }

  function statementExportUrl(opts) {
    opts = opts || {};
    var period = String(opts.period || '').trim();
    var format = String(opts.format || '').trim().toLowerCase();
    var url = '/api/statement?period=' + encodeURIComponent(period) + '&format=' + encodeURIComponent(format);
    var branch = opts.branch == null ? '' : String(opts.branch).trim();
    if (branch) url += '&branch=' + encodeURIComponent(branch);
    return url;
  }

  function statementFilename(format) {
    return String(format).toLowerCase() === 'xlsx' ? 'petty-cash-statement.xlsx' : 'Expense_Report.pdf';
  }

  function statementBranchOptions(rows, session) {
    if (!session || session.role !== 'admin') return [];
    var out = [{ value: 'all', label: t('grid.branch_all') }];
    var own = session.branch_id ? String(session.branch_id) : '';
    if (own) out.push({ value: own, label: t('grid.branch_mine') });
    var seen = {};
    if (own) seen[own] = true;
    var ids = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var id = row && row.branch_id ? String(row.branch_id) : '';
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    ids.sort().forEach(function (id) { out.push({ value: id, label: tp('grid.branch_named', id) }); });
    return out;
  }

  function submissionPeriod(now) {
    var d = now instanceof Date ? new Date(now.getTime()) : new Date(typeof now === 'number' ? now : Date.now());
    if (!Number.isFinite(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function submissionState(submission) {
    var status = submission && String(submission.status || '').toLowerCase();
    return status === 'submitted' || status === 'withdrawn' ? status : 'not_submitted';
  }

  function readyToCloseRows(submissions, branchNames, period) {
    var names = branchNames && typeof branchNames === 'object' ? branchNames : {};
    var target = period ? String(period) : '';
    return (Array.isArray(submissions) ? submissions : []).filter(function (row) {
      return row && submissionState(row) === 'submitted' && (!target || String(row.period || '') === target);
    }).map(function (row) {
      var id = row.branch_id == null ? '' : String(row.branch_id);
      return { id: row.id == null ? '' : String(row.id), branch_id: id, period: String(row.period || ''), label: names[id] || id || t('grid.unassigned_branch') };
    });
  }

  // ---- DOM helpers (browser only) -----------------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // Toolbar icons (2026-08-26, Owner reference screenshot: lock/pencil/file glyphs
  // beside the read-only badge and Edit/Export buttons). Personal-only — see
  // withIcons below — so the business (Premala) toolbar keeps its original
  // text-only badge/buttons byte-for-byte. Pure createElementNS, same discipline
  // as nav.js's icon helpers: no innerHTML, so the strict no-inline CSP holds.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]); }
    return e;
  }
  // stroke="currentColor" by default (icon inherits the button/badge's own text
  // color — white on the filled "Edit cells" button, muted gray on the badge —
  // for free, no extra color CSS needed). Pass a fixed `stroke`/`fill` override
  // for the two brand-tinted export icons below.
  function buildIcon(children, opts) {
    opts = opts || {};
    var svg = svgEl('svg', {
      viewBox: '0 0 24 24', width: '15', height: '15', fill: opts.fill || 'none',
      stroke: opts.stroke || 'currentColor', 'stroke-width': opts.strokeWidth || '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    svg.setAttribute('class', 'ledger-btn-icon');
    children.forEach(function (c) { svg.appendChild(c); });
    return svg;
  }
  function buildLockIcon() {
    return buildIcon([
      svgEl('rect', { x: '5', y: '10.5', width: '14', height: '9.5', rx: '1.8' }),
      svgEl('path', { d: 'M7.8 10.5V7.5a4.2 4.2 0 0 1 8.4 0v3' }),
    ]);
  }
  function buildEditIcon() {
    return buildIcon([
      svgEl('path', { d: 'M12 20h8' }),
      svgEl('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' }),
    ]);
  }
  // Generic colored document glyphs (not a reproduction of the Excel/Adobe
  // logomark — a plain page + folded corner, tinted green/red, which is the
  // common convention for "spreadsheet"/"PDF" export affordances without
  // claiming an official brand mark).
  function buildDocIcon(color, innerChildren) {
    return buildIcon([
      svgEl('path', { d: 'M6 3h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }),
      svgEl('path', { d: 'M13 3v5h5' }),
    ].concat(innerChildren || []), { stroke: color });
  }
  function buildExcelIcon() {
    return buildDocIcon('#1e8e4f', [
      svgEl('line', { x1: '8', y1: '14', x2: '16', y2: '14' }),
      svgEl('line', { x1: '8', y1: '17.5', x2: '16', y2: '17.5' }),
      svgEl('line', { x1: '11.3', y1: '11.5', x2: '11.3', y2: '20.5' }),
    ]);
  }
  function buildPdfIcon() {
    return buildDocIcon('#d92d20', [
      svgEl('line', { x1: '8', y1: '14', x2: '15', y2: '14' }),
      svgEl('line', { x1: '8', y1: '17.5', x2: '13', y2: '17.5' }),
    ]);
  }
  // Prepend an icon inside an existing button/badge without disturbing its
  // current text — wraps the existing text in a span so CSS can gap the two,
  // then inserts the icon before it. No-op (returns false) if the element
  // already has an icon (idempotent re-render safety, e.g. editBtn's label
  // changes on every toggle — see render() below).
  function addIcon(elNode, iconEl) {
    if (!elNode || elNode.querySelector('.ledger-btn-icon')) return false;
    var label = el('span', 'ledger-btn-label');
    label.textContent = elNode.textContent;
    clear(elNode);
    elNode.appendChild(iconEl);
    elNode.appendChild(label);
    return true;
  }

  // Trigger a browser download of `text` as `filename` via a throwaway Blob URL.
  // No-ops outside a browser; never throws (a download failing is not worth breaking the view for).
  function downloadText(text, filename, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { /* best-effort — a failed export never breaks the view */ }
  }

  function downloadBlob(blob, filename) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { /* best-effort */ }
  }

  function mount(section, deps) {
    if (typeof document === 'undefined' || !section) return null;
    var Api = deps.Api, Escape = deps.Escape;
    var categories = (deps.config && deps.config.categories) || [];
    // Owner follow-up (2026-07-10): the export-reminder popup's "Review" button navigates to
    // Activity — same shared switcher Upload's "View in Activity" button already uses.
    var switchView = typeof deps.switchView === 'function' ? deps.switchView : null;
    var session = deps.session || null;
    var isClerk = !!(session && session.role === 'clerk');
    var isAdmin = !!(session && session.role === 'admin');
    // 2026-07-25: personal-mode signup means `session` alone no longer implies "business" —
    // an 'owner' session is a personal account. isBusinessSession is the one true signal for
    // "show business-only chrome" (Petty Cash Statement export, branch dropdown); every spot
    // below that used to test bare `session` truthiness for that purpose now uses this instead.
    var isBusinessSession = !!(session && session.role !== 'owner');
    var submissionOn = !!(deps.config && deps.config.branch_submission);
    // Toolbar icons (2026-08-26, Owner reference screenshot) are personal-only —
    // business (Premala) keeps its exact current text-only toolbar, no icon markup.
    var withIcons = !isBusinessSession;

    var state = { rows: [], loaded: false, editMode: false, search: '', page: 1, submission: null, submissions: [], branchNames: {} };

    var wrap = document.createElement('div');
    wrap.className = 'ledger';
    section.appendChild(wrap);

    function textEl(tag, className, text) {
      var n = el(tag, className);
      Escape.setText(n, text);
      return n;
    }

    // -- toolbar: mode badge + Edit toggle + exports --
    var toolbar = el('div', 'ledger-toolbar');
    var badge = textEl('span', 'ledger-badge', t('grid.read_only'));
    if (withIcons) addIcon(badge, buildLockIcon());
    toolbar.appendChild(badge);

    var editBtn = el('button', 'ledger-btn ledger-btn--primary');
    editBtn.type = 'button';
    Escape.setText(editBtn, t('grid.edit_cells'));
    if (withIcons) addIcon(editBtn, buildEditIcon());
    editBtn.addEventListener('click', function () {
      state.editMode = !state.editMode;
      render();
    });
    toolbar.appendChild(editBtn);

    // The export buttons this toolbar keeps (managed + statement). setExportBusy() disables
    // whatever ends up here, so it can never reference a button that no longer exists.
    var exportButtonEls = [];
    var exportButtons = managedExportButtons().slice();
    // Personal-only addition (2026-07-25, Barat request): a PDF export using the SAME
    // /api/manage-export endpoint as "Export Excel" (checkDash only, no session/scope
    // required — already works for personal accounts today), just format:'pdf'. This is
    // NOT the business "Statement PDF" button (routes/statement.js, petty-cash floats,
    // 404s without multiUser+pettyCash) — it's the generic summary+receipt-evidence PDF
    // that used to also be on business's toolbar before a 2026-07-13 de-clutter pass
    // removed it there. Business's own button set (managedExportButtons()) is untouched,
    // so grid.test.js's pinned business export set still holds exactly as before.
    if (!isBusinessSession) exportButtons.push({ label: t('grid.export_pdf'), format: 'pdf' });
    exportButtons.forEach(function (cfg) {
      var b = el('button', 'ledger-btn ledger-btn--ghost');
      b.type = 'button';
      Escape.setText(b, cfg.label);
      b.title = cfg.label;
      if (withIcons) addIcon(b, cfg.format === 'pdf' ? buildPdfIcon() : buildExcelIcon());
      b.addEventListener('click', function () { doManagedExport(cfg.format); });
      toolbar.appendChild(b);
      exportButtonEls.push(b);
    });
    wrap.appendChild(toolbar);

    // statementMonth doubles as the table's own month filter (see currentFilteredIds/
    // filterByPeriod below), so it stays for personal too. The Petty Cash Statement label,
    // export button, and branch dropdown are business-only — the server's own /api/statement
    // route 403s without req.scope (no session), so hiding them for personal isn't just
    // cosmetic, it avoids offering a control that would just fail.
    var statementTools = el('div', 'ledger-statement-tools');
    statementTools.appendChild(textEl('span', 'ledger-statement-label', isBusinessSession ? t('grid.petty_cash_statement') : t('grid.month')));
    var statementMonth = el('input', 'ledger-statement-month');
    statementMonth.type = 'month';
    statementMonth.setAttribute('aria-label', isBusinessSession ? t('grid.statement_month_aria') : t('grid.filter_by_month_aria'));
    var now = new Date();
    statementMonth.value = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
    statementTools.appendChild(statementMonth);

    var statementBranch = null;
    if (session && session.role === 'admin') {
      statementBranch = el('select', 'ledger-statement-branch');
      statementBranch.setAttribute('aria-label', t('grid.statement_branch_aria'));
      statementTools.appendChild(statementBranch);
    }

    if (isBusinessSession) {
      statementExportButtons().forEach(function (cfg) {
        var b = el('button', 'ledger-btn ledger-btn--ghost');
        b.type = 'button';
        Escape.setText(b, cfg.label);
        b.addEventListener('click', function () { doStatementExport(cfg.format); });
        statementTools.appendChild(b);
        exportButtonEls.push(b);
      });
    }
    wrap.appendChild(statementTools);

    // -- Submit-signal (C5): move a month-ready signal into the Data editor --
    // The legacy Payments implementation remains intact behind its feature flag;
    // this is the new home after the Payments page is hidden.
    var submissionWrap = null, submissionMsg = null, submissionBtn = null, withdrawBtn = null, readyList = null;
    if (submissionOn && (isClerk || isAdmin)) {
      submissionWrap = el('div', 'ledger-submission');
      var submissionHeading = textEl('span', 'ledger-submission-label', isClerk ? t('grid.month_ready') : t('grid.ready_to_close'));
      submissionWrap.appendChild(submissionHeading);
      submissionMsg = el('span', 'ledger-submission-msg muted');
      submissionWrap.appendChild(submissionMsg);
      if (isClerk) {
        submissionBtn = el('button', 'ledger-btn ledger-btn--ghost');
        submissionBtn.type = 'button';
        submissionBtn.addEventListener('click', submitMonth);
        submissionWrap.appendChild(submissionBtn);
        withdrawBtn = el('button', 'ledger-btn ledger-btn--ghost');
        withdrawBtn.type = 'button';
        Escape.setText(withdrawBtn, t('grid.withdraw'));
        withdrawBtn.hidden = true;
        withdrawBtn.addEventListener('click', withdrawMonth);
        submissionWrap.appendChild(withdrawBtn);
      } else if (isAdmin) {
        readyList = el('div', 'ledger-ready-list');
        submissionWrap.appendChild(readyList);
      }
      wrap.appendChild(submissionWrap);
    }
    statementMonth.addEventListener('change', function () {
      state.page = 1; // a narrower/different month can shrink the set; never leave page stranded
      render();
      refreshSubmissionSignal();
    });

    // -- search --
    var searchRow = el('div', 'ledger-search-row');
    var searchInput = el('input', 'ledger-search');
    searchInput.type = 'search';
    searchInput.placeholder = t('grid.search_placeholder');
    searchInput.setAttribute('aria-label', t('grid.search_aria'));
    searchInput.addEventListener('input', function () {
      state.search = searchInput.value;
      state.page = 1;
      render();
    });
    searchRow.appendChild(searchInput);
    wrap.appendChild(searchRow);

    var msg = el('p', 'ledger-msg muted');
    wrap.appendChild(msg);

    var host = el('div', 'ledger-host');
    wrap.appendChild(host);

    var pager = el('div', 'ledger-pager');
    wrap.appendChild(pager);

    function note(text) { Escape.setText(msg, text || ''); }

    function currentFilteredIds() {
      return filterRows(filterByPeriod(state.rows, statementMonth.value), state.search)
        .map(function (r) { return r && r.id ? String(r.id) : ''; })
        .filter(Boolean);
    }

    function setExportBusy(busy) {
      exportButtonEls.forEach(function (b) { b.disabled = !!busy; });
    }

    function refreshStatementBranches() {
      if (!statementBranch) return;
      var previous = statementBranch.value;
      clear(statementBranch);
      statementBranchOptions(state.rows, session).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt.value;
        Escape.setText(o, opt.label);
        statementBranch.appendChild(o);
      });
      if (previous) statementBranch.value = previous;
      if (!statementBranch.value && statementBranch.options.length) statementBranch.value = statementBranch.options[0].value;
    }

    function doStatementExport(format) {
      var period = statementMonth.value;
      if (!/^\d{4}-\d{2}$/.test(period)) {
        note(t('grid.choose_statement_month'));
        return;
      }
      var branch = statementBranch ? statementBranch.value : '';
      setExportBusy(true);
      note(tp('grid.preparing_statement', String(format).toUpperCase()));
      Api.fetchBlob(statementExportUrl({ period: period, format: format, branch: branch })).then(function (blob) {
        downloadBlob(blob, statementFilename(format));
        note(tp('grid.statement_downloaded', String(format).toUpperCase()));
      }).catch(function () {
        note(t('grid.statement_export_failed'));
      }).then(function () {
        setExportBusy(false);
      });
    }

    function selectStatementBranch(branchId, period) {
      if (period) statementMonth.value = String(period);
      if (!statementBranch) return;
      refreshStatementBranches();
      var wanted = branchId == null ? '' : String(branchId);
      var found = false;
      for (var i = 0; i < statementBranch.options.length; i++) {
        if (statementBranch.options[i].value === wanted) { found = true; break; }
      }
      if (!found && wanted) {
        var option = document.createElement('option');
        option.value = wanted;
        Escape.setText(option, state.branchNames[wanted] || wanted);
        statementBranch.appendChild(option);
      }
      if (wanted) statementBranch.value = wanted;
    }

    function renderReadyList(period) {
      if (!readyList) return;
      clear(readyList);
      var rows = readyToCloseRows(state.submissions, state.branchNames, period);
      Escape.setText(submissionMsg, rows.length ? tp('grid.branches_submitted', rows.length) : t('grid.no_branches_submitted'));
      if (!rows.length) return;
      rows.forEach(function (row) {
        var item = el('div', 'ledger-ready-item');
        var label = textEl('span', 'ledger-ready-branch', row.label + ' (' + row.period + ')');
        item.appendChild(label);
        ['xlsx', 'pdf'].forEach(function (format) {
          var button = el('button', 'ledger-btn ledger-btn--ghost');
          button.type = 'button';
          Escape.setText(button, format === 'xlsx' ? t('grid.export_excel') : t('grid.export_pdf'));
          button.addEventListener('click', function () {
            selectStatementBranch(row.branch_id, row.period);
            doStatementExport(format);
          });
          item.appendChild(button);
        });
        readyList.appendChild(item);
      });
    }

    function refreshSubmissionSignal() {
      if (!submissionOn || !submissionWrap || !Api || typeof Api.apiFetch !== 'function') return;
      var period = statementMonth.value || submissionPeriod();
      if (!/^\d{4}-\d{2}$/.test(period)) return;
      Api.apiFetch('/api/submissions?period=' + encodeURIComponent(period)).then(function (payload) {
        state.submissions = payload && Array.isArray(payload.submissions) ? payload.submissions : [];
        state.submission = state.submissions[0] || null;
        if (isClerk) {
          var status = submissionState(state.submission);
          Escape.setText(submissionMsg, status === 'submitted' ? tp('grid.submitted_for', period)
            : status === 'withdrawn' ? tp('grid.withdrawn_for', period) : tp('grid.not_submitted_for', period));
          if (submissionBtn) {
            Escape.setText(submissionBtn, status === 'submitted' ? t('grid.resubmit_month_ready') : t('grid.submit_month_ready'));
            submissionBtn.disabled = false;
          }
          if (withdrawBtn) withdrawBtn.hidden = status !== 'submitted';
        } else if (isAdmin) {
          renderReadyList(period);
        }
      }).catch(function () {
        Escape.setText(submissionMsg, t('grid.could_not_load_submission'));
      });
    }

    function submitMonth() {
      if (!submissionBtn || !Api || typeof Api.apiFetch !== 'function') return;
      var period = statementMonth.value || submissionPeriod();
      submissionBtn.disabled = true;
      Escape.setText(submissionMsg, t('grid.submitting'));
      Api.apiFetch('/api/submissions', { method: 'POST', body: { period: period } })
        .then(function () { refreshSubmissionSignal(); })
        .catch(function (err) {
          submissionBtn.disabled = false;
          Escape.setText(submissionMsg, err && err.status === 403 ? t('grid.only_clerk_can_submit') : t('grid.submit_failed'));
        });
    }

    function withdrawMonth() {
      if (!withdrawBtn || !state.submission || !Api || typeof Api.apiFetch !== 'function') return;
      withdrawBtn.disabled = true;
      Api.apiFetch('/api/submissions/' + encodeURIComponent(state.submission.id), { method: 'PATCH', body: { status: 'withdrawn' } })
        .then(function () { withdrawBtn.disabled = false; refreshSubmissionSignal(); })
        .catch(function () { withdrawBtn.disabled = false; Escape.setText(submissionMsg, t('grid.withdraw_failed')); });
    }

    function loadBranchDirectory() {
      if (!submissionOn || !isAdmin || !Api || typeof Api.apiFetch !== 'function') return;
      Api.apiFetch('/api/branches').then(function (payload) {
        var branches = payload && Array.isArray(payload.branches) ? payload.branches : [];
        branches.forEach(function (branch) {
          if (branch && branch.id != null) state.branchNames[String(branch.id)] = branch.office || String(branch.id);
        });
        if (statementBranch) refreshStatementBranches();
        renderReadyList(statementMonth.value);
      }).catch(function () { /* raw branch IDs remain safe fallbacks */ });
    }

    function doManagedExport(format) {
      var ids = currentFilteredIds();
      // A3 (Owner 2026-07-10): remind only when receipts still await review; otherwise export
      // straight through. runExportGuard keeps the empty-data guard + counts the scoped queue.
      ExportGuards.runExportGuard({
        data: ids,
        apiFetch: Api.apiFetch,
        onEmpty: function (m) { note(m); },
        onReview: switchView ? function () { switchView('activity'); } : undefined,
        onProceed: function () {
          setExportBusy(true);
          note(tp('grid.preparing_export', String(format).toUpperCase()));
          // period_label (2026-08-19): tells the server which filter is actually driving
          // this export ("August, 2026") so the XLSX title reflects the user's Month
          // picker instead of guessing from the exported rows' own dates — see
          // periodLabel's own doc comment above for the bug this fixes.
          Api.fetchBlob('/api/manage-export?format=' + encodeURIComponent(format), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids, period_label: periodLabel(statementMonth.value) }),
          }).then(function (blob) {
            downloadBlob(blob, 'ledger-export.' + (format === 'xlsx' ? 'xlsx' : format));
            note(tp('grid.export_downloaded', String(format).toUpperCase()));
          }).catch(function () {
            note(t('grid.export_failed'));
          }).then(function () {
            setExportBusy(false);
          });
        },
      });
    }

    // Save one cell. On 409 (someone else edited the row) we re-fetch everything —
    // simplest correct v1: the user re-applies their change on fresh data.
    function saveCell(row, field, rawValue, td) {
      var built = buildCellPatch(row, field, rawValue);
      if (!built.ok) {
        if (!built.noop) note(built.error);
        renderCell(td, row, field); // restore display either way
        return;
      }
      note(t('grid.saving'));
      Api.apiFetch('/api/expenses/' + encodeURIComponent(row.id), { method: 'PATCH', body: built.patch })
        .then(function (fresh) {
          // Server echoes the updated row (incl. the trigger-bumped updated_at) — keep it
          // so the NEXT edit of this row carries the right guard.
          if (fresh && fresh.id) {
            for (var k in fresh) row[k] = fresh[k];
          } else {
            row[field] = built.patch[field];
          }
          note(t('grid.click_cell_hint'));
          renderCell(td, row, field);
        })
        .catch(function (err) {
          if (err && err.status === 409) {
            note(t('grid.row_changed_elsewhere'));
            load();
          } else if (err && err.status === 403) {
            note(t('grid.own_branch_only'));
            renderCell(td, row, field);
          } else {
            note(t('grid.save_failed'));
            renderCell(td, row, field);
          }
        });
    }

    function renderCell(td, row, field) {
      td.textContent = '';
      var v = row[field];
      td.textContent = v == null ? '' : String(v);
      td.classList.remove('is-editing');
    }

    function beginEdit(td, row, field) {
      if (td.classList.contains('is-editing')) return;
      td.classList.add('is-editing');
      td.textContent = '';
      var input;
      if (field === 'category' && categories.length) {
        input = document.createElement('select');
        var current = String(row.category || '');
        // Owner-reported bug (2026-07-09) + independent-review finding #6: if the row's stored
        // category isn't in the account's current list (renamed/removed since this receipt was
        // categorized), a plain <select> has no matching <option> — setting .value to it then
        // silently resolves to '' (no option selected). Clicking the cell and clicking away
        // WITHOUT deliberately picking anything then committed that '' on blur, erasing the
        // classification. Fix: always inject the row's current value as a real option first (even
        // if it's not in the account list), so .value always matches something and blur-without-
        // choosing preserves it instead of blanking it.
        if (current && categories.indexOf(current) === -1) {
          var legacy = document.createElement('option');
          legacy.value = current;
          legacy.textContent = tp('grid.not_in_category_list', current);
          input.appendChild(legacy);
        }
        categories.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c;
          o.textContent = c;
          input.appendChild(o);
        });
        input.value = current;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = row[field] == null ? '' : String(row[field]);
      }
      input.className = 'ledger-cell-input';
      var done = false;
      function commit() { if (done) return; done = true; saveCell(row, field, input.value, td); }
      function cancel() { if (done) return; done = true; renderCell(td, row, field); }
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);
      td.appendChild(input);
      input.focus();
      if (input.select) input.select();
    }

    function renderPager(view) {
      clear(pager);
      if (view.total === 0) return;
      var start = (view.page - 1) * PAGE_SIZE + 1;
      var end = Math.min(view.page * PAGE_SIZE, view.total);
      pager.appendChild(textEl('span', 'ledger-pager-info', tp('grid.pager_showing', start, end, view.total)));

      var nav = el('div', 'ledger-pager-nav');
      var prev = el('button', 'ledger-pager-btn');
      Escape.setText(prev, '‹');
      prev.type = 'button';
      prev.disabled = view.page <= 1;
      prev.setAttribute('aria-label', t('grid.previous_page'));
      prev.addEventListener('click', function () { state.page = view.page - 1; render(); });
      nav.appendChild(prev);

      nav.appendChild(textEl('span', 'ledger-pager-page', view.page + ' / ' + view.totalPages));

      var next = el('button', 'ledger-pager-btn');
      Escape.setText(next, '›');
      next.type = 'button';
      next.disabled = view.page >= view.totalPages;
      next.setAttribute('aria-label', t('grid.next_page'));
      next.addEventListener('click', function () { state.page = view.page + 1; render(); });
      nav.appendChild(next);
      pager.appendChild(nav);
    }

    function render() {
      Escape.setText(badge, state.editMode ? t('grid.editing_enabled') : t('grid.read_only'));
      badge.classList.toggle('ledger-badge--edit', state.editMode);
      Escape.setText(editBtn, state.editMode ? t('grid.done_editing') : t('grid.edit_cells'));
      // Escape.setText replaces textContent wholesale, wiping any icon addIcon()
      // inserted above — reapply on every render (addIcon no-ops once it's there,
      // but setText just erased it, so this always re-adds fresh).
      if (withIcons) { addIcon(badge, buildLockIcon()); addIcon(editBtn, buildEditIcon()); }

      host.textContent = '';
      var byPeriod = filterByPeriod(state.rows, statementMonth.value);
      var filtered = filterRows(byPeriod, state.search);
      var view = paginate(filtered, state.page, PAGE_SIZE);
      renderPager(view);

      if (!state.rows.length) {
        note(state.loaded ? t('grid.no_expenses_yet') : t('grid.loading_ellipsis'));
        return;
      }
      if (!filtered.length) {
        note(state.search ? tp('grid.no_rows_match', state.search) : tp('grid.no_expenses_for_month', statementMonth.value));
        return;
      }
      note(state.editMode ? t('grid.click_cell_hint') : t('grid.read_only_hint'));

      var table = document.createElement('table');
      table.className = ledgerTableClass(state.editMode);
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      var lbl = labels();
      EDITABLE.forEach(function (f) {
        var th = document.createElement('th');
        th.textContent = lbl[f];
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      view.pageRows.forEach(function (row) {
        var tr = document.createElement('tr');
        EDITABLE.forEach(function (field) {
          var td = document.createElement('td');
          td.className = 'ledger-cell' + (state.editMode ? ' is-editable' : '');
          td.setAttribute('data-field', field);
          renderCell(td, row, field);
          if (state.editMode) td.addEventListener('click', function () { beginEdit(td, row, field); });
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      host.appendChild(table);
    }

    function load() {
      loadBranchDirectory();
      return Api.apiFetch('/api/expenses').then(function (rows) {
        state.rows = Array.isArray(rows) ? rows : [];
        state.loaded = true;
        refreshStatementBranches();
        render();
        refreshSubmissionSignal();
      }).catch(function () { note(t('grid.load_expenses_failed')); });
    }

    render();
    return { load: load };
  }

  return {
    // pure
    mount: mount, buildCellPatch: buildCellPatch, EDITABLE: EDITABLE,
    filterRows: filterRows, filterByPeriod: filterByPeriod, periodLabel: periodLabel, paginate: paginate, escapeCSVValue: escapeCSVValue,
    rowsToCSV: rowsToCSV, blankTemplateCSV: blankTemplateCSV, receiptLink: receiptLink,
    statementExportUrl: statementExportUrl, statementBranchOptions: statementBranchOptions, statementFilename: statementFilename,
    managedExportButtons: managedExportButtons, statementExportButtons: statementExportButtons, ledgerTableClass: ledgerTableClass,
    submissionPeriod: submissionPeriod, submissionState: submissionState, readyToCloseRows: readyToCloseRows,
  };
});
