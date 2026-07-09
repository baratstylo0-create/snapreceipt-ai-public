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
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE_SIZE = 25;

  // The v1 editable columns, in display order. Mirrors sanitizeExpensePatch's allow-list
  // (minus status/subtotal/tax/currency — not cell-edit material) so a valid cell edit can
  // never be rejected server-side for the field itself.
  var EDITABLE = ['expense_date', 'merchant', 'category', 'amount', 'remark'];
  var LABELS = { expense_date: 'Date', merchant: 'Merchant', category: 'Category', amount: 'Amount', remark: 'Remark' };

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

  // rowsToCSV(rows) -> a full CSV string (header + one row per expense), EDITABLE fields
  // only, in display order — the same shape a spreadsheet user would expect to reopen.
  function rowsToCSV(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var header = EDITABLE.map(function (f) { return escapeCSVValue(LABELS[f]); }).join(',');
    var lines = list.map(function (row) {
      return EDITABLE.map(function (f) { return escapeCSVValue(row && row[f]); }).join(',');
    });
    return [header].concat(lines).join('\r\n');
  }

  // blankTemplateCSV() -> just the header row — for a clerk who wants to prep data offline
  // in the exact column shape this view accepts.
  function blankTemplateCSV() {
    return EDITABLE.map(function (f) { return escapeCSVValue(LABELS[f]); }).join(',');
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

  function mount(section, deps) {
    if (typeof document === 'undefined' || !section) return null;
    var Api = deps.Api, Escape = deps.Escape;
    var categories = (deps.config && deps.config.categories) || [];

    var state = { rows: [], loaded: false, editMode: false, search: '', page: 1 };

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

    var exportBtn = el('button', 'ledger-btn ledger-btn--ghost');
    Escape.setText(exportBtn, 'Export CSV');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () {
      var filtered = filterRows(state.rows, state.search);
      downloadText(rowsToCSV(filtered), 'ledger-export.csv');
    });
    toolbar.appendChild(exportBtn);

    var templateBtn = el('button', 'ledger-btn ledger-btn--ghost');
    Escape.setText(templateBtn, 'Export template');
    templateBtn.type = 'button';
    templateBtn.addEventListener('click', function () {
      downloadText(blankTemplateCSV(), 'ledger-template.csv');
    });
    toolbar.appendChild(templateBtn);
    wrap.appendChild(toolbar);

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
        categories.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c;
          o.textContent = c;
          input.appendChild(o);
        });
        input.value = String(row.category || '');
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
      var filtered = filterRows(state.rows, state.search);
      var view = paginate(filtered, state.page, PAGE_SIZE);
      renderPager(view);

      if (!state.rows.length) {
        note(state.loaded ? 'No expenses yet.' : 'Loading…');
        return;
      }
      if (!filtered.length) {
        note('No rows match "' + state.search + '".');
        return;
      }
      note(state.editMode ? 'Click a cell to edit. Enter saves, Esc cancels.' : 'Read-only — tap "Edit cells" to make changes.');

      var table = document.createElement('table');
      table.className = 'ledger-table';
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
      return Api.apiFetch('/api/expenses').then(function (rows) {
        state.rows = Array.isArray(rows) ? rows : [];
        state.loaded = true;
        render();
      }).catch(function () { note('Could not load expenses. Please try again shortly.'); });
    }

    render();
    return { load: load };
  }

  return {
    // pure
    mount: mount, buildCellPatch: buildCellPatch, EDITABLE: EDITABLE,
    filterRows: filterRows, paginate: paginate, escapeCSVValue: escapeCSVValue,
    rowsToCSV: rowsToCSV, blankTemplateCSV: blankTemplateCSV,
  };
});
