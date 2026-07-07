// components/grid.js — the excel-lite "Ledger" grid (ADR-021 Phase 6).
//
// Business mode only. An editable table over /api/expenses: click a cell, type, Enter/blur
// saves via a per-field PATCH that carries expected_updated_at — a concurrent edit elsewhere
// gets a 409 and this view re-fetches instead of clobbering (the Phase-4 optimistic-
// concurrency guard). VALUES ONLY: no column add/remove/rename (v1 scope, per the plan);
// payment fields are deliberately not editable here (that's the Payments view / admin-only
// endpoint). The server enforces clerk branch isolation on both the list and the write.
//
// Conventions: pure DOM (createElement/textContent), UMD shim, buildCellPatch node-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The v1 editable columns, in display order. Mirrors sanitizeExpensePatch's allow-list
  // (minus status/subtotal/tax/currency — not cell-edit material) so a valid cell edit can
  // never be rejected server-side for the field itself.
  var EDITABLE = ['expense_date', 'merchant', 'category', 'amount', 'remark'];
  var LABELS = { expense_date: 'Date', merchant: 'Merchant', category: 'Category', amount: 'Amount', remark: 'Remark' };

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

  // ---- view -------------------------------------------------------------------

  function mount(section, deps) {
    if (typeof document === 'undefined' || !section) return null;
    var Api = deps.Api, Escape = deps.Escape;
    var categories = (deps.config && deps.config.categories) || [];

    var state = { rows: [], loaded: false };

    var wrap = document.createElement('div');
    wrap.className = 'ledger';
    section.appendChild(wrap);

    var msg = document.createElement('p');
    msg.className = 'ledger-msg muted';
    wrap.appendChild(msg);

    var host = document.createElement('div');
    host.className = 'ledger-host';
    wrap.appendChild(host);

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
          note('');
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

    function render() {
      host.textContent = '';
      if (!state.rows.length) {
        note(state.loaded ? 'No expenses yet.' : 'Loading…');
        return;
      }
      note('Click a cell to edit. Enter saves, Esc cancels.');
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
      state.rows.forEach(function (row) {
        var tr = document.createElement('tr');
        EDITABLE.forEach(function (field) {
          var td = document.createElement('td');
          td.className = 'ledger-cell';
          td.setAttribute('data-field', field);
          renderCell(td, row, field);
          td.addEventListener('click', function () { beginEdit(td, row, field); });
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

  return { mount: mount, buildCellPatch: buildCellPatch, EDITABLE: EDITABLE };
});
