// exportGuards.js — shared guardrails for any dashboard data extract.
//
// PR-A QA requirements:
//   - zero-row views must not export; show "No data to export."
//   - every non-empty extract asks the user to confirm they reviewed the data first.
// Kept tiny and UMD-style so Reports/Payments can share one behaviour without a build step.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./escape'));
  else root.ExportGuards = factory(root.Escape);
})(typeof self !== 'undefined' ? self : this, function (Escape) {
  'use strict';

  var NO_DATA_MESSAGE = 'No data to export.';
  var CONFIRM_REVIEW_MESSAGE = "Confirm you've reviewed this data before exporting?";
  // A3 refinement (Owner 2026-07-10): the reminder is now CONDITIONAL — it only fires when there
  // are receipts still sitting in the review queue (status 'needs_review'). REVIEW_QUEUE_PATH is
  // the scoped endpoint the count comes from (clerk = own branch, admin = all).
  var REVIEW_QUEUE_PATH = '/api/review';

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function hasExtractData(data) {
    if (Array.isArray(data)) return data.length > 0;
    if (typeof data === 'number' || typeof data === 'string') return toNum(data) > 0;
    if (!data || typeof data !== 'object') return false;
    if ('count' in data) return toNum(data.count) > 0;
    if (Array.isArray(data.rows)) return data.rows.length > 0;
    return false;
  }

  function exportGate(opts) {
    opts = opts || {};
    if (!hasExtractData(opts.data)) return { ok: false, needsConfirm: false, message: NO_DATA_MESSAGE };
    if (!opts.confirmed) return { ok: false, needsConfirm: true, message: CONFIRM_REVIEW_MESSAGE };
    return { ok: true };
  }

  // A3: how many receipts are still awaiting review (status 'needs_review'). The review-queue
  // endpoint already returns only needs_review rows, but filtering by status keeps this correct
  // even if fed a general expense list. Pure; tolerant of non-arrays/garbage.
  function countUnreviewed(rows) {
    if (!Array.isArray(rows)) return 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].status === 'needs_review') n++;
    }
    return n;
  }

  // A3: the reminder text, plural-aware. Kept pure so the exact wording is unit-tested.
  function reviewReminderMessage(count) {
    var n = Number(count) || 0;
    var noun = n === 1 ? 'receipt' : 'receipts';
    return 'You still have ' + n + ' ' + noun + ' waiting for review in Activity. Download anyway?';
  }

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function setText(node, text) {
    if (Escape && typeof Escape.setText === 'function') Escape.setText(node, text);
    else node.textContent = text == null ? '' : String(text);
  }

  function requestReviewedConfirmation(onConfirm, opts) {
    if (!hasDom()) return false;
    opts = opts || {};
    var backdrop = el('div', opts.hostClass || 'rp-confirm-host');
    var card = el('div', opts.cardClass || 'rp-confirm-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var title = el('p', opts.titleClass || 'rp-confirm-title');
    // A3: the caller may pass a specific reminder (e.g. "You still have 3 receipts…"); default to
    // the generic reviewed-confirm text so old call sites / the error fallback are unchanged.
    setText(title, opts.message || CONFIRM_REVIEW_MESSAGE);
    card.appendChild(title);

    var actions = el('div', opts.actionsClass || 'rp-confirm-choices');
    var confirm = el('button', opts.confirmClass || 'rp-confirm-choice');
    confirm.type = 'button';
    setText(confirm, opts.confirmLabel || 'Confirm');
    var cancel = el('button', opts.cancelClass || 'rp-confirm-cancel');
    cancel.type = 'button';
    setText(cancel, opts.cancelLabel || 'Cancel');
    actions.appendChild(confirm);
    actions.appendChild(cancel);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    function onKeydown(ev) { if (ev.key === 'Escape') close(false); }
    function close(run) {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      document.removeEventListener('keydown', onKeydown);
      if (run && typeof onConfirm === 'function') onConfirm();
    }
    confirm.addEventListener('click', function () { close(true); });
    cancel.addEventListener('click', function () { close(false); });
    backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(false); });
    document.addEventListener('keydown', onKeydown);
    return true;
  }

  // A3 orchestrator (Owner 2026-07-10): the single entry point all three export buttons call.
  //   opts.data      — same empty-export guard input as exportGate (rows / {count} / {rows}).
  //   opts.apiFetch  — Api.apiFetch, used to count the scoped review queue.
  //   opts.onEmpty(message)  — called when there's nothing to export.
  //   opts.onProceed()       — runs the actual export (directly, or after "Download anyway").
  //   opts.confirm   — DI seam for the modal (defaults to requestReviewedConfirmation; tests
  //                    inject a fake so the decision logic is exercisable without a DOM).
  // Behaviour: empty -> onEmpty. Otherwise count needs_review receipts —
  //   0 unreviewed        -> onProceed() immediately, NO popup (the whole point of A3);
  //   >0 unreviewed       -> reminder popup with the count + a non-blocking "Download anyway";
  //   count unknown (no apiFetch, or the fetch failed) -> generic reviewed-confirm fallback, so
  //   there is always SOME checkpoint and we never block or silently skip the reminder on error.
  function runExportGuard(opts) {
    opts = opts || {};
    var onEmpty = typeof opts.onEmpty === 'function' ? opts.onEmpty : function () {};
    var onProceed = typeof opts.onProceed === 'function' ? opts.onProceed : function () {};
    var confirmFn = typeof opts.confirm === 'function' ? opts.confirm : requestReviewedConfirmation;

    if (!hasExtractData(opts.data)) { onEmpty(NO_DATA_MESSAGE); return; }

    function genericConfirm() { confirmFn(onProceed, { message: CONFIRM_REVIEW_MESSAGE, confirmLabel: 'Confirm and export' }); }

    var apiFetch = typeof opts.apiFetch === 'function' ? opts.apiFetch : null;
    if (!apiFetch) { genericConfirm(); return; }

    Promise.resolve(apiFetch(REVIEW_QUEUE_PATH)).then(function (rows) {
      var n = countUnreviewed(rows);
      if (n === 0) { onProceed(); return; }
      confirmFn(onProceed, {
        message: reviewReminderMessage(n),
        confirmLabel: 'Download anyway',
        cancelLabel: 'Go review',
      });
    }).catch(function () { genericConfirm(); });
  }

  return {
    NO_DATA_MESSAGE: NO_DATA_MESSAGE,
    CONFIRM_REVIEW_MESSAGE: CONFIRM_REVIEW_MESSAGE,
    REVIEW_QUEUE_PATH: REVIEW_QUEUE_PATH,
    hasExtractData: hasExtractData,
    exportGate: exportGate,
    countUnreviewed: countUnreviewed,
    reviewReminderMessage: reviewReminderMessage,
    requestReviewedConfirmation: requestReviewedConfirmation,
    runExportGuard: runExportGuard,
  };
});
