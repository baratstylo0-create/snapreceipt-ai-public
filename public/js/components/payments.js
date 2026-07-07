// components/payments.js — the payment Pending/Paid tabs (ADR-021 Phase 6).
//
// Business mode only (the section only exists in business nav). Shows the expense list split
// into Pending / Paid tabs with month + branch + staff filters. The ADMIN gets a checkbox per
// row + a sticky "N selected · total" bar with a Mark paid / Mark pending action that calls
// the Phase-4 bulk endpoint (PATCH /api/expenses/payments — reversible). A CLERK sees their
// own branch's rows read-only (the server scopes both the list and the write anyway; hiding
// the controls just keeps the UI honest).
//
// Same conventions as every other view: pure DOM (createElement/textContent — never innerHTML
// with a dynamic value), UMD shim, the pure logic (filterRows/selectionSummary) node-testable.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Payments = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- pure logic (node-tested) ----------------------------------------------

  // A row with NO payment_status is treated as pending: rows written before the M2-P4
  // migration have no value, and 'pending' is that migration's default — never hide money.
  function statusOf(row) { return row && row.payment_status === 'paid' ? 'paid' : 'pending'; }

  // filterRows(rows, { tab, month, branch, staff }) -> rows matching the tab + filters.
  // month matches the expense_date 'YYYY-MM' prefix; branch/staff accept an id or the
  // literal 'unassigned' (matches rows with no value). Garbage input -> [] (never throws).
  function filterRows(rows, opts) {
    opts = opts || {};
    var tab = opts.tab === 'paid' ? 'paid' : 'pending';
    var out = [];
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      if (statusOf(r) !== tab) continue;
      if (opts.month && String(r.expense_date || '').slice(0, 7) !== opts.month) continue;
      if (opts.branch) {
        var b = r.branch_id == null || r.branch_id === '' ? 'unassigned' : String(r.branch_id);
        if (b !== String(opts.branch)) continue;
      }
      if (opts.staff) {
        var s = r.staff_user_id == null || r.staff_user_id === '' ? 'unassigned' : String(r.staff_user_id);
        if (s !== String(opts.staff)) continue;
      }
      out.push(r);
    }
    return out;
  }

  // selectionSummary(rows, selectedIds) -> { count, total } for the sticky bar. Non-finite
  // amounts count toward `count` but contribute 0 to the money total (never a fake number).
  function selectionSummary(rows, selectedIds) {
    var ids = Array.isArray(selectedIds) ? selectedIds : [];
    var set = {};
    for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
    var count = 0, total = 0;
    var list = Array.isArray(rows) ? rows : [];
    for (var j = 0; j < list.length; j++) {
      var r = list[j];
      if (!r || !set[r.id]) continue;
      count += 1;
      var n = Number(r.amount);
      if (isFinite(n)) total += n;
    }
    return { count: count, total: Math.round((total + Number.EPSILON) * 100) / 100 };
  }

  // ---- view -------------------------------------------------------------------

  function mount(section, deps) {
    if (typeof document === 'undefined' || !section) return null;
    var Api = deps.Api, Escape = deps.Escape, Format = deps.Format || (typeof root !== 'undefined' && root.Format) || null;
    var isAdmin = !!(deps.session && deps.session.role === 'admin');

    var state = { rows: [], tab: 'pending', month: '', branch: '', staff: '', selected: {}, branchNames: {}, loaded: false };

    var wrap = document.createElement('div');
    wrap.className = 'payments';
    section.appendChild(wrap);

    // -- tab bar --
    var tabs = document.createElement('div');
    tabs.className = 'pay-tabs';
    var tabBtns = {};
    ['pending', 'paid'].forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pay-tab';
      b.textContent = t === 'pending' ? 'Pending' : 'Paid';
      b.addEventListener('click', function () { state.tab = t; state.selected = {}; render(); });
      tabs.appendChild(b);
      tabBtns[t] = b;
    });
    wrap.appendChild(tabs);

    // -- filters --
    var filters = document.createElement('div');
    filters.className = 'pay-filters';
    var monthInput = document.createElement('input');
    monthInput.type = 'month';
    monthInput.className = 'pay-filter-month';
    monthInput.setAttribute('aria-label', 'Filter by month');
    monthInput.addEventListener('change', function () { state.month = monthInput.value || ''; state.selected = {}; render(); });
    filters.appendChild(monthInput);
    var branchSel = document.createElement('select');
    branchSel.className = 'pay-filter-branch';
    branchSel.setAttribute('aria-label', 'Filter by branch');
    branchSel.addEventListener('change', function () { state.branch = branchSel.value; state.selected = {}; render(); });
    filters.appendChild(branchSel);
    var staffSel = document.createElement('select');
    staffSel.className = 'pay-filter-staff';
    staffSel.setAttribute('aria-label', 'Filter by staff');
    staffSel.addEventListener('change', function () { state.staff = staffSel.value; state.selected = {}; render(); });
    filters.appendChild(staffSel);
    wrap.appendChild(filters);

    var msg = document.createElement('p');
    msg.className = 'pay-msg muted';
    wrap.appendChild(msg);

    var tableHost = document.createElement('div');
    tableHost.className = 'pay-table-host';
    wrap.appendChild(tableHost);

    // -- sticky selection bar (admin only) --
    var bar = document.createElement('div');
    bar.className = 'pay-selection-bar';
    bar.hidden = true;
    var barLabel = document.createElement('span');
    barLabel.className = 'pay-selection-label';
    bar.appendChild(barLabel);
    var actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.className = 'pay-action-btn';
    actBtn.addEventListener('click', doBulk);
    bar.appendChild(actBtn);
    if (isAdmin) wrap.appendChild(bar);

    function money(v) { return Format && Format.formatMoney ? Format.formatMoney(v) : String(v); }

    function rebuildFilterOptions() {
      // Branch options: names when the admin could fetch them, else the raw ids present
      // in the data; 'unassigned' groups untagged rows. Staff: distinct ids in the data.
      function fill(sel, label, values, names) {
        sel.textContent = '';
        var all = document.createElement('option');
        all.value = '';
        all.textContent = label;
        sel.appendChild(all);
        values.forEach(function (v) {
          var o = document.createElement('option');
          o.value = v;
          o.textContent = v === 'unassigned' ? 'Unassigned' : (names && names[v]) || v;
          sel.appendChild(o);
        });
      }
      var branches = {}, staff = {};
      state.rows.forEach(function (r) {
        if (!r) return;
        branches[r.branch_id == null || r.branch_id === '' ? 'unassigned' : String(r.branch_id)] = true;
        staff[r.staff_user_id == null || r.staff_user_id === '' ? 'unassigned' : String(r.staff_user_id)] = true;
      });
      fill(branchSel, 'All branches', Object.keys(branches).sort(), state.branchNames);
      fill(staffSel, 'All staff', Object.keys(staff).sort(), null);
      branchSel.value = state.branch;
      staffSel.value = state.staff;
    }

    function render() {
      tabBtns.pending.classList.toggle('is-active', state.tab === 'pending');
      tabBtns.paid.classList.toggle('is-active', state.tab === 'paid');

      var rows = filterRows(state.rows, { tab: state.tab, month: state.month, branch: state.branch, staff: state.staff });
      tableHost.textContent = '';

      if (!rows.length) {
        Escape.setText(msg, state.loaded ? 'No ' + state.tab + ' expenses match the filters.' : 'Loading…');
      } else {
        Escape.setText(msg, '');
      }

      var table = document.createElement('table');
      table.className = 'pay-table';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      var headers = (isAdmin ? [''] : []).concat(['Date', 'Merchant', 'Category', 'Amount', 'Branch', 'Status']);
      headers.forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        if (isAdmin) {
          var tdSel = document.createElement('td');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'pay-row-check';
          cb.checked = !!state.selected[r.id];
          cb.addEventListener('change', function () {
            if (cb.checked) state.selected[r.id] = true; else delete state.selected[r.id];
            updateBar(rows);
          });
          tdSel.appendChild(cb);
          tr.appendChild(tdSel);
        }
        [String(r.expense_date || ''), String(r.merchant || ''), String(r.category || ''),
          money(r.amount),
          r.branch_id == null || r.branch_id === '' ? '—' : (state.branchNames[r.branch_id] || String(r.branch_id)),
          statusOf(r) === 'paid' ? 'Paid' : 'Pending',
        ].forEach(function (v) {
          var td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableHost.appendChild(table);
      updateBar(rows);
    }

    function updateBar(visibleRows) {
      if (!isAdmin) return;
      var ids = Object.keys(state.selected);
      var sum = selectionSummary(state.rows, ids);
      bar.hidden = sum.count === 0;
      barLabel.textContent = sum.count + ' selected · ' + money(sum.total);
      actBtn.textContent = state.tab === 'pending' ? 'Mark paid' : 'Mark pending';
      actBtn.disabled = false;
    }

    function doBulk() {
      var ids = Object.keys(state.selected);
      if (!ids.length) return;
      actBtn.disabled = true;
      Escape.setText(msg, 'Updating ' + ids.length + '…');
      Api.apiFetch('/api/expenses/payments', {
        method: 'PATCH',
        body: { ids: ids, paid: state.tab === 'pending' },
      }).then(function () {
        state.selected = {};
        return load(); // re-fetch so the rows move tabs with server truth
      }).catch(function (err) {
        actBtn.disabled = false;
        Escape.setText(msg, err && err.status === 403 ? 'Only the admin can update payments.' : 'Update failed. Please try again.');
      });
    }

    function load() {
      var chain = Api.apiFetch('/api/expenses').then(function (rows) {
        state.rows = Array.isArray(rows) ? rows : [];
        state.loaded = true;
      });
      // Branch names are an admin nicety (clerks 403 on /api/branches) — best-effort.
      if (isAdmin) {
        chain = chain.then(function () {
          return Api.apiFetch('/api/branches').then(function (r) {
            var names = {};
            ((r && r.branches) || []).forEach(function (b) { names[b.id] = b.office; });
            state.branchNames = names;
          }).catch(function () { /* names stay ids */ });
        });
      }
      return chain.then(function () { rebuildFilterOptions(); render(); })
        .catch(function () { Escape.setText(msg, 'Could not load expenses. Please try again shortly.'); });
    }

    render();
    return { load: load };
  }

  return { mount: mount, filterRows: filterRows, selectionSummary: selectionSummary };
});
