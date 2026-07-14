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

  // Human-settable statuses (mirrors the toolbar filter). Excludes the auto-only
  // sentinel states 'awaiting_category'/'awaiting_remark' — those are set by the
  // OCR pipeline, not something a person should manually switch a row into.
  var STATUS_OPTIONS = ['saved', 'needs_review', 'approved', 'rejected'];

  // statusLabel(status) -> a human-readable label for a raw DB status string. The DB stores
  // snake_case machine values ('needs_review', 'awaiting_category'); showing those verbatim in
  // the UI reads like a leaked internal (Owner request 2026-07-12: "needs_review" should read
  // "Need Review"). Known values get a hand-picked label; anything unknown degrades to a
  // Title-Cased version of the raw value (never throws, never shows a blank).
  var STATUS_LABELS = {
    saved: 'Saved',
    needs_review: 'Need Review',
    approved: 'Approved',
    rejected: 'Rejected',
    awaiting_category: 'Awaiting Category',
    awaiting_remark: 'Awaiting Remark',
  };
  function statusLabel(status) {
    var raw = status == null ? '' : String(status);
    if (STATUS_LABELS[raw]) return STATUS_LABELS[raw];
    if (!raw) return '';
    return raw.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // decisionErrorText(err) -> the message to show when an Approve/Reject POST fails. The review
  // API returns a SPECIFIC, actionable reason (e.g. 403 "the branch clerk decides first — the
  // admin valve opens 7 days after flagging", or 409 "expense is not pending review") — the old
  // catch threw all of that away and showed a bare "Action failed", leaving the user with no idea
  // WHY (Owner report 2026-07-12: "why did approve fail?"). Surface the server's own message when
  // present; fall back to the generic line only when there's nothing specific (network/5xx).
  function decisionErrorText(err) {
    var msg = err && err.body && err.body.error;
    if (msg && typeof msg === 'string') return msg;
    return 'Action failed. Please try again.';
  }

  // DYNAMIC CATEGORIES (bug fix): the category list is no longer a hardcoded,
  // driftable 5-name stub — it now comes live from GET /api/config's
  // `categories` field (sourced from lib/categorize.js's real ~18-category
  // chart of accounts). DEFAULT_CATEGORIES is ONLY the safe fallback used
  // before that config has resolved, or if it comes back malformed — never the
  // list actually shown once config is available. See resolveCategories().
  var DEFAULT_CATEGORIES = ['Others'];
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

  // Fixed palette size for the deterministic category-colour hash below. Matches
  // the .act-pill--c0 .. .act-pill--c9 classes in app.css.
  var PALETTE_SIZE = 10;

  // Small, stable string hash (djb2-ish). Pure, deterministic, never throws —
  // coerces any input to a string first via str().
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0; // h*33 + c, kept in 32-bit range
    }
    return Math.abs(h);
  }

  // Category name -> a stable class suffix ('c0'..'c9', or 'others' for the
  // neutral grey bucket). Replaces the old hardcoded 5-name map (the bug this
  // branch fixes): with 18+ real chart-of-accounts categories, a name->class
  // table doesn't scale and drifts. Instead every category string hashes
  // deterministically to one of a fixed palette of ~10 colours, so ANY real
  // category gets a consistent, visually distinct pill without a hardcoded
  // per-name mapping. Only empty/null/undefined/"Others" (case-insensitive)
  // map to the dedicated neutral 'others' grey — an arbitrary unmatched
  // category gets its own palette slot, not silently merged into Others.
  // Case-insensitive/whitespace-insensitive so 'Food' and '  food  ' agree.
  // Never returns markup; never throws on weird input (numbers, objects, etc).
  function categoryColor(name) {
    var key = str(name).trim().toLowerCase();
    if (key === '' || key === 'others') return 'others';
    return 'c' + (hashString(key) % PALETTE_SIZE);
  }

  // Return the distinct, usable categories carried by a receipt's line items.
  // Category names are compared case/whitespace-insensitively, while the first
  // display spelling is retained. Empty/malformed categories do not turn a
  // normal receipt into a misleading "Mixed" receipt.
  function lineItemCategories(row) {
    var items = row && Array.isArray(row.line_items) ? row.line_items : [];
    var seen = Object.create(null);
    var categories = [];
    items.forEach(function (it) {
      var raw = it && typeof it.category === 'string' ? it.category : '';
      var display = raw.trim();
      var key = display.toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      categories.push(display);
    });
    return categories;
  }

  // The compact label used in the Activity table/card category cell. A null
  // result deliberately preserves the existing single-category rendering.
  function mixedCategoryLabel(row) {
    var count = lineItemCategories(row).length;
    return count > 1 ? 'Mixed (' + count + ')' : null;
  }

  // Normalise the data consumed by the detail drawer without changing the
  // server row. Keeping this pure makes the line-item display testable without
  // a browser DOM and keeps hostile OCR text on the existing Escape.setText path.
  function lineItemDetails(row) {
    var items = row && Array.isArray(row.line_items) ? row.line_items : [];
    return items.map(function (it) {
      return {
        description: str(it && (it.description || it.name)),
        amount: it && it.amount != null ? it.amount : null,
        category: str(it && it.category),
        flagged: !!(it && it.flagged),
      };
    });
  }

  // Build the live category list for the filter/edit dropdowns from a
  // /api/config-shaped object ({ categories: [...] }, see routes/expenses.js).
  // Falls back to a small hardcoded safe default (DEFAULT_CATEGORIES) when the
  // config hasn't resolved yet (undefined/null), or comes back malformed
  // (categories missing / not an array / empty / non-string entries) — the
  // dropdown must never be empty and this must never throw.
  function resolveCategories(config, fallback) {
    var fb = Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_CATEGORIES;
    if (!config || typeof config !== 'object') return fb;
    var cats = config.categories;
    if (!Array.isArray(cats) || !cats.length) return fb;
    var clean = cats.filter(function (c) { return typeof c === 'string' && c.trim() !== ''; });
    return clean.length ? clean : fb;
  }

  // FieldSpec-aware label lookup: key -> the customer's own field label from
  // GET /api/templates ({ columns:[{key,label,...}] }), falling back to the
  // hardcoded English label when the key isn't present in their FieldSpec, or
  // the FieldSpec/columns is missing/malformed. Pure — does NOT escape; the
  // caller must route the result through Escape.setText/safeText at render
  // time (a FieldSpec label is customer-supplied, untrusted text). Never
  // throws on garbage input.
  function labelFor(key, fieldSpec, fallback) {
    var fb = fallback === undefined ? '' : fallback;
    if (!fieldSpec || typeof fieldSpec !== 'object') return fb;
    var columns = fieldSpec.columns;
    if (!Array.isArray(columns)) return fb;
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i];
      if (col && typeof col === 'object' && col.key === key) {
        var label = col.label;
        if (typeof label === 'string' && label !== '') return label;
        return fb;
      }
    }
    return fb;
  }

  // Row -> list of badge descriptors (raw data; render escapes). Kinds:
  //   { kind:'anomaly', reason }              — needs-review anomaly
  //   { kind:'low-confidence' }               — some field flagged "low"
  //   { kind:'converted', original, amountOriginal, fxRate } — FX-converted
  // Shared, defensive reader for the real anomaly shape: { flagged, reasons: [{type,
  // detail, severity}, ...] }. Joins every reason's `detail` into one readable string;
  // tolerates a missing/non-array `reasons` (never throws) -> generic fallback text.
  function anomalyReasonText(anomaly) {
    var list = anomaly && Array.isArray(anomaly.reasons) ? anomaly.reasons : [];
    var details = list.map(function (r) { return r && typeof r === 'object' ? str(r.detail) : ''; })
      .filter(function (s) { return s !== ''; });
    return details.length ? details.join('; ') : 'Flagged for review';
  }

  function badgesFor(rowObj) {
    if (!rowObj || typeof rowObj !== 'object') return [];
    var out = [];

    // Bug fix (QA report #10b): the real shape written by lib/ocr.js/lib/anomaly.js is
    // `{ flagged, reasons: [{type, detail, severity}, ...] }` — there has never been a
    // singular `.reason` field. Reading `a.reason` was always undefined, so the badge
    // tooltip and the review-queue card have ALWAYS shown a generic "Flagged for review"
    // instead of the real reason (duplicate / outlier / low-confidence / personal-spend),
    // which is exactly why it wasn't obvious what the badges meant or that duplicate
    // detection was already working. anomalyReasonText() is the shared, defensive reader.
    var a = rowObj.anomaly;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      var flagged = a.flagged === true;
      if (flagged) out.push({ kind: 'anomaly', reason: anomalyReasonText(a) });
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

  // Business directory helpers. The API returns branch/staff IDs on expense
  // rows, so the admin Activity view resolves them once and keeps raw IDs as a
  // safe fallback when a directory entry is stale or unavailable.
  function branchNamesFromResponse(resp) {
    var rows = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.branches) ? resp.branches : []);
    var names = {};
    rows.forEach(function (branch) {
      if (!branch || branch.id == null || branch.id === '') return;
      var id = String(branch.id);
      var office = typeof branch.office === 'string' ? branch.office.trim() : '';
      names[id] = office || id;
    });
    return names;
  }

  function staffNamesFromResponse(resp) {
    var rows = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.staff) ? resp.staff : []);
    var names = {};
    rows.forEach(function (staff) {
      if (!staff || staff.id == null || staff.id === '') return;
      var id = String(staff.id);
      var display = typeof staff.display_name === 'string' ? staff.display_name.trim() : '';
      var username = typeof staff.username === 'string' ? staff.username.trim() : '';
      names[id] = display || username || id;
    });
    return names;
  }

  function displayBranchName(row, names) {
    var id = row && row.branch_id;
    if (id == null || id === '') return '—';
    var key = String(id);
    return names && names[key] ? String(names[key]) : key;
  }

  function displayStaffName(row, names) {
    var id = row && row.staff_user_id;
    if (id == null || id === '') return '—';
    var key = String(id);
    return names && names[key] ? String(names[key]) : key;
  }

  // Admin-only branch picker models. Keep the two synthetic options first,
  // then include directory branches plus IDs observed on rows (so a directory
  // fetch failure can never make a real row impossible to filter).
  function activityBranchOptions(branches, rows, session) {
    if (!session || session.role !== 'admin') return [];
    var branchRows = Array.isArray(branches) ? branches : [];
    var expenseRows = Array.isArray(rows) ? rows : [];
    var names = branchNamesFromResponse(branchRows);
    var ids = Object.create(null);
    Object.keys(names).forEach(function (id) { ids[id] = true; });
    var unassigned = false;
    expenseRows.forEach(function (row) {
      var id = row && row.branch_id;
      if (id == null || id === '') { unassigned = true; return; }
      var key = String(id);
      ids[key] = true;
      if (!names[key]) names[key] = key;
    });
    var options = [
      { value: 'all', label: 'All branches' },
      { value: 'mine', label: 'My uploads' },
    ];
    var mapped = Object.keys(ids).map(function (id) { return { value: id, label: names[id] || id }; });
    mapped.sort(function (a, b) {
      var al = a.label.toLowerCase(); var bl = b.label.toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : (a.value < b.value ? -1 : 1);
    });
    mapped.forEach(function (opt) { options.push(opt); });
    if (unassigned) options.push({ value: 'unassigned', label: 'Unassigned' });
    return options;
  }

  function sameActivityBranch(row, filter, ownBranchId) {
    var id = row && row.branch_id;
    var rowKey = id == null || id === '' ? '' : String(id);
    if (!filter || String(filter).toLowerCase() === 'all') return true;
    if (String(filter).toLowerCase() === 'mine') {
      var ownKey = ownBranchId == null || ownBranchId === '' ? '' : String(ownBranchId);
      return rowKey === ownKey;
    }
    if (String(filter).toLowerCase() === 'unassigned') return rowKey === '';
    return rowKey === String(filter);
  }

  // The searchable haystack for a row (merchant + remark + category + date).
  function haystack(r) {
    return [r && r.merchant, r && r.remark, r && r.category, r && r.expense_date]
      .map(str).join(' ').toLowerCase();
  }

  // Rows the ingestion pipeline saved but couldn't confidently categorize
  // (status 'awaiting_category', category sentinel '__pending__') — the DASHBOARD
  // parity of the Telegram category picker (#74): the bot asks via buttons, the
  // dashboard surfaces them here for a click-to-pick. Pure; tolerates junk -> [].
  var AWAITING_CATEGORY = 'awaiting_category';
  function awaitingCategoryRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (r) { return r && r.status === AWAITING_CATEGORY; });
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

    // Admin Activity branch scope is intentionally client-side: /api/expenses
    // already returned the account-scoped rows, and this picker only changes
    // which of those cached rows are visible. Clerks leave this unset.
    var fb = str(opts.filterBranch).trim();
    if (fb && fb.toLowerCase() !== 'all') {
      list = list.filter(function (r) { return sameActivityBranch(r, fb, opts.sessionBranchId); });
    }

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

  // QA B4 (docs/qa/2026-07-09-qa-round.md PR-B): bulk select -> Approve/Delete. Pure helpers,
  // unit-testable without a DOM — the render layer (buildTable/buildCard/mount) just calls these.
  function bulkApprovePath() { return '/api/review/bulk'; }
  function bulkDeletePath() { return '/api/expenses/bulk-delete'; }

  // allSelected(pageIds, selectedIds) -> true iff every id on the current page is selected.
  // Drives the "tick all" checkbox's checked state. Empty page -> false (nothing to tick).
  function allSelected(pageIds, selectedIds) {
    var ids = Array.isArray(pageIds) ? pageIds : [];
    if (!ids.length) return false;
    var sel = selectedIds instanceof Set ? selectedIds : new Set();
    return ids.every(function (id) { return sel.has(id); });
  }

  // toggleAllSelected(pageIds, selectedIds, checked) -> a NEW Set (never mutates the input) with
  // every id on the current page added (checked=true) or removed (checked=false). Ids outside
  // the current page (a prior page's selections) are left untouched.
  function toggleAllSelected(pageIds, selectedIds, checked) {
    var next = new Set(selectedIds instanceof Set ? selectedIds : []);
    (Array.isArray(pageIds) ? pageIds : []).forEach(function (id) {
      if (checked) next.add(id); else next.delete(id);
    });
    return next;
  }

  // summarizeBulkResult({requested, updated|deleted, results}, verb) -> a short human status
  // line for the bulk action's outcome. verb is the past-tense action word ('approved'/'deleted').
  function summarizeBulkResult(json, verb) {
    if (!json || typeof json !== 'object') return 'Something went wrong. Please try again.';
    var requested = typeof json.requested === 'number' ? json.requested : 0;
    var succeeded = typeof json.updated === 'number' ? json.updated
      : (typeof json.deleted === 'number' ? json.deleted : 0);
    if (requested === 0) return 'Nothing to ' + verb + '.';
    if (succeeded === requested) return 'All ' + requested + ' ' + verb + '.';
    return succeeded + ' of ' + requested + ' ' + verb + ' — ' + (requested - succeeded) + ' failed.';
  }

  // QA B7 (docs/qa/2026-07-09-qa-round.md PR-B): the "Recently deleted" bin + Recover action.
  // Pure path builders, unit-testable without a DOM — mirrors the receiptPath pattern below.
  function deletedRowsPath() { return '/api/expenses/deleted'; }
  function restorePath(id) { return '/api/expenses/' + encodeURIComponent(str(id)) + '/restore'; }

  // QA 2026-07-13 (Untitled document (4).md): the recently-deleted bin didn't say WHEN a
  // bill falls out of the system. DISPLAY-ONLY reminder — there is no auto-purge job today
  // (deleted_at is a permanent soft-delete; nothing ever clears an old deleted row), so this
  // computes what the reminder date WOULD be under a stated retention policy. Never throws on
  // a missing/malformed deleted_at (a row from before this feature, or a hostile value).
  var DELETED_RETENTION_DAYS = 30;
  function purgeReminderDate(deletedAt, retentionDays) {
    var days = Number.isFinite(retentionDays) ? retentionDays : DELETED_RETENTION_DAYS;
    var t = deletedAt ? Date.parse(deletedAt) : NaN;
    if (!Number.isFinite(t)) return null;
    var d = new Date(t + days * 86400000);
    if (!Number.isFinite(d.getTime())) return null;
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }

  // QA B8/B9 (docs/qa/2026-07-09-qa-round.md PR-B): rejected-bill actions, pure so they're
  // unit-testable without a DOM. isRejected gates BOTH the recategorise chevron and the
  // permanent-delete icon — neither shows on a non-rejected row. recategorizeBody mirrors the
  // exact PATCH shape the awaiting-category picker already uses (category + status:'saved'),
  // so a recategorised rejected bill becomes an ordinary saved row, not a new pending state.
  function isRejected(row) { return !!row && row.status === 'rejected'; }
  function recategorizeBody(category) { return { category: category, status: 'saved' }; }
  function permanentDeletePath(id) {
    return '/api/expenses/' + encodeURIComponent(str(id)) + '/permanent';
  }

  // Pure URL builder for the receipt-image proxy (P6 hardening). Kept separate from the
  // render code so it's unit-testable without a DOM. fileId is untrusted (came from OCR/
  // Telegram) so it's always encodeURIComponent'd — never string-concatenated raw into a URL.
  // ADR-027: the `/api/receipt/*` form (not legacy `/receipt/*`) so images ride the
  // `/api/*` → :3005 nginx catch-all that the co-tenant FrictionAI app never claims — a
  // shared `/receipt/` location can only proxy_pass to ONE backend, which is why receipt
  // display kept breaking whenever the other app's route was fixed. See docs/DECISIONS.md.
  function receiptPath(fileId) {
    return '/api/receipt/' + encodeURIComponent(str(fileId));
  }

  // ADR-018: serve the receipt image BY EXPENSE ID. The server looks the row up and streams
  // the durable Storage copy (receipt_url) or falls back to the Telegram proxy — so the
  // browser never learns the raw storage path. id is encodeURIComponent'd (never raw).
  // `/api/receipt/*` path per ADR-027 (collision-proof — see receiptPath above).
  function receiptByIdPath(id) {
    return '/api/receipt/by-id/' + encodeURIComponent(str(id));
  }

  // Does this row have a viewable receipt image on either surface? True for a durable
  // Storage copy (receipt_url, e.g. dashboard uploads) OR a legacy Telegram file (receipt_file_id).
  function hasReceiptImage(row) {
    return receiptKind(row) !== 'none';
  }

  function receiptKind(row) {
    if (!row || typeof row !== 'object') return 'none';
    var path = str(row.receipt_url).split('?')[0].toLowerCase();
    if (path) {
      if (/\.pdf$/.test(path)) return 'pdf';
      if (/\.(png|jpe?g|gif|webp)$/.test(path)) return 'image';
      return 'unknown';
    }
    if (row.receipt_file_id) return 'unknown';
    return 'none';
  }

  function receiptLabel(row) {
    return receiptKind(row) === 'pdf' ? 'Receipt PDF' : 'Receipt image';
  }

  // Owner-reported 2026-07-11: some receipts (mostly ones captured before ADR-018's durable
  // Storage copy existed, or whose only-ever image was the live Telegram file_id proxy) show
  // the SAME generic "Could not load the receipt." for a permanently-gone image as for a
  // one-off network hiccup — no way to tell "try again in a minute" from "this photo is never
  // coming back, re-send it." /receipt/by-id/:id (routes/receipt.js) returns 404 specifically
  // when neither the Storage copy nor the Telegram proxy can produce bytes (row not found,
  // storage object missing, or Telegram's getFile rejects a stale/invalid file_id) — every
  // OTHER failure (401 session, 502 upstream) is a genuine "try again" case. Pure so the
  // distinction is unit-testable without a fetch/DOM.
  function receiptErrorMessage(err) {
    if (err && err.status === 404) {
      return 'This receipt has no photo available. If you have the original, re-send it in Telegram to attach one.';
    }
    return 'Could not load the receipt. Please try again shortly.';
  }

  // Review-queue card meta (Owner 2026-07-10): the ordered, displayable key fields shown under a
  // flagged receipt so it can be reviewed in place — [date, category, ref]. Blanks and the
  // internal '__pending__' category sentinel are dropped so the UI never shows an empty or
  // sentinel value. Pure, never throws.
  function reviewMetaParts(row) {
    if (!row || typeof row !== 'object') return [];
    var parts = [];
    var d = str(row.expense_date).trim();
    if (d) parts.push(d);
    var c = str(row.category).trim();
    if (c && c !== '__pending__') parts.push(c);
    var ref = str(row.voucher_no).trim();
    if (ref) parts.push(ref);
    return parts;
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

  // Bug fix (QA report #3): every keystroke in the search box triggered a full table
  // re-render, which rebuilds the toolbar (a BRAND NEW <input> element) from scratch —
  // the browser can't keep focus on a node that no longer exists, so the user had to
  // click back into the search box after every single letter. Fix: snapshot which
  // element inside `container` is focused (by class, since it's rebuilt) + its cursor
  // position before clearing, then restore both after the new node is in the DOM.
  function captureFocus(container) {
    var active = document.activeElement;
    if (!active || !container || !container.contains(active)) return null;
    var cls = active.className || '';
    if (typeof cls !== 'string' || cls.indexOf('act-search') === -1) return null;
    var sel = null;
    try { sel = { start: active.selectionStart, end: active.selectionEnd }; } catch (e) { sel = null; }
    return { className: 'act-search', selection: sel };
  }
  function restoreFocus(container, captured) {
    if (!captured) return;
    var target = container && container.querySelector('.' + captured.className);
    if (!target) return;
    target.focus();
    if (captured.selection && typeof target.setSelectionRange === 'function') {
      try { target.setSelectionRange(captured.selection.start, captured.selection.end); } catch (e) { /* not all input types support it */ }
    }
  }
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

  // The category cell for a table row / card. An awaiting-category row shows a distinct
  // "Awaiting category" chip instead of the raw '__pending__' sentinel — clearer, and it
  // never leaks the internal sentinel into the UI. (The picker below resolves it.)
  function categoryCell(row) {
    if (row && row.status === 'awaiting_category') {
      var chip = el('span', 'act-pill act-pill--pending');
      Escape.setText(chip, 'Awaiting category');
      return chip;
    }
    var mixed = mixedCategoryLabel(row);
    if (mixed) {
      var mixedChip = pill('Others');
      Escape.setText(mixedChip, mixed);
      mixedChip.setAttribute('title', mixed + ' line-item categories');
      mixedChip.setAttribute('aria-label', mixed);
      return mixedChip;
    }
    return pill(row && row.category);
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
        chip.setAttribute('title', 'The AI wasn’t fully confident reading one or more required fields on this receipt — worth a quick double-check.');
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

  // Auth'd receipt fetch, shared by the drawer's full-size render and the
  // card view's thumbnail (P6 hardening): /receipt/:fileId requires checkDash, so a
  // plain <img src="/receipt/...">  or <a href> can't carry the bearer token and
  // would 401. Fetch the bytes via Api.fetchBlob (attaches the same Authorization
  // header as every other API call), turn them into a browser-generated blob:
  // object URL, and set it on a real <img> via .src — never innerHTML, never a URL
  // built from unescaped data. imgWrap starts with a loading message and is
  // replaced in place once the fetch resolves/rejects. className/alt let the
  // caller size the thumbnail vs. the full drawer image differently via CSS.
  function loadReceiptImage(expenseId, imgWrap, opts) {
    opts = opts || {};
    var imgClassName = opts.imgClassName || 'act-receipt-image';
    var alt = opts.alt || 'Receipt image';
    if (!Api || typeof Api.fetchBlob !== 'function') return;
    Api.fetchBlob(receiptByIdPath(expenseId)).then(function (blob) {
      var url = URL.createObjectURL(blob);
      clear(imgWrap);
      var type = blob && blob.type ? String(blob.type).toLowerCase() : '';
      var isPdf = type.indexOf('pdf') !== -1 || opts.kind === 'pdf';
      if (isPdf) {
        var link = el('a', 'act-receipt-pdf');
        link.href = url;      // browser-generated object URL, not derived from untrusted data
        link.target = '_blank';
        link.rel = 'noopener';
        link.download = 'receipt.pdf';
        Escape.setText(link, 'Open receipt PDF');
        imgWrap.appendChild(link);
      } else {
        var img = el('img', imgClassName);
        img.src = url;        // browser-generated object URL, not derived from untrusted data
        img.alt = alt;
        imgWrap.appendChild(img);
      }
    }).catch(function (err) {
      clear(imgWrap);
      imgWrap.appendChild(msg('act-receipt-msg muted', receiptErrorMessage(err)));
    });
  }

  // ---- render: expense table ---------------------------------------------

  // Small Yes/No confirm modal (QA B4: bulk Approve/Delete needs a confirmation window before
  // it commits). Reuses the EXACT same CSS classes templates.js's showConfirmDialog already
  // defines (tp-confirm-host/tp-confirm-card/tp-confirm-msg/tp-confirm-actions/tp-confirm-cancel/
  // tp-confirm-ok, see app.css "Popup confirm dialog") — no new CSS, same look everywhere.
  function showBulkConfirm(message, confirmLabel, onConfirm) {
    if (typeof document === 'undefined') return;
    var overlay = el('div', 'tp-confirm-host');
    var card = el('div', 'tp-confirm-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.appendChild(msg('tp-confirm-msg', message));

    var actions = el('div', 'tp-confirm-actions');
    var cancelBtn = el('button', 'tp-confirm-cancel'); cancelBtn.type = 'button';
    Escape.setText(cancelBtn, 'Cancel');
    var confirmBtn = el('button', 'tp-confirm-ok'); confirmBtn.type = 'button';
    Escape.setText(confirmBtn, confirmLabel || 'Confirm');
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function onKeydown(ev) { if (ev.key === 'Escape') close(); }
    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKeydown);
    }
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', function () { close(); onConfirm(); });
    confirmBtn.focus();
  }

  // QA B4: the Select toggle + (once active) tick-all/Approve/Delete/Cancel row. pageIds is the
  // CURRENT PAGE's row ids (what "tick all" ticks) — a prior page's selections are preserved
  // untouched (toggleAllSelected only touches pageIds). Rendered once per renderTable() pass so
  // it always reflects the live selection count.
  function buildSelectBar(state, pageIds, handlers) {
    var bar = el('div', 'act-select-bar');
    if (!state.selectMode) {
      // A completed bulk action exits select mode (see runBulkAction) but its outcome message
      // should still be visible for this one render — show it here, not just in the active
      // select-mode branch below, or the user never sees "2 approved" flash by.
      if (state.bulkStatus) bar.appendChild(msg('act-select-status muted', state.bulkStatus));
      var selectBtn = el('button', 'act-select-toggle');
      selectBtn.type = 'button';
      Escape.setText(selectBtn, 'Select');
      selectBtn.addEventListener('click', handlers.onEnterSelectMode);
      bar.appendChild(selectBtn);
      return bar;
    }

    var tickAllWrap = el('label', 'act-select-tickall');
    var tickAll = el('input', 'act-select-tickall-input');
    tickAll.type = 'checkbox';
    tickAll.checked = allSelected(pageIds, state.selectedIds);
    tickAll.setAttribute('aria-label', 'Select all on this page');
    tickAll.addEventListener('change', function () { handlers.onToggleAllRows(pageIds, tickAll.checked); });
    tickAllWrap.appendChild(tickAll);
    var tickAllLabel = el('span'); Escape.setText(tickAllLabel, 'Select all');
    tickAllWrap.appendChild(tickAllLabel);
    bar.appendChild(tickAllWrap);

    var count = state.selectedIds instanceof Set ? state.selectedIds.size : 0;
    var approveBtn = el('button', 'act-select-approve'); approveBtn.type = 'button';
    Escape.setText(approveBtn, 'Approve (' + count + ')');
    approveBtn.disabled = count === 0;
    approveBtn.addEventListener('click', handlers.onBulkApprove);
    bar.appendChild(approveBtn);

    var deleteBtn = el('button', 'act-select-delete'); deleteBtn.type = 'button';
    Escape.setText(deleteBtn, 'Delete (' + count + ')');
    deleteBtn.disabled = count === 0;
    deleteBtn.addEventListener('click', handlers.onBulkDelete);
    bar.appendChild(deleteBtn);

    var cancelBtn = el('button', 'act-select-cancel'); cancelBtn.type = 'button';
    Escape.setText(cancelBtn, 'Cancel');
    cancelBtn.addEventListener('click', handlers.onExitSelectMode);
    bar.appendChild(cancelBtn);

    if (state.bulkStatus) bar.appendChild(msg('act-select-status muted', state.bulkStatus));

    return bar;
  }

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
    ['all'].concat(STATUS_OPTIONS).forEach(function (s) {
      var o = el('option'); o.value = s; Escape.setText(o, s === 'all' ? 'All statuses' : statusLabel(s)); statusSel.appendChild(o);
    });
    statusSel.value = state.filterStatus || 'all';
    statusSel.addEventListener('change', function () { onChange({ filterStatus: statusSel.value, page: 1 }); });
    bar.appendChild(statusSel);

    var catSel = el('select', 'act-filter act-filter--category');
    catSel.setAttribute('aria-label', 'Filter by category');
    var allOpt = el('option'); allOpt.value = 'all'; Escape.setText(allOpt, 'All categories'); catSel.appendChild(allOpt);
    var toolbarCategories = Array.isArray(state.categories) ? state.categories : DEFAULT_CATEGORIES;
    toolbarCategories.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); catSel.appendChild(o); });
    catSel.value = state.filterCategory || 'all';
    catSel.addEventListener('change', function () { onChange({ filterCategory: catSel.value, page: 1 }); });
    bar.appendChild(catSel);

    if (state.isAdmin) {
      var branchSel = el('select', 'act-filter act-filter--branch');
      branchSel.setAttribute('aria-label', 'Filter by branch');
      activityBranchOptions(state.branches, state.rows, state.session).forEach(function (opt) {
        var o = el('option'); o.value = opt.value; Escape.setText(o, opt.label); branchSel.appendChild(o);
      });
      branchSel.value = state.filterBranch || 'mine';
      branchSel.addEventListener('change', function () { onChange({ filterBranch: branchSel.value, page: 1 }); });
      bar.appendChild(branchSel);
    }

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

  // FieldSpec-aware labels for the table's known column keys (merchant,
  // expense_date, amount, category) — customer's own label when present in
  // their FieldSpec, else the current hardcoded English fallback. `status` is
  // a system concept, never part of any customer FieldSpec, so it is NOT
  // looked up here — always the hardcoded label.
  // The human-readable reference number for a row (RC-2026-0041), or '—' when a row
  // has none yet (pre-migration / not-yet-assigned). Pure; safe on null/garbage rows.
  function refDisplay(r) {
    var v = r && r.voucher_no;
    return (typeof v === 'string' && v.trim()) ? v.trim() : '—';
  }

  function columnLabels(fieldSpec) {
    return {
      merchant: labelFor('merchant', fieldSpec, 'Merchant'),
      expense_date: labelFor('expense_date', fieldSpec, 'Date'),
      amount: labelFor('amount', fieldSpec, 'Amount'),
      category: labelFor('category', fieldSpec, 'Category'),
      status: 'Status',
    };
  }

  // QA B9/B8 (docs/qa/2026-07-09-qa-round.md PR-B): the Status cell for a REJECTED row grows
  // two controls a normal row doesn't have: a (v) chevron that reveals a category picker
  // (reuses the exact PATCH shape the awaiting-category picker already uses — see
  // recategorizeBody) and a delete icon that permanently removes the bill in ONE CLICK, no
  // confirmation step (Owner explicit — do not add one here even though the drawer's own
  // delete uses a two-step confirm; B8 is deliberately different). tag lets the same builder
  // serve both the table <td> and the card <span> without duplicating the control markup.
  // Every click inside stops propagation so it never also fires the row/card's onOpen.
  function buildStatusCell(tag, r, categories, handlers) {
    var cell = el(tag, tag === 'td' ? 'act-td act-td--status' : 'act-card-status act-td--status');
    var text = el('span', 'act-status-text');
    Escape.setText(text, statusLabel(r.status));
    cell.appendChild(text);
    if (!isRejected(r)) return cell;

    var actions = el('span', 'act-status-actions');

    var chevron = el('button', 'act-status-chevron');
    chevron.type = 'button';
    chevron.title = 'Recategorise';
    chevron.setAttribute('aria-label', 'Recategorise this rejected bill');
    Escape.setText(chevron, '▾'); // ▾
    actions.appendChild(chevron);

    var picker = el('span', 'act-status-picker');
    picker.style.display = 'none';
    var select = el('select', 'act-status-picker-select');
    var cats = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
    cats.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); select.appendChild(o); });
    var apply = el('button', 'act-status-picker-apply'); apply.type = 'button'; Escape.setText(apply, 'Apply');
    var pst = el('span', 'act-status-picker-msg muted');
    picker.appendChild(select); picker.appendChild(apply); picker.appendChild(pst);
    actions.appendChild(picker);

    chevron.addEventListener('click', function (ev) {
      ev.stopPropagation();
      picker.style.display = picker.style.display === 'none' ? '' : 'none';
    });
    picker.addEventListener('click', function (ev) { ev.stopPropagation(); });
    apply.addEventListener('click', function (ev) {
      ev.stopPropagation();
      apply.disabled = true;
      Escape.setText(pst, 'Saving…');
      handlers.onRecategorize(r, select.value, pst, apply);
    });

    var del = el('button', 'act-status-delete');
    del.type = 'button';
    del.title = 'Delete permanently (no confirmation)';
    del.setAttribute('aria-label', 'Permanently delete this rejected bill');
    Escape.setText(del, '✖'); // ✖
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      del.disabled = true;
      handlers.onPermanentDelete(r, cell);
    });
    actions.appendChild(del);

    cell.appendChild(actions);
    return cell;
  }

  function buildTable(page, state, handlers) {
    var labels = columnLabels(state.fieldSpec);
    var table = el('table', 'act-table');
    var thead = el('thead');
    var htr = el('tr');
    // QA B4: a leading checkbox column, only present in select mode (tick-all lives in the
    // select bar above the table, not this header — see buildSelectBar).
    if (state.selectMode) htr.appendChild(textCell('th', 'act-th act-th--select', ''));
    htr.appendChild(textCell('th', 'act-th act-th--ref', 'Ref'));
    htr.appendChild(textCell('th', 'act-th', labels.merchant));
    htr.appendChild(sortableTh(labels.expense_date, 'date', state, handlers.onChange));
    htr.appendChild(sortableTh(labels.amount, 'amount', state, handlers.onChange));
    if (state.isAdmin) {
      htr.appendChild(textCell('th', 'act-th act-th--branch', 'Branch'));
      htr.appendChild(textCell('th', 'act-th act-th--staff', 'Staff'));
    }
    htr.appendChild(textCell('th', 'act-th', labels.category));
    htr.appendChild(textCell('th', 'act-th', labels.status));
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el('tbody');
    page.rows.forEach(function (r) {
      var tr = el('tr', 'act-row');
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');

      // QA B4: the row's tickbox. stopPropagation on click (not just change) so ticking a box
      // never also fires the row's onOpen (which opens the edit drawer).
      if (state.selectMode) {
        var selTd = el('td', 'act-td act-td--select');
        var rowCb = el('input', 'act-row-select');
        rowCb.type = 'checkbox';
        rowCb.checked = !!(state.selectedIds instanceof Set && state.selectedIds.has(r.id));
        rowCb.setAttribute('aria-label', 'Select this bill');
        rowCb.addEventListener('click', function (ev) { ev.stopPropagation(); });
        rowCb.addEventListener('change', function () { handlers.onToggleRow(r.id, rowCb.checked); });
        selTd.appendChild(rowCb);
        tr.appendChild(selTd);
      }

      // Reference number (RC-2026-0041). Falls back to '—' for a row that predates
      // the voucher migration (or if it's not applied yet) — never a blank cell.
      tr.appendChild(textCell('td', 'act-td act-td--ref', refDisplay(r)));

      var mCell = el('td', 'act-td act-td--merchant');
      mCell.appendChild(textCell('span', 'act-merchant', r.merchant));
      mCell.appendChild(badgeChips(r));
      tr.appendChild(mCell);

      tr.appendChild(textCell('td', 'act-td', r.expense_date));

      var amt = el('td', 'act-td act-td--amount');
      Escape.setText(amt, Format.formatMoney(r.amount) + ' ' + str(r.currency));
      tr.appendChild(amt);

      if (state.isAdmin) {
        tr.appendChild(textCell('td', 'act-td act-td--branch', displayBranchName(r, state.branchNames)));
        tr.appendChild(textCell('td', 'act-td act-td--staff', displayStaffName(r, state.staffNames)));
      }

      var cat = el('td', 'act-td');
      cat.appendChild(categoryCell(r));
      tr.appendChild(cat);

      tr.appendChild(buildStatusCell('td', r, state.categories, handlers));

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
  function buildCard(r, handlers, categories, selectState, directory) {
    var card = el('div', 'act-card');
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');

    // QA B4: same tickbox as the table row, top-left of the card. stopPropagation on click so
    // ticking never also opens the drawer.
    if (selectState && selectState.selectMode) {
      var cardCb = el('input', 'act-card-select');
      cardCb.type = 'checkbox';
      cardCb.checked = !!(selectState.selectedIds instanceof Set && selectState.selectedIds.has(r.id));
      cardCb.setAttribute('aria-label', 'Select this bill');
      cardCb.addEventListener('click', function (ev) { ev.stopPropagation(); });
      cardCb.addEventListener('change', function () { handlers.onToggleRow(r.id, cardCb.checked); });
      card.appendChild(cardCb);
    }

    if (hasReceiptImage(r)) {
      var thumbWrap = el('div', 'act-card-thumb');
      thumbWrap.appendChild(msg('act-receipt-msg muted', 'Loading…'));
      card.appendChild(thumbWrap);
      loadReceiptImage(r.id, thumbWrap, { imgClassName: 'act-card-thumb-image', alt: 'Receipt thumbnail', kind: receiptKind(r) });
    }

    var body = el('div', 'act-card-body');

    var head = el('div', 'act-card-head');
    head.appendChild(textCell('span', 'act-card-merchant', r.merchant));
    head.appendChild(categoryCell(r));
    body.appendChild(head);

    body.appendChild(badgeChips(r));

    var meta = el('div', 'act-card-meta');
    meta.appendChild(textCell('span', 'act-card-date', r.expense_date));
    var amt = el('span', 'act-card-amount');
    Escape.setText(amt, Format.formatMoney(r.amount) + ' ' + str(r.currency));
    meta.appendChild(amt);
    if (directory && directory.isAdmin) {
      meta.appendChild(textCell('span', 'act-card-branch', 'Branch: ' + displayBranchName(r, directory.branchNames)));
      meta.appendChild(textCell('span', 'act-card-staff', 'Staff: ' + displayStaffName(r, directory.staffNames)));
    }
    if (refDisplay(r) !== '—') meta.appendChild(textCell('span', 'act-card-ref muted', refDisplay(r)));
    body.appendChild(meta);

    body.appendChild(buildStatusCell('span', r, categories, handlers));

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

  function buildCardGrid(page, handlers, categories, selectState, directory) {
    var grid = el('div', 'act-card-grid');
    page.rows.forEach(function (r) { grid.appendChild(buildCard(r, handlers, categories, selectState, directory)); });
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

  function buildDrawer(rowObj, handlers, drawerOpts) {
    drawerOpts = drawerOpts || {};
    var categories = Array.isArray(drawerOpts.categories) ? drawerOpts.categories : DEFAULT_CATEGORIES;
    var fieldSpec = drawerOpts.fieldSpec;
    var labels = columnLabels(fieldSpec);

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

    // Reference number subtitle (read-only — assigned by the DB, never user-edited).
    if (refDisplay(rowObj) !== '—') drawer.appendChild(textCell('p', 'act-drawer-ref muted', 'Ref: ' + refDisplay(rowObj)));

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
        categories.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); input.appendChild(o); });
        input.value = str(rowObj[key]) || 'Others';
      } else if (key === 'status') {
        input = el('select', 'act-field-input');
        var cur = str(rowObj[key]);
        // Mirror the toolbar's human-facing set (STATUS_OPTIONS). If the row is
        // currently in an auto-only sentinel state (awaiting_category/awaiting_remark),
        // keep that as a selectable option too so opening the drawer never silently
        // reassigns it to 'saved' just because it wasn't in the list.
        var opts = STATUS_OPTIONS.indexOf(cur) === -1 ? STATUS_OPTIONS.concat([cur]) : STATUS_OPTIONS;
        opts.forEach(function (s) { var o = el('option'); o.value = s; Escape.setText(o, statusLabel(s)); input.appendChild(o); });
        input.value = cur;
      } else {
        input = el('input', 'act-field-input');
        input.type = type || 'text';
        if (type === 'number') input.step = 'any'; // amounts have cents; default step=1 rejects e.g. 21.20
        input.value = str(rowObj[key]);
      }
      input.addEventListener('input', function () { edited[key] = input.value; });
      input.addEventListener('change', function () { edited[key] = input.value; });
      wrap.appendChild(input);
      return wrap;
    }

    form.appendChild(field('merchant', labels.merchant));
    form.appendChild(field('expense_date', labels.expense_date));
    form.appendChild(field('amount', labels.amount, 'number'));
    form.appendChild(field('currency', 'Currency'));
    form.appendChild(field('category', labels.category));
    form.appendChild(field('status', labels.status));
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
    var items = lineItemDetails(rowObj);
    if (items.length) {
      var liWrap = el('div', 'act-lineitems');
      liWrap.appendChild(textCell('h4', 'act-lineitems-title', 'Line items'));
      var ul = el('ul', 'act-lineitems-list');
      items.forEach(function (it) {
        var li = el('li', 'act-lineitem');
        var desc = it.description;
        var amount = it && it.amount != null ? Format.formatMoney(it.amount) : '';
        var textSpan = el('span', 'act-lineitem-text');
        Escape.setText(textSpan, str(desc) + (amount ? '  —  ' + amount : ''));
        li.appendChild(textSpan);
        // Per-item category (spec 2026-07-04): each line carries its own category now, so a
        // mixed receipt shows a pill per line instead of one bucket for the whole receipt.
        // A categorizer-flagged (uncertain) line gets a subtle ⚠️ marker. Reuses the same
        // deterministic-colour pill as the row-level category.
        if (it.category) {
          var catPill = pill(it.category);
          catPill.classList.add('act-lineitem-cat');
          if (it.flagged) Escape.setText(catPill, str(it.category) + ' ⚠️');
          li.appendChild(catPill);
        }
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
    if (hasReceiptImage(rowObj)) {
      receipt.appendChild(textCell('span', 'act-receipt-label muted', receiptLabel(rowObj)));
      var imgWrap = el('div', 'act-receipt-image-wrap');
      var status2 = el('p', 'act-receipt-msg muted');
      Escape.setText(status2, 'Loading receipt image…');
      imgWrap.appendChild(status2);
      receipt.appendChild(imgWrap);
      loadReceiptImage(rowObj.id, imgWrap, { imgClassName: 'act-receipt-image', alt: 'Receipt image', kind: receiptKind(rowObj) });
    } else {
      receipt.appendChild(textCell('span', 'act-receipt-label muted', 'No receipt on file'));
    }
    drawer.appendChild(receipt);

    return drawer;
  }

  // ---- render: review queue ----------------------------------------------

  function buildReviewItem(rowObj, handlers) {
    var card = el('div', 'act-review-item');

    // Owner request 2026-07-10: show the receipt itself on the card so a decision can be made in
    // place. A thumbnail (image or a PDF link), loaded via the same auth'd fetch the table/cards
    // use. Clicking it opens the full detail drawer (handlers.onOpen) for a closer look.
    if (hasReceiptImage(rowObj)) {
      var thumbWrap = el('div', 'act-review-thumb');
      if (typeof handlers.onOpen === 'function') {
        thumbWrap.setAttribute('role', 'button');
        thumbWrap.setAttribute('tabindex', '0');
        thumbWrap.setAttribute('title', 'Open full receipt');
        thumbWrap.addEventListener('click', function () { handlers.onOpen(rowObj); });
        thumbWrap.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handlers.onOpen(rowObj); }
        });
      }
      thumbWrap.appendChild(msg('act-receipt-msg muted', 'Loading…'));
      card.appendChild(thumbWrap);
      loadReceiptImage(rowObj.id, thumbWrap, { imgClassName: 'act-review-thumb-image', alt: 'Receipt image', kind: receiptKind(rowObj) });
    }

    var main = el('div', 'act-review-main');

    var mCell = textCell('span', 'act-review-merchant', rowObj.merchant);
    main.appendChild(mCell);
    var amt = el('span', 'act-review-amount');
    Escape.setText(amt, Format.formatMoney(rowObj.amount) + ' ' + str(rowObj.currency));
    main.appendChild(amt);

    // Key fields (date · category · ref) so the receipt is identifiable at a glance.
    var parts = reviewMetaParts(rowObj);
    if (parts.length) main.appendChild(textCell('p', 'act-review-meta muted', parts.join(' · ')));

    // The staff/OCR remark often explains the expense — helpful context for the decision.
    if (rowObj.remark) {
      var remark = el('p', 'act-review-remark');
      Escape.setText(remark, rowObj.remark);                              // untrusted -> textContent
      remark.setAttribute('title', Escape.stripControls(str(rowObj.remark)));
      main.appendChild(remark);
    }

    var reason = anomalyReasonText(rowObj.anomaly);
    main.appendChild(textCell('p', 'act-review-reason', reason));  // untrusted reason -> escaped

    var actions = el('div', 'act-review-actions');
    var approve = el('button', 'act-review-approve'); approve.type = 'button'; Escape.setText(approve, 'Approve');
    var reject = el('button', 'act-review-reject'); reject.type = 'button'; Escape.setText(reject, 'Reject');
    var st = el('span', 'act-review-msg muted');
    approve.addEventListener('click', function () { handlers.onDecide(rowObj, 'approve', card, st); });
    reject.addEventListener('click', function () { handlers.onDecide(rowObj, 'reject', card, st); });
    actions.appendChild(approve); actions.appendChild(reject); actions.appendChild(st);
    main.appendChild(actions);

    card.appendChild(main);
    return card;
  }

  // ---- render: awaiting-category picker (dashboard parity of the bot's #74 picker) ----
  // A row the pipeline saved but couldn't confidently categorize. The bot asks via inline
  // buttons; on the dashboard the user picks from a dropdown and we resolve via the SAME
  // PATCH /api/expenses/:id the edit drawer uses (category + status:'saved'), which is
  // already checkDash-authed + account-scoped — the dashboard equivalent of the bot's
  // confirm-time ownership check. All untrusted text (merchant) via Escape.setText.
  function buildAwaitingItem(rowObj, categories, handlers) {
    var card = el('div', 'act-await-item');
    card.appendChild(textCell('span', 'act-await-merchant', rowObj.merchant));
    var amt = el('span', 'act-await-amount');
    Escape.setText(amt, Format.formatMoney(rowObj.amount) + ' ' + str(rowObj.currency));
    card.appendChild(amt);
    card.appendChild(textCell('p', 'act-await-note muted', 'Pick a category for this receipt:'));

    var actions = el('div', 'act-await-actions');
    var select = el('select', 'act-await-select');
    var cats = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
    cats.forEach(function (c) { var o = el('option'); o.value = c; Escape.setText(o, c); select.appendChild(o); });
    var save = el('button', 'act-await-save'); save.type = 'button'; Escape.setText(save, 'Save category');
    var st = el('span', 'act-await-msg muted');
    save.addEventListener('click', function () { handlers.onPick(rowObj, select.value, card, st, save); });
    actions.appendChild(select); actions.appendChild(save); actions.appendChild(st);
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
    var isAdmin = !!(opts.session && opts.session.role === 'admin');

    var rootEl = el('div', 'act-root');
    section.appendChild(rootEl);

    // Sub-mounts: table area, drawer host, awaiting-category picker, review area.
    var tableArea = el('div', 'act-table-area');
    var drawerHost = el('div', 'act-drawer-host');
    // QA B7 (docs/qa/2026-07-09-qa-round.md PR-B): the "Recently deleted" bin. Reuses the exact
    // same modal-overlay CSS as drawerHost (class act-drawer-host) — same backdrop, same
    // centered-card mechanics — just a different host element so opening one never clobbers
    // the other's content.
    var deletedHost = el('div', 'act-drawer-host');
    rootEl.appendChild(tableArea);
    rootEl.appendChild(drawerHost);
    rootEl.appendChild(deletedHost);
    // Awaiting-category picker (dashboard parity of the bot #74 picker). Heading + area are
    // hidden entirely when nothing is pending (an exception state, not a standing queue).
    var awaitHead = textCell('h3', 'act-await-title', 'Needs a category');
    var awaitArea = el('div', 'act-await-area');
    rootEl.appendChild(awaitHead);
    rootEl.appendChild(awaitArea);
    var reviewArea = el('div', 'act-review-area');
    var reviewHead = textCell('h3', 'act-review-title', 'Review queue');
    rootEl.appendChild(reviewHead);
    // Discoverability fix (QA report #7): nothing is ever deleted by Approve/Reject —
    // both just set a status. Nobody knew that, so a mis-click felt like data loss.
    rootEl.appendChild(msg('act-review-note muted',
      'Approve or Reject just changes the status — nothing is deleted. Find any decision later in Activity → status filter (Approved / Rejected) to undo it.'));
    rootEl.appendChild(reviewArea);

    // DYNAMIC CATEGORIES: reuse the config already fetched at boot (app.js's
    // deps.config, set once GET /api/config resolves) rather than issuing a
    // second, redundant /api/config call here. If boot's fetch hasn't resolved
    // yet (or failed) opts.config is absent/undefined and resolveCategories
    // falls back to DEFAULT_CATEGORIES — never an empty dropdown, never a throw.
    var state = {
      loaded: false, loading: false, rows: [],
      search: '', filterStatus: 'all', filterCategory: 'all', filterBranch: isAdmin ? 'mine' : 'all', dateFrom: '', dateTo: '',
      sortBy: 'date', sortDir: 'desc', page: 1, pageSize: DEFAULT_PAGE_SIZE,
      viewMode: getStoredViewMode(storageRoot),
      categories: resolveCategories(opts.config),
      fieldSpec: null,
      isAdmin: isAdmin, session: opts.session || null,
      sessionBranchId: opts.session && opts.session.branch_id != null ? opts.session.branch_id : null,
      branches: [], branchNames: {}, staffNames: {},
      // QA B4: bulk select -> Approve/Delete.
      selectMode: false, selectedIds: new Set(), bulkStatus: '',
    };
    var reviewState = { loading: false, loaded: false, rows: [] };

    // ---- QA B4: bulk select handlers ----------------------------------------
    var selectHandlers = {
      onEnterSelectMode: function () {
        state.selectMode = true; state.selectedIds = new Set(); state.bulkStatus = '';
        renderTable();
      },
      onExitSelectMode: function () {
        state.selectMode = false; state.selectedIds = new Set(); state.bulkStatus = '';
        renderTable();
      },
      onToggleRow: function (id, checked) {
        var next = new Set(state.selectedIds);
        if (checked) next.add(id); else next.delete(id);
        state.selectedIds = next;
        renderTable();
      },
      onToggleAllRows: function (pageIds, checked) {
        state.selectedIds = toggleAllSelected(pageIds, state.selectedIds, checked);
        renderTable();
      },
      onBulkApprove: function () { runBulkAction('approve'); },
      onBulkDelete: function () { runBulkAction('delete'); },
    };

    // Shared by Approve and Delete: confirm, then fire the matching bulk endpoint. Both reuse
    // the exact per-row business rules the single-row routes already enforce (routes/review.js
    // POST /api/review/bulk, routes/expenses.js POST /api/expenses/bulk-delete) — a row this
    // caller can't touch just fails individually in the response, it never aborts the batch.
    function runBulkAction(action) {
      var ids = Array.from(state.selectedIds instanceof Set ? state.selectedIds : []);
      if (!ids.length || !apiFetch) return;
      var plural = ids.length === 1 ? 'bill' : 'bills';
      var message = action === 'approve'
        ? 'Approve ' + ids.length + ' selected ' + plural + '?'
        : 'Delete ' + ids.length + ' selected ' + plural + '?';
      showBulkConfirm(message, action === 'approve' ? 'Approve' : 'Delete', function () {
        state.bulkStatus = action === 'approve' ? 'Approving…' : 'Deleting…';
        renderTable();
        var req = action === 'approve'
          ? apiFetch(bulkApprovePath(), { method: 'POST', body: { ids: ids, decision: 'approve' } })
          : apiFetch(bulkDeletePath(), { method: 'POST', body: { ids: ids } });
        req.then(function (json) {
          state.bulkStatus = summarizeBulkResult(json, action === 'approve' ? 'approved' : 'deleted');
          state.selectMode = false;
          state.selectedIds = new Set();
          load(true); // refresh from the server so approved/deleted rows reflect immediately
        }).catch(function () {
          state.bulkStatus = 'Bulk ' + action + ' failed. Please try again.';
          renderTable();
        });
      });
    }

    function renderTable() {
      var focused = captureFocus(tableArea);
      clear(tableArea);
      if (state.loading) { tableArea.appendChild(msg('act-loading muted', 'Loading expenses…')); return; }
      if (state.error) { tableArea.appendChild(msg('act-error', 'Could not load your expenses. Please try again shortly.')); return; }
      var toolbarEl = buildToolbar(state, onChange);
      toolbarEl.appendChild(buildBinButton());
      tableArea.appendChild(toolbarEl);
      restoreFocus(tableArea, focused); // must run right after the toolbar exists, before any early return below
      tableArea.appendChild(buildViewToggle(state, onChange));
      renderAwaiting(); // independent of table filters/pagination — reflects ALL pending rows
      var pageData = filterSortPage(state.rows, state);
      var pageIds = pageData.rows.map(function (r) { return r.id; });
      tableArea.appendChild(buildSelectBar(state, pageIds, selectHandlers));
      if (pageData.total === 0) {
        tableArea.appendChild(msg('act-empty muted', state.rows.length ? 'No expenses match your filters.' : 'No expenses yet. Send a receipt to your Telegram bot to get started.'));
        return;
      }
      var rowHandlers = {
        onOpen: openDrawer,
        onRecategorize: onRecategorizeRejected,
        onPermanentDelete: onPermanentDelete,
      };
      if (state.viewMode === 'cards') {
        tableArea.appendChild(buildCardGrid(pageData,
          Object.assign({ onToggleRow: selectHandlers.onToggleRow }, rowHandlers),
          state.categories,
          { selectMode: state.selectMode, selectedIds: state.selectedIds },
          { isAdmin: state.isAdmin, branchNames: state.branchNames, staffNames: state.staffNames }));
      } else {
        tableArea.appendChild(buildTable(pageData, state,
          Object.assign({ onChange: onChange, onToggleRow: selectHandlers.onToggleRow }, rowHandlers)));
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

    // The drawer now renders as a centered modal popup (drawerHost is a fixed
    // full-screen overlay in CSS — see .act-drawer-host) instead of appending
    // inline after the table, which used to force a scroll down the page to
    // see it. Closes via the × button, clicking the dimmed backdrop, or Esc.
    function onDrawerKeydown(ev) { if (ev.key === 'Escape') closeDrawer(); }

    function closeDrawer() {
      clear(drawerHost);
      document.removeEventListener('keydown', onDrawerKeydown);
    }

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
      }, { categories: state.categories, fieldSpec: state.fieldSpec }));
      document.addEventListener('keydown', onDrawerKeydown);
    }

    // Click on the dimmed backdrop itself (not a bubbled click from inside the
    // dialog) closes the modal — the standard "click outside to dismiss" affordance.
    drawerHost.addEventListener('click', function (ev) {
      if (ev.target === drawerHost) closeDrawer();
    });

    // ---- "Recently deleted" bin + Recover (QA B7) ---------------------------
    var deletedState = { loading: false, loaded: false, rows: [], error: false };
    var deletedListArea = null;

    function buildBinButton() {
      var btn = el('button', 'act-bin-btn');
      btn.type = 'button';
      btn.title = 'Recently deleted';
      btn.setAttribute('aria-label', 'View recently deleted bills');
      Escape.setText(btn, '🗑 Recently deleted'); // trash-can + label
      btn.addEventListener('click', openDeletedPanel);
      return btn;
    }

    function buildDeletedItem(rowObj, handlers) {
      // Wrapped in a plain block (act-deleted-row) rather than added as a 6th grid child:
      // .act-deleted-item is a fixed 4-column grid (merchant/amount/date/recover, +msg span
      // wrapping to row 2) — inserting another child would shift the recover button/message
      // onto unexpected rows. The reminder line sits BELOW the untouched item, in its own row;
      // .act-deleted-list's flex gap already applies to any direct child, so spacing is unaffected.
      var row = el('div', 'act-deleted-row');
      var item = el('div', 'act-deleted-item');
      item.appendChild(textCell('span', 'act-deleted-merchant', rowObj.merchant));
      var amt = el('span', 'act-deleted-amount');
      Escape.setText(amt, Format.formatMoney(rowObj.amount) + ' ' + str(rowObj.currency));
      item.appendChild(amt);
      item.appendChild(textCell('span', 'act-deleted-date muted', rowObj.expense_date));
      var recover = el('button', 'act-deleted-recover'); recover.type = 'button'; Escape.setText(recover, 'Recover');
      var st = el('span', 'act-deleted-msg muted');
      recover.addEventListener('click', function () { handlers.onRecover(rowObj, st, recover); });
      item.appendChild(recover);
      item.appendChild(st);
      row.appendChild(item);
      // QA 2026-07-13: display-only reminder of when this bill would age out under the
      // stated retention policy (see purgeReminderDate's own comment — no auto-purge job
      // exists yet). Omitted entirely for a row with no/invalid deleted_at.
      var reminder = purgeReminderDate(rowObj.deleted_at);
      if (reminder) row.appendChild(textCell('div', 'act-deleted-purge muted', 'Permanently removed on ' + reminder));
      return row;
    }

    function renderDeletedList() {
      if (!deletedListArea) return;
      clear(deletedListArea);
      if (deletedState.loading) { deletedListArea.appendChild(msg('act-loading muted', 'Loading…')); return; }
      if (deletedState.error) { deletedListArea.appendChild(msg('act-error', 'Could not load recently deleted bills.')); return; }
      if (!deletedState.rows.length) {
        deletedListArea.appendChild(msg('act-empty muted', 'Nothing here — bills you delete show up in this list and can be recovered.'));
        return;
      }
      deletedState.rows.forEach(function (r) {
        deletedListArea.appendChild(buildDeletedItem(r, {
          onRecover: function (rowObj, st, btn) {
            btn.disabled = true;
            Escape.setText(st, 'Restoring…');
            apiFetch(restorePath(rowObj.id), { method: 'POST' })
              .then(function () {
                deletedState.rows = deletedState.rows.filter(function (x) { return x.id !== rowObj.id; });
                renderDeletedList();
                load(true); // refresh the main table so the recovered bill reappears there
              })
              .catch(function () { btn.disabled = false; Escape.setText(st, 'Restore failed. Please try again.'); });
          },
        }));
      });
    }

    function loadDeleted() {
      if (deletedState.loading || !apiFetch) return;
      deletedState.loading = true; deletedState.error = false; renderDeletedList();
      apiFetch(deletedRowsPath()).then(function (rows) {
        deletedState.loading = false; deletedState.loaded = true;
        deletedState.rows = Array.isArray(rows) ? rows : [];
        renderDeletedList();
      }).catch(function () { deletedState.loading = false; deletedState.error = true; renderDeletedList(); });
    }

    function closeDeletedPanel() {
      clear(deletedHost);
      deletedListArea = null;
      document.removeEventListener('keydown', onDeletedKeydown);
    }

    function onDeletedKeydown(ev) { if (ev.key === 'Escape') closeDeletedPanel(); }

    function openDeletedPanel() {
      clear(deletedHost);
      var wrap = el('div', 'act-drawer');
      var head = el('div', 'act-drawer-head');
      head.appendChild(textCell('h3', 'act-drawer-title', 'Recently deleted'));
      var close = el('button', 'act-drawer-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      Escape.setText(close, '×'); // ×
      close.addEventListener('click', closeDeletedPanel);
      head.appendChild(close);
      wrap.appendChild(head);
      wrap.appendChild(msg('act-await-note muted', 'Bills deleted from Activity land here and can be recovered.'));
      deletedListArea = el('div', 'act-deleted-list');
      wrap.appendChild(deletedListArea);
      deletedHost.appendChild(wrap);
      document.addEventListener('keydown', onDeletedKeydown);
      renderDeletedList(); // show loading state immediately, even before the fetch resolves
      loadDeleted();
    }

    deletedHost.addEventListener('click', function (ev) {
      if (ev.target === deletedHost) closeDeletedPanel();
    });

    // QA B9 (docs/qa/2026-07-09-qa-round.md PR-B): recategorising a rejected bill via the
    // Status-column chevron. Same PATCH shape + status:'saved' resolution as the
    // awaiting-category picker (recategorizeBody) — a recategorised rejected bill becomes an
    // ordinary saved row, out of the Rejected filter.
    function onRecategorizeRejected(rowObj, category, statusEl, applyBtn) {
      if (!category) { Escape.setText(statusEl, 'Pick a category first.'); applyBtn.disabled = false; return; }
      var body = recategorizeBody(category);
      apiFetch('/api/expenses/' + encodeURIComponent(rowObj.id), { method: 'PATCH', body: body })
        .then(function (updated) {
          var idx = state.rows.findIndex(function (x) { return x.id === rowObj.id; });
          if (idx !== -1) state.rows[idx] = Object.assign({}, state.rows[idx], body, updated && typeof updated === 'object' ? updated : {});
          renderTable();
        })
        .catch(function () { applyBtn.disabled = false; Escape.setText(statusEl, 'Save failed. Please try again.'); });
    }

    // QA B8: ONE CLICK, no confirmation (Owner explicit) — this fires the DELETE the instant
    // the icon is clicked, unlike the drawer's two-step confirm delete above.
    function onPermanentDelete(rowObj, cellEl) {
      apiFetch(permanentDeletePath(rowObj.id), { method: 'DELETE' })
        .then(function () {
          state.rows = state.rows.filter(function (x) { return x.id !== rowObj.id; });
          renderTable();
        })
        .catch(function () {
          var btn = cellEl && typeof cellEl.querySelector === 'function' ? cellEl.querySelector('.act-status-delete') : null;
          if (btn) btn.disabled = false;
        });
    }

    // Awaiting-category picker: derived live from the loaded expenses (no extra fetch).
    // Hidden entirely when nothing is pending. Resolves via the same PATCH the drawer uses.
    function renderAwaiting() {
      clear(awaitArea);
      var rows = awaitingCategoryRows(state.rows);
      var show = rows.length > 0;
      awaitHead.style.display = show ? '' : 'none';
      awaitArea.style.display = show ? '' : 'none';
      if (!show) return;
      rows.forEach(function (r) {
        awaitArea.appendChild(buildAwaitingItem(r, state.categories, {
          onPick: function (rowObj, category, card, st, saveBtn) {
            if (!category) { Escape.setText(st, 'Pick a category first.'); return; }
            saveBtn.disabled = true;
            Escape.setText(st, 'Saving…');
            apiFetch('/api/expenses/' + encodeURIComponent(rowObj.id), { method: 'PATCH', body: { category: category, status: 'saved' } })
              .then(function (updated) {
                var idx = state.rows.findIndex(function (x) { return x.id === rowObj.id; });
                if (idx !== -1) state.rows[idx] = Object.assign({}, state.rows[idx], { category: category, status: 'saved' }, updated && typeof updated === 'object' ? updated : {});
                renderTable(); // re-renders the table AND (via its call) this picker
              })
              .catch(function () { saveBtn.disabled = false; Escape.setText(st, 'Save failed. Please try again.'); });
          },
        }));
      });
    }

    function renderReview() {
      clear(reviewArea);
      if (reviewState.loading) { reviewArea.appendChild(msg('act-loading muted', 'Loading review queue…')); return; }
      if (reviewState.error) { reviewArea.appendChild(msg('act-error', 'Could not load the review queue.')); return; }
      if (!reviewState.rows.length) { reviewArea.appendChild(msg('act-empty muted', 'Nothing to review. 🎉')); return; }
      reviewState.rows.forEach(function (r) {
        reviewArea.appendChild(buildReviewItem(r, {
          onOpen: openDrawer, // clicking the receipt thumbnail opens the full detail drawer
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
              .catch(function (err) { Escape.setText(st, decisionErrorText(err)); });
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

    // FieldSpec-aware labels (Task: dynamic categories + FieldSpec labels): fetch
    // the account's current field template the same way templates.js does
    // (Api.apiFetch('/api/templates'), always-200 per lib/templates.js). On
    // success, build the key->label lookup used by columnLabels()/buildDrawer.
    // On failure, state.fieldSpec stays null and labelFor's fallback (the
    // current hardcoded English labels) is used everywhere — never a throw,
    // never a blocked render.
    function loadFieldSpec() {
      if (!apiFetch) return;
      apiFetch('/api/templates').then(function (spec) {
        state.fieldSpec = spec && typeof spec === 'object' ? spec : null;
        renderTable();
      }).catch(function () { /* keep state.fieldSpec null -> fallback labels */ });
    }

    // Admin-only directory enrichment. Branches are fetched once per Activity
    // mount; staff directories are fetched from the existing branch-scoped
    // endpoint and cached into the same ID->label maps. Any failure leaves raw
    // IDs visible rather than blank cells or a blocked Activity screen.
    function loadDirectory() {
      if (!state.isAdmin || state.directoryLoading || state.directoryLoaded || !apiFetch) return;
      state.directoryLoading = true;
      apiFetch('/api/branches').then(function (resp) {
        var branches = resp && Array.isArray(resp.branches) ? resp.branches : (Array.isArray(resp) ? resp : []);
        state.branches = branches;
        state.branchNames = branchNamesFromResponse(branches);
        return Promise.all(branches.map(function (branch) {
          if (!branch || branch.id == null || branch.id === '') return Promise.resolve([]);
          return apiFetch('/api/branches/' + encodeURIComponent(branch.id) + '/staff')
            .then(function (staffResp) { return staffNamesFromResponse(staffResp); })
            .catch(function () { return {}; });
        }));
      }).then(function (staffMaps) {
        var names = {};
        (Array.isArray(staffMaps) ? staffMaps : []).forEach(function (map) {
          Object.keys(map || {}).forEach(function (id) { names[id] = map[id]; });
        });
        state.staffNames = names;
      }).catch(function () {
        // Keep row-only IDs usable even when the directory is unavailable.
        state.branches = [];
      }).then(function () {
        state.directoryLoading = false;
        state.directoryLoaded = true;
        renderTable();
      });
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
      loadDirectory();
      loadReview();
      loadFieldSpec();
    }

    return { el: rootEl, load: load };
  }

  return {
    // pure
    filterSortPage: filterSortPage,
    badgesFor: badgesFor,
    categoryColor: categoryColor,
    mixedCategoryLabel: mixedCategoryLabel,
    lineItemDetails: lineItemDetails,
    branchNamesFromResponse: branchNamesFromResponse,
    staffNamesFromResponse: staffNamesFromResponse,
    activityBranchOptions: activityBranchOptions,
    displayBranchName: displayBranchName,
    displayStaffName: displayStaffName,
    resolveCategories: resolveCategories,
    labelFor: labelFor,
    awaitingCategoryRows: awaitingCategoryRows,
    refDisplay: refDisplay,
    anomalyReasonText: anomalyReasonText,
    patchBody: patchBody,
    bulkApprovePath: bulkApprovePath,
    bulkDeletePath: bulkDeletePath,
    allSelected: allSelected,
    toggleAllSelected: toggleAllSelected,
    summarizeBulkResult: summarizeBulkResult,
    deletedRowsPath: deletedRowsPath,
    restorePath: restorePath,
    purgeReminderDate: purgeReminderDate,
    DELETED_RETENTION_DAYS: DELETED_RETENTION_DAYS,
    isRejected: isRejected,
    recategorizeBody: recategorizeBody,
    permanentDeletePath: permanentDeletePath,
    receiptPath: receiptPath,
    receiptByIdPath: receiptByIdPath,
    hasReceiptImage: hasReceiptImage,
    receiptKind: receiptKind,
    receiptLabel: receiptLabel,
    receiptErrorMessage: receiptErrorMessage,
    reviewMetaParts: reviewMetaParts,
    normaliseViewMode: normaliseViewMode,
    statusLabel: statusLabel,
    decisionErrorText: decisionErrorText,
    // render (browser)
    mount: mount,
  };
});
