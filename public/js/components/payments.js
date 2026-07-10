// components/payments.js — the payment Pending/Paid tabs (ADR-021 Phase 6).
//
// Business mode only (the section only exists in business nav). Shows the expense list split
// into Pending / Paid tabs with month + branch filters (the "All Staff" filter was removed —
// QA round, redundant/confusing; use the branch filter, or leave it on "All branches").
// The ADMIN gets a checkbox per
// row + a sticky "N selected · total" bar with a Mark paid / Mark pending action that calls
// the Phase-4 bulk endpoint (PATCH /api/expenses/payments — reversible). A CLERK sees their
// own branch's rows read-only (the server scopes both the list and the write anyway; hiding
// the controls just keeps the UI honest).
//
// Same conventions as every other view: pure DOM (createElement/textContent — never innerHTML
// with a dynamic value), UMD shim, the pure logic (filterRows/selectionSummary) node-testable.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../exportGuards'));
  else root.Payments = factory(root.ExportGuards);
})(typeof self !== 'undefined' ? self : this, function (ExportGuards) {
  'use strict';

  // ---- pure logic (node-tested) ----------------------------------------------

  // A row with NO payment_status is treated as pending: rows written before the M2-P4
  // migration have no value, and 'pending' is that migration's default — never hide money.
  function statusOf(row) { return row && row.payment_status === 'paid' ? 'paid' : 'pending'; }

  // filterRows(rows, { tab, month, branch }) -> rows matching the tab + filters.
  // month matches the expense_date 'YYYY-MM' prefix; branch accepts an id or the
  // literal 'unassigned' (matches rows with no value). Garbage input -> [] (never throws).
  // (A `staff` option is silently ignored — the All Staff filter was removed.)
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
      out.push(r);
    }
    return out;
  }

  // --- Send-to-Admin pure logic (ADR-022 Phase 7) ---------------------------

  // submissionStatusLine(subs, branchNames) -> the admin's one-line inbox summary for the
  // selected month. Withdrawn rows are excluded (a withdraw means "not handed off");
  // unknown branch ids fall back to the raw id. Garbage input -> the friendly empty line.
  function submissionStatusLine(subs, branchNames) {
    var names = [];
    var list = Array.isArray(subs) ? subs : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s.status !== 'submitted') continue;
      var id = s.branch_id == null ? '' : String(s.branch_id);
      names.push((branchNames && branchNames[id]) || id);
    }
    if (!names.length) return 'No branch submissions yet.';
    return names.length + ' submitted · ' + names.join(', ');
  }

  // clerkSendState({ month, submission }) -> { canSend, label, withdrawable, reason? }.
  // The clerk's send button: needs a month picked; an existing 'submitted' row for that
  // month flips the label to Re-send and allows a withdraw (the reversibility valve).
  function clerkSendState(opts) {
    opts = opts || {};
    if (!opts.month) return { canSend: false, label: 'Send to Admin', withdrawable: false, reason: 'Pick a month first.' };
    var sub = opts.submission;
    var sent = !!(sub && sub.status === 'submitted');
    return { canSend: true, label: sent ? 'Re-send to Admin' : 'Send to Admin', withdrawable: sent };
  }

  // --- Statement export pure logic (ADR-023/024 Phase 10 UI) -----------------

  var statementBranchRequiredMessage = 'Statements are per-branch - pick a branch, or use Manage -> Export for all branches.';

  // statementReady({ month, branch }, isAdmin) -> { ok, reason? }. A clerk only needs a
  // month (the server hard-forces their own branch); an admin also needs a real branch
  // picked — 'All branches'/'unassigned' isn't a valid single-branch statement.
  function statementReady(opts, isAdmin) {
    opts = opts || {};
    if (!opts.month) return { ok: false, reason: 'Pick a month first.' };
    if (isAdmin && (!opts.branch || opts.branch === 'unassigned')) return { ok: false, reason: statementBranchRequiredMessage };
    return { ok: true };
  }

  // statementUrl({ month, branch }, isAdmin, format) -> the GET /api/statement query string.
  function statementUrl(opts, isAdmin, format) {
    opts = opts || {};
    var params = ['period=' + encodeURIComponent(opts.month), 'format=' + encodeURIComponent(format)];
    if (isAdmin) params.push('branch=' + encodeURIComponent(opts.branch));
    return '/api/statement?' + params.join('&');
  }

  // Rows the statement export would actually cover from the client-side cache. Admin exports
  // a selected branch/month; clerk rows are already branch-scoped by /api/expenses, so month is
  // enough. This deliberately ignores the Pending/Paid tab: a petty-cash statement is a branch
  // x month evidence pack, not just the currently visible payment-status slice.
  function statementExportRows(rows, opts, isAdmin) {
    opts = opts || {};
    var month = String(opts.month || '');
    if (!month) return [];
    var branch = opts.branch == null ? '' : String(opts.branch);
    var out = [];
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      if (r.deleted_at) continue;
      if (String(r.status || '') === 'rejected') continue;
      if (String(r.expense_date || '').slice(0, 7) !== month) continue;
      if (isAdmin) {
        var b = r.branch_id == null || r.branch_id === '' ? 'unassigned' : String(r.branch_id);
        if (b !== branch) continue;
      }
      out.push(r);
    }
    return out;
  }

  // optionModels(label, values, names) -> deterministic select options. The option value
  // remains the stable id used by filters/API calls; names only affect the visible label.
  function optionModels(label, values, names) {
    var out = [{ value: '', label: label }];
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i++) {
      var value = String(list[i]);
      out.push({ value: value, label: value === 'unassigned' ? 'Unassigned' : (names && names[value]) || value });
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
    // Owner follow-up (2026-07-10): the export-reminder popup's "Review" button navigates to
    // Activity — same shared switcher Upload's "View in Activity" button already uses.
    var switchView = typeof deps.switchView === 'function' ? deps.switchView : null;

    var state = { rows: [], tab: 'pending', month: '', branch: '', selected: {}, branchNames: {}, loaded: false, mySubmission: null };

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
    monthInput.addEventListener('change', function () { state.month = monthInput.value || ''; state.selected = {}; render(); refreshSubmissions(); });
    filters.appendChild(monthInput);
    var branchSel = document.createElement('select');
    branchSel.className = 'pay-filter-branch';
    branchSel.setAttribute('aria-label', 'Filter by branch');
    branchSel.addEventListener('change', function () { state.branch = branchSel.value; state.selected = {}; render(); });
    filters.appendChild(branchSel);
    wrap.appendChild(filters);

    // -- Send to Admin (ADR-022 Phase 7, flag branch_submission) --
    // Clerk: a month-scoped Send/Re-send button (+ Withdraw when sent) — replaces the
    // WhatsApp hand-off. Admin: a read-only "which branches submitted this month" line.
    // The server enforces role + own-branch regardless; this is honest UI on top.
    var submissionOn = !!(deps.config && deps.config.branch_submission);
    var isClerk = !!(deps.session && deps.session.role === 'clerk');
    var subWrap = null, subMsg = null, sendBtn = null, withdrawBtn = null;
    if (submissionOn) {
      subWrap = document.createElement('div');
      subWrap.className = 'pay-submission';
      subMsg = document.createElement('span');
      subMsg.className = 'pay-submission-msg muted';
      subWrap.appendChild(subMsg);
      if (isClerk) {
        sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'pay-send-btn';
        sendBtn.addEventListener('click', doSend);
        subWrap.appendChild(sendBtn);
        withdrawBtn = document.createElement('button');
        withdrawBtn.type = 'button';
        withdrawBtn.className = 'pay-withdraw-btn';
        withdrawBtn.textContent = 'Withdraw';
        withdrawBtn.hidden = true;
        withdrawBtn.addEventListener('click', doWithdraw);
        subWrap.appendChild(withdrawBtn);
      }
      wrap.appendChild(subWrap);
    }

    // -- Statement export (ADR-023/024 Phase 10 UI): the client-facing formatted deliverable,
    // separate from the raw Payments table above. Two DISTINCT buttons (never a combined
    // dropdown, per Owner spec) — Excel and PDF are different artifacts a client asks for by
    // name. Reuses the month/branch filters already in the toolbar above. Both formats already
    // carry the receipt images server-side (xlsx embeds them inline, pdf appends one page per
    // receipt) — this UI only has to reach the existing GET /api/statement, not build that part.
    var stmtWrap = document.createElement('div');
    stmtWrap.className = 'pay-statement';
    var stmtLabel = document.createElement('span');
    stmtLabel.className = 'pay-statement-label';
    stmtLabel.textContent = 'Petty Cash Statement:';
    stmtWrap.appendChild(stmtLabel);
    var xlsxBtn = document.createElement('button');
    xlsxBtn.type = 'button';
    xlsxBtn.className = 'pay-statement-btn pay-statement-xlsx';
    xlsxBtn.textContent = 'Export Excel';
    xlsxBtn.addEventListener('click', function () { doStatementExport('xlsx'); });
    stmtWrap.appendChild(xlsxBtn);
    var pdfBtn = document.createElement('button');
    pdfBtn.type = 'button';
    pdfBtn.className = 'pay-statement-btn pay-statement-pdf';
    pdfBtn.textContent = 'Export PDF';
    pdfBtn.addEventListener('click', function () { doStatementExport('pdf'); });
    stmtWrap.appendChild(pdfBtn);
    var stmtMsg = document.createElement('span');
    stmtMsg.className = 'pay-statement-msg muted';
    stmtWrap.appendChild(stmtMsg);
    wrap.appendChild(stmtWrap);

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
      // in the data; 'unassigned' groups untagged rows.
      function fill(sel, label, values, names) {
        sel.textContent = '';
        optionModels(label, values, names).forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          sel.appendChild(o);
        });
      }
      var branches = {};
      state.rows.forEach(function (r) {
        if (!r) return;
        branches[r.branch_id == null || r.branch_id === '' ? 'unassigned' : String(r.branch_id)] = true;
      });
      fill(branchSel, 'All branches', Object.keys(branches).sort(), state.branchNames);
      branchSel.value = state.branch;
    }

    function render() {
      tabBtns.pending.classList.toggle('is-active', state.tab === 'pending');
      tabBtns.paid.classList.toggle('is-active', state.tab === 'paid');

      var rows = filterRows(state.rows, { tab: state.tab, month: state.month, branch: state.branch });
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

    // -- Send-to-Admin behaviour (no-ops unless the flag built the UI above) --
    function refreshSubmissions() {
      if (!submissionOn || !subMsg) return;
      var st = clerkSendState({ month: state.month, submission: state.mySubmission });
      if (!state.month) {
        Escape.setText(subMsg, isClerk ? (st.reason || '') : 'Pick a month to see branch submissions.');
        if (sendBtn) { sendBtn.textContent = st.label; sendBtn.disabled = true; }
        if (withdrawBtn) withdrawBtn.hidden = true;
        return;
      }
      Api.apiFetch('/api/submissions?period=' + encodeURIComponent(state.month)).then(function (r) {
        var subs = (r && r.submissions) || [];
        if (isClerk) {
          // The server already scoped this to the clerk's own branch — first row wins.
          state.mySubmission = subs[0] || null;
          var s2 = clerkSendState({ month: state.month, submission: state.mySubmission });
          Escape.setText(subMsg, s2.withdrawable
            ? 'Sent to admin' + (state.mySubmission.submitted_at ? ' · ' + String(state.mySubmission.submitted_at).slice(0, 10) : '')
            : (state.mySubmission && state.mySubmission.status === 'withdrawn' ? 'Withdrawn — not sent.' : 'Not sent yet.'));
          if (sendBtn) { sendBtn.textContent = s2.label; sendBtn.disabled = !s2.canSend; }
          if (withdrawBtn) withdrawBtn.hidden = !s2.withdrawable;
        } else {
          Escape.setText(subMsg, submissionStatusLine(subs, state.branchNames));
        }
      }).catch(function () { Escape.setText(subMsg, 'Could not load submissions.'); });
    }

    function doSend() {
      if (!state.month || !sendBtn) return;
      sendBtn.disabled = true;
      Escape.setText(subMsg, 'Sending…');
      Api.apiFetch('/api/submissions', { method: 'POST', body: { period: state.month } })
        .then(function () { return refreshSubmissions(); })
        .catch(function (err) {
          sendBtn.disabled = false;
          Escape.setText(subMsg, err && err.status === 403 ? 'Only a branch clerk can send.' : 'Send failed. Please try again.');
        });
    }

    function doWithdraw() {
      if (!state.mySubmission || !withdrawBtn) return;
      withdrawBtn.disabled = true;
      Api.apiFetch('/api/submissions/' + encodeURIComponent(state.mySubmission.id), { method: 'PATCH', body: { status: 'withdrawn' } })
        .then(function () { withdrawBtn.disabled = false; return refreshSubmissions(); })
        .catch(function () { withdrawBtn.disabled = false; Escape.setText(subMsg, 'Withdraw failed. Please try again.'); });
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

    // Trigger a browser download of `blob` named `filename` via a synthetic <a> click — same
    // technique as reports.js's Excel export (no navigation, no innerHTML).
    function triggerStatementDownload(blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }

    function doStatementExport(format) {
      var ready = statementReady({ month: state.month, branch: state.branch }, isAdmin);
      if (!ready.ok) { Escape.setText(stmtMsg, ready.reason); return; }
      // A3 (Owner 2026-07-10): remind only when receipts still await review; otherwise export
      // straight through. runExportGuard keeps the empty-data guard + counts the scoped queue.
      ExportGuards.runExportGuard({
        data: statementExportRows(state.rows, { month: state.month, branch: state.branch }, isAdmin),
        apiFetch: Api.apiFetch,
        onEmpty: function (m) { Escape.setText(stmtMsg, m); },
        onReview: switchView ? function () { switchView('activity'); } : undefined,
        onProceed: function () { startStatementExport(format); },
      });
    }

    function startStatementExport(format) {
      xlsxBtn.disabled = true;
      pdfBtn.disabled = true;
      Escape.setText(stmtMsg, 'Preparing ' + format.toUpperCase() + '…');
      var url = statementUrl({ month: state.month, branch: state.branch }, isAdmin, format);
      Api.fetchBlob(url).then(function (blob) {
        var branchToken = isAdmin ? state.branch : 'own-branch';
        triggerStatementDownload(blob, 'petty-cash-' + branchToken + '-' + state.month + '.' + format);
        Escape.setText(stmtMsg, format.toUpperCase() + ' downloaded.');
      }).catch(function (err) {
        Escape.setText(stmtMsg, err && err.status === 404 ? 'Statement export is not enabled for this account.' : 'Export failed. Please try again.');
      }).then(function () {
        xlsxBtn.disabled = false;
        pdfBtn.disabled = false;
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
      return chain.then(function () { rebuildFilterOptions(); render(); refreshSubmissions(); })
        .catch(function () { Escape.setText(msg, 'Could not load expenses. Please try again shortly.'); });
    }

    render();
    refreshSubmissions();
    return { load: load };
  }

  return {
    mount: mount, filterRows: filterRows, selectionSummary: selectionSummary,
    submissionStatusLine: submissionStatusLine, clerkSendState: clerkSendState,
    statementReady: statementReady, statementUrl: statementUrl, statementExportRows: statementExportRows,
    statementBranchRequiredMessage: statementBranchRequiredMessage,
    optionModels: optionModels,
  };
});
