'use strict';
// Shared export/extract guard logic for PR-A:
// - empty views must not export ("No data to export.")
// - non-empty extracts must ask the user to confirm they reviewed the data first.
const test = require('node:test');
const assert = require('node:assert');
const Guards = require('../../public/js/exportGuards');

test('hasExtractData: report-shaped objects use count > 0', () => {
  assert.strictEqual(Guards.hasExtractData({ count: 1 }), true);
  assert.strictEqual(Guards.hasExtractData({ count: '2' }), true);
  assert.strictEqual(Guards.hasExtractData({ count: 0 }), false);
  assert.strictEqual(Guards.hasExtractData({ count: '0' }), false);
});

test('hasExtractData: arrays use length; garbage is empty', () => {
  assert.strictEqual(Guards.hasExtractData([{}]), true);
  assert.strictEqual(Guards.hasExtractData([]), false);
  assert.strictEqual(Guards.hasExtractData(null), false);
  assert.strictEqual(Guards.hasExtractData({}), false);
});

test('exportGate: empty data blocks before confirmation', () => {
  const out = Guards.exportGate({ data: { count: 0 }, confirmed: true });
  assert.deepStrictEqual(out, { ok: false, needsConfirm: false, message: Guards.NO_DATA_MESSAGE });
});

test('exportGate: non-empty data asks for review confirmation before extracting', () => {
  const out = Guards.exportGate({ data: { count: 1 }, confirmed: false });
  assert.deepStrictEqual(out, { ok: false, needsConfirm: true, message: Guards.CONFIRM_REVIEW_MESSAGE });
});

test('exportGate: non-empty confirmed data may proceed', () => {
  assert.deepStrictEqual(Guards.exportGate({ data: [{ id: 'e1' }], confirmed: true }), { ok: true });
});

// --- A3 refinement (Owner 2026-07-10): the pre-export reminder is now CONDITIONAL. Instead of
// an always-on generic "did you review?" modal, it only warns when there are receipts still in
// the review queue (status 'needs_review'), tells the user how many, and offers a non-blocking
// "Download anyway". Zero unreviewed -> export runs with no popup at all.

test('countUnreviewed: counts only needs_review rows', () => {
  const rows = [
    { id: 'a', status: 'needs_review' },
    { id: 'b', status: 'approved' },
    { id: 'c', status: 'needs_review' },
    { id: 'd', status: 'saved' },
  ];
  assert.strictEqual(Guards.countUnreviewed(rows), 2);
});

test('countUnreviewed: empty / non-array / garbage is 0, never throws', () => {
  assert.strictEqual(Guards.countUnreviewed([]), 0);
  assert.strictEqual(Guards.countUnreviewed(null), 0);
  assert.strictEqual(Guards.countUnreviewed(undefined), 0);
  assert.strictEqual(Guards.countUnreviewed('nope'), 0);
  assert.strictEqual(Guards.countUnreviewed([null, 1, {}]), 0);
});

test('reviewReminderMessage: singular vs plural, includes the count', () => {
  const one = Guards.reviewReminderMessage(1);
  assert.ok(one.indexOf('1 receipt') !== -1, 'mentions "1 receipt": ' + one);
  assert.ok(one.indexOf('receipts') === -1, 'no plural s for 1: ' + one);
  const many = Guards.reviewReminderMessage(3);
  assert.ok(many.indexOf('3 receipts') !== -1, 'mentions "3 receipts": ' + many);
});

// runExportGuard is the shared orchestrator all three export buttons call. It's DOM-free-testable
// by injecting a fake `confirm` (the real one needs a browser) and a fake `apiFetch`.
function fakeConfirm(captured) {
  return function (onConfirm, opts) {
    captured.push({ opts: opts });
    captured.onConfirm = onConfirm; // let the test decide whether to "click Download anyway"
    return true;
  };
}

