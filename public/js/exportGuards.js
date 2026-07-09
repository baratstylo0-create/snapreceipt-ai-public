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
    setText(title, CONFIRM_REVIEW_MESSAGE);
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

  return {
    NO_DATA_MESSAGE: NO_DATA_MESSAGE,
    CONFIRM_REVIEW_MESSAGE: CONFIRM_REVIEW_MESSAGE,
    hasExtractData: hasExtractData,
    exportGate: exportGate,
    requestReviewedConfirmation: requestReviewedConfirmation,
  };
});
