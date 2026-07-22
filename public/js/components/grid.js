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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../exportGuards'));
  else root.Grid = factory(root.ExportGuards);
})(typeof self !== 'undefined' ? self : this, function (ExportGuards) {
  'use strict';

  var PAGE_SIZE = 25;

  // The v1 editable columns, in display order. Mirrors sanitizeExpensePatch's allow-list
  // (minus status/subtotal/tax/currency — not cell-edit material) so a valid cell edit can
  // never be rejected server-side for the field itself.
  var EDITABLE = ['expense_date', 'merchant', 'category', 'amount', 'remark'];
  var LABELS = { expense_date: 'Date', merchant: 'Merchant', category: 'Category', amount: 'Amount', remark: 'Remark' };
  var EXPORT_COLUMNS = [
    { key: 'expense_date', label: 'Date' },
    { key: 'merchant', label: 'Merchant' },
    { key: 'amount', label: 'Amount' },
    { key: 'currency', label: 'Currency' },
    { key: 'category', label: 'Category' },
    { key: 'branch_id', label: 'Branch' },
    { key: 'staff_user_id', label: 'Staff' },
    { key: 'payment_status', label: 'Status' },
    { key: 'receipt_url', label: 'Receipt URL' },
  ];

  // Export buttons the Data-editor toolbar renders (QA 2026-07-13, Untitled document.md:
  // trimmed to just these two — Export CSV / Export PDF (with receipts) / Export template /
  // Statement Excel were removed to de-clutter). The `format` is deliberately unchanged
  // ('xlsx' for the managed export, 'pdf' for the statement) so the produced files are
  // byte-for-byte identical to before — only the button set shrinks. These are the single
  // source of truth the toolbar builds from (grid.test.js locks the set).
  function managedExportButtons() { return [{ label: 'Export Excel', format: 'xlsx' }]; }
  function statementExportButtons() { return [{ label: 'Statement PDF', format: 'pdf' }]; }

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
      if (s === '' || !isFinite(n)) return { ok: false, error: 'Amount must be a number.' };
      value = n;
    } else if (field === 'expense_date') {
      var d = String(rawValue == null ? '' : rawValue).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'Date must be YYYY-MM-DD.' };
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
    var header = EXPORT_COLUMNS.map(function (c) { return escapeCSVValue(c.label); }).join(',');
    var lines = list.map(function (row) {
      return EXPORT_COLUMNS.map(function (c) { return escapeCSVValue(exportValue(row, c.key)); }).join(',');
    });
    return [header].concat(lines).join('\r\n');
  }

  // blankTemplateCSV() -> just the header row — for a clerk who wants to prep data offline
  // in the exact column shape this view accepts.
  function blankTemplateCSV() {
    return EDITABLE.map(function (f) { return escapeCSVValue(LABELS[f]); }).join(',');
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
    var out = [{ value: 'all', label: 'All branches' }];
    var own = session.branch_id ? String(session.branch_id) : '';
    if (own) out.push({ value: own, label: 'My uploads' });
    var seen = {};
    if (own) seen[own] = true;
    var ids = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var id = row && row.branch_id ? String(row.branch_id) : '';
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    ids.sort().forEach(function (id) { out.push({ value: id, label: 'Branch ' + id }); });
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
      return { id: row.id == null ? '' : String(row.id), branch_id: id, period: String(row.period || ''), label: names[id] || id || 'Unassigned branch' };
    });
  }

  // ---- DOM helpers (browser only) -----------------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

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
    var submissionOn = !!(deps.config && deps.config.branch_submission);

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
    var badge = textEl('span', 'ledger-badge', 'Read-only');
    toolbar.appendChild(badge);

    var editBtn = el('button', 'ledger-btn ledger-btn--primary');
    editBtn.type = 'button';
    Escape.setText(editBtn, 'Edit cells');
    editBtn.addEventListener('click', function () {
      state.editMode = !state.editMode;
      render();
    });
    toolbar.appendChild(editBtn);

    // The export buttons this toolbar keeps (managed + statement). setExportBusy() disables
    // whatever ends up here, so it can never reference a button that no longer exists.
    var exportButtonEls = [];
    managedExportButtons().forEach(function (cfg) {
      var b = el('button', 'ledger-btn ledger-btn--ghost');
      b.type = 'button';
      Escape.setText(b, cfg.label);
      b.addEventListener('click', function () { doManagedExport(cfg.format); });
      toolbar.appendChild(b);
      exportButtonEls.push(b);
    });
    wrap.appendChild(toolbar);

    var statementTools = el('div', 'ledger-statement-tools');
    statementTools.appendChild(textEl('span', 'ledger-statement-label', 'Petty Cash Statement'));
    var statementMonth = el('input', 'ledger-statement-month');
    statementMonth.type = 'month';
    statementMonth.setAttribute('aria-label', 'Statement month');
    var now = new Date();
    statementMonth.value = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
    statementTools.appendChild(statementMonth);

    var statementBranch = null;
    if (session && session.role === 'admin') {
      statementBranch = el('select', 'ledger-statement-branch');
      statementBranch.setAttribute('aria-label', 'Statement branch');
      statementTools.appendChild(statementBranch);
    }

    statementExportButtons().forEach(function (cfg) {
      var b = el('button', 'ledger-btn ledger-btn--ghost');
      b.type = 'button';
      Escape.setText(b, cfg.label);
      b.addEventListener('click', function () { doStatementExport(cfg.format); });
      statementTools.appendChild(b);
      exportButtonEls.push(b);
    });
    wrap.appendChild(statementTools);

    // -- Submit-signal (C5): move a month-ready signal into the Data editor --
    // The legacy Payments implementation remains intact behind its feature flag;
    // this is the new home after the Payments page is hidden.
    var submissionWrap = null, submissionMsg = null, submissionBtn = null, withdrawBtn = null, readyList = null;
    if (submissionOn && (isClerk || isAdmin)) {
      submissionWrap = el('div', 'ledger-submission');
      var submissionHeading = textEl('span', 'ledger-submission-label', isClerk ? 'Month ready' : 'Ready to close');
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
        Escape.setText(withdrawBtn, 'Withdraw');
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
    searchInput.placeholder = 'Search merchant, category, remark…';
    searchInput.setAttribute('aria-label', 'Search the ledger');
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
        note('Choose a statement month first.');
        return;
      }
      var branch = statementBranch ? statementBranch.value : '';
      setExportBusy(true);
      note('Preparing statement ' + String(format).toUpperCase() + '...');
      Api.fetchBlob(statementExportUrl({ period: period, format: format, branch: branch })).then(function (blob) {
        downloadBlob(blob, statementFilename(format));
        note('Statement ' + String(format).toUpperCase() + ' downloaded.');
      }).catch(function () {
        note('Statement export failed. Please try again.');
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
      Escape.setText(submissionMsg, rows.length ? rows.length + ' branch' + (rows.length === 1 ? '' : 'es') + ' submitted.' : 'No branches submitted yet.');
      if (!rows.length) return;
      rows.forEach(function (row) {
        var item = el('div', 'ledger-ready-item');
        var label = textEl('span', 'ledger-ready-branch', row.label + ' (' + row.period + ')');
        item.appendChild(label);
        ['xlsx', 'pdf'].forEach(function (format) {
          var button = el('button', 'ledger-btn ledger-btn--ghost');
          button.type = 'button';
          Escape.setText(button, format === 'xlsx' ? 'Export Excel' : 'Export PDF');
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
          Escape.setText(submissionMsg, status === 'submitted' ? 'Submitted for ' + period + '.'
            : status === 'withdrawn' ? 'Withdrawn for ' + period + '.' : 'Not submitted for ' + period + '.');
          if (submissionBtn) {
            Escape.setText(submissionBtn, status === 'submitted' ? 'Re-submit month ready' : 'Submit month ready');
            submissionBtn.disabled = false;
          }
          if (withdrawBtn) withdrawBtn.hidden = status !== 'submitted';
        } else if (isAdmin) {
          renderReadyList(period);
        }
      }).catch(function () {
        Escape.setText(submissionMsg, 'Could not load submission status.');
      });
    }

    function submitMonth() {
      if (!submissionBtn || !Api || typeof Api.apiFetch !== 'function') return;
      var period = statementMonth.value || submissionPeriod();
      submissionBtn.disabled = true;
      Escape.setText(submissionMsg, 'Submitting…');
      Api.apiFetch('/api/submissions', { method: 'POST', body: { period: period } })
        .then(function () { refreshSubmissionSignal(); })
        .catch(function (err) {
          submissionBtn.disabled = false;
          Escape.setText(submissionMsg, err && err.status === 403 ? 'Only a branch clerk can submit.' : 'Submit failed. Please try again.');
        });
    }

    function withdrawMonth() {
      if (!withdrawBtn || !state.submission || !Api || typeof Api.apiFetch !== 'function') return;
      withdrawBtn.disabled = true;
      Api.apiFetch('/api/submissions/' + encodeURIComponent(state.submission.id), { method: 'PATCH', body: { status: 'withdrawn' } })
        .then(function () { withdrawBtn.disabled = false; refreshSubmissionSignal(); })
        .catch(function () { withdrawBtn.disabled = false; Escape.setText(submissionMsg, 'Withdraw failed. Please try again.'); });
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
          note('Preparing ' + String(format).toUpperCase() + ' export...');
          Api.fetchBlob('/api/manage-export?format=' + encodeURIComponent(format), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids }),
          }).then(function (blob) {
            downloadBlob(blob, 'ledger-export.' + (format === 'xlsx' ? 'xlsx' : format));
            note(String(format).toUpperCase() + ' downloaded.');
          }).catch(function () {
            note('Export failed. Please try again.');
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
      note('Saving…');
      Api.apiFetch('/api/expenses/' + encodeURIComponent(row.id), { method: 'PATCH', body: built.patch })
        .then(function (fresh) {
          // Server echoes the updated row (incl. the trigger-bumped updated_at) — keep it
          // so the NEXT edit of this row carries the right guard.
          if (fresh && fresh.id) {
            for (var k in fresh) row[k] = fresh[k];
          } else {
            row[field] = built.patch[field];
          }
          note('Click a cell to edit. Enter saves, Esc cancels.');
          renderCell(td, row, field);
        })
        .catch(function (err) {
          if (err && err.status === 409) {
            note('That row changed elsewhere — refreshed with the latest values.');
            load();
          } else if (err && err.status === 403) {
            note('You can only edit your own branch\'s expenses.');
            renderCell(td, row, field);
          } else {
            note('Save failed. Please try again.');
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
          legacy.textContent = current + ' (not in category list)';
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
      pager.appendChild(textEl('span', 'ledger-pager-info', 'Showing ' + start + '-' + end + ' of ' + view.total));

      var nav = el('div', 'ledger-pager-nav');
      var prev = el('button', 'ledger-pager-btn');
      Escape.setText(prev, '‹');
      prev.type = 'button';
      prev.disabled = view.page <= 1;
      prev.setAttribute('aria-label', 'Previous page');
      prev.addEventListener('click', function () { state.page = view.page - 1; render(); });
      nav.appendChild(prev);

      nav.appendChild(textEl('span', 'ledger-pager-page', view.page + ' / ' + view.totalPages));

      var next = el('button', 'ledger-pager-btn');
      Escape.setText(next, '›');
      next.type = 'button';
      next.disabled = view.page >= view.totalPages;
      next.setAttribute('aria-label', 'Next page');
      next.addEventListener('click', function () { state.page = view.page + 1; render(); });
      nav.appendChild(next);
      pager.appendChild(nav);
    }

    function render() {
      Escape.setText(badge, state.editMode ? 'Editing enabled' : 'Read-only');
      badge.classList.toggle('ledger-badge--edit', state.editMode);
      Escape.setText(editBtn, state.editMode ? 'Done editing' : 'Edit cells');

      host.textContent = '';
      var byPeriod = filterByPeriod(state.rows, statementMonth.value);
      var filtered = filterRows(byPeriod, state.search);
      var view = paginate(filtered, state.page, PAGE_SIZE);
      renderPager(view);

      if (!state.rows.length) {
        note(state.loaded ? 'No expenses yet.' : 'Loading…');
        return;
      }
      if (!filtered.length) {
        note(state.search ? 'No rows match "' + state.search + '".' : 'No expenses for ' + statementMonth.value + '.');
        return;
      }
      note(state.editMode ? 'Click a cell to edit. Enter saves, Esc cancels.' : 'Read-only — tap "Edit cells" to make changes.');

      var table = document.createElement('table');
      table.className = ledgerTableClass(state.editMode);
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      EDITABLE.forEach(function (f) {
        var th = document.createElement('th');
        th.textContent = LABELS[f];
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
      }).catch(function () { note('Could not load expenses. Please try again shortly.'); });
    }

    render();
    return { load: load };
  }

  return {
    // pure
    mount: mount, buildCellPatch: buildCellPatch, EDITABLE: EDITABLE,
    filterRows: filterRows, filterByPeriod: filterByPeriod, paginate: paginate, escapeCSVValue: escapeCSVValue,
    rowsToCSV: rowsToCSV, blankTemplateCSV: blankTemplateCSV, receiptLink: receiptLink,
    statementExportUrl: statementExportUrl, statementBranchOptions: statementBranchOptions, statementFilename: statementFilename,
    managedExportButtons: managedExportButtons, statementExportButtons: statementExportButtons, ledgerTableClass: ledgerTableClass,
    submissionPeriod: submissionPeriod, submissionState: submissionState, readyToCloseRows: readyToCloseRows,
  };
});