test('runExportGuard: empty data -> onEmpty, never fetches or prompts', async () => {
  let proceeded = false; let emptyMsg = null; let fetched = false;
  const captured = [];
  Guards.runExportGuard({
    data: [],
    apiFetch: function () { fetched = true; return Promise.resolve([]); },
    onEmpty: function (m) { emptyMsg = m; },
    onProceed: function () { proceeded = true; },
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(emptyMsg, Guards.NO_DATA_MESSAGE);
  assert.strictEqual(proceeded, false);
  assert.strictEqual(fetched, false, 'must not even hit the review endpoint for an empty export');
  assert.strictEqual(captured.length, 0);
});

test('runExportGuard: data + ZERO unreviewed -> exports immediately, NO popup', async () => {
  let proceeded = false;
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    apiFetch: function (path) { assert.strictEqual(path, '/api/review'); return Promise.resolve([]); },
    onEmpty: function () { throw new Error('should not be empty'); },
    onProceed: function () { proceeded = true; },
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(proceeded, true, 'all reviewed -> export runs directly');
  assert.strictEqual(captured.length, 0, 'no reminder popup when nothing is unreviewed');
});

test('runExportGuard: data + SOME unreviewed -> reminder popup with count + Download anyway', async () => {
  let proceeded = false;
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    apiFetch: function () { return Promise.resolve([{ status: 'needs_review' }, { status: 'needs_review' }]); },
    onProceed: function () { proceeded = true; },
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(captured.length, 1, 'reminder popup shown');
  assert.ok(captured[0].opts.message.indexOf('2 receipts') !== -1, 'message carries the count');
  assert.strictEqual(captured[0].opts.confirmLabel, 'Download anyway');
  assert.strictEqual(proceeded, false, 'not exported until the user clicks Download anyway');
  captured.onConfirm();
  assert.strictEqual(proceeded, true, 'Download anyway proceeds with the export');
});

// --- unreviewedItemLabel / unreviewedSummary (Owner 2026-07-10 follow-up) --------------
// Simplify the popup per the Owner: show actual info about WHICH receipts are unreviewed
// (not just a bare count), a real "Review" button that navigates to Activity, and keep
// "Download anyway". unreviewedSummary builds the (capped) list; unreviewedItemLabel
// formats one row for display.

test('unreviewedItemLabel: "Merchant — amount currency", tolerant of missing fields', () => {
  assert.strictEqual(Guards.unreviewedItemLabel({ merchant: 'Acme Corp', amount: 45, currency: 'MYR' }), 'Acme Corp — 45 MYR');
  assert.strictEqual(Guards.unreviewedItemLabel({ amount: 10 }), 'Receipt — 10');
  assert.strictEqual(Guards.unreviewedItemLabel({}), 'Receipt');
  assert.strictEqual(Guards.unreviewedItemLabel(null), 'Receipt');
});

test('unreviewedSummary: filters to needs_review, caps the list, reports the overflow count', () => {
  const rows = [
    { id: 'a', status: 'needs_review', merchant: 'A', amount: 1, currency: 'MYR' },
    { id: 'b', status: 'approved', merchant: 'B', amount: 2, currency: 'MYR' },
    { id: 'c', status: 'needs_review', merchant: 'C', amount: 3, currency: 'MYR' },
    { id: 'd', status: 'needs_review', merchant: 'D', amount: 4, currency: 'MYR' },
    { id: 'e', status: 'needs_review', merchant: 'E', amount: 5, currency: 'MYR' },
    { id: 'f', status: 'needs_review', merchant: 'F', amount: 6, currency: 'MYR' },
    { id: 'g', status: 'needs_review', merchant: 'G', amount: 7, currency: 'MYR' },
  ];
  const out = Guards.unreviewedSummary(rows);
  assert.strictEqual(out.count, 6);
  assert.deepStrictEqual(out.items, ['A — 1 MYR', 'C — 3 MYR', 'D — 4 MYR', 'E — 5 MYR', 'F — 6 MYR']);
  assert.strictEqual(out.more, 1);
});

test('unreviewedSummary: empty/garbage never throws', () => {
  assert.deepStrictEqual(Guards.unreviewedSummary([]), { count: 0, items: [], more: 0 });
  assert.deepStrictEqual(Guards.unreviewedSummary(null), { count: 0, items: [], more: 0 });
  assert.deepStrictEqual(Guards.unreviewedSummary(undefined), { count: 0, items: [], more: 0 });
});

test('runExportGuard: >0 unreviewed -> popup carries the item list, "Review" label, and onReview wired to cancel', async () => {
  let proceeded = false; let reviewed = false;
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    apiFetch: function () { return Promise.resolve([{ status: 'needs_review', merchant: 'Acme', amount: 9, currency: 'MYR' }]); },
    onProceed: function () { proceeded = true; },
    onReview: function () { reviewed = true; },
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(captured.length, 1);
  assert.deepStrictEqual(captured[0].opts.items, ['Acme — 9 MYR']);
  assert.strictEqual(captured[0].opts.cancelLabel, 'Review');
  assert.strictEqual(typeof captured[0].opts.onCancel, 'function');
  captured[0].opts.onCancel();
  assert.strictEqual(reviewed, true, 'clicking Review calls the caller-supplied navigation');
  assert.strictEqual(proceeded, false, 'Review does not also export');
});

test('runExportGuard: no onReview supplied -> popup still works, onCancel just absent/no-op', async () => {
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    apiFetch: function () { return Promise.resolve([{ status: 'needs_review', merchant: 'Acme', amount: 9, currency: 'MYR' }]); },
    onProceed: function () {},
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(captured.length, 1);
  assert.doesNotThrow(() => { if (captured[0].opts.onCancel) captured[0].opts.onCancel(); });
});

test('runExportGuard: review-count fetch fails -> falls back to the generic reviewed-confirm', async () => {
  let proceeded = false;
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    apiFetch: function () { return Promise.reject(new Error('network')); },
    onProceed: function () { proceeded = true; },
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(captured.length, 1, 'still a checkpoint on error, never silent');
  assert.strictEqual(captured[0].opts.message, Guards.CONFIRM_REVIEW_MESSAGE);
  captured.onConfirm();
  assert.strictEqual(proceeded, true);
});

test('runExportGuard: no apiFetch available -> generic reviewed-confirm fallback', async () => {
  const captured = [];
  Guards.runExportGuard({
    data: [{ id: 'e1' }],
    onProceed: function () {},
    confirm: fakeConfirm(captured),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].opts.message, Guards.CONFIRM_REVIEW_MESSAGE);
});
