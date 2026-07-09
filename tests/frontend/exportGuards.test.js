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
