'use strict';
// ADR-019 prep: unit tests for the pure review decision-machine guard extracted from
// routes/review.js into lib/reviewDecision.js. These cover the functions in isolation —
// the route-level behavior (HTTP status/body) is still covered by tests/review.route.test.js
// and tests/review.route.qa.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { DECISION_STATUS, resolveDecision, canDecide, buildReviewAudit } = require('../lib/reviewDecision');

test('DECISION_STATUS maps approve/reject to the expense statuses', () => {
  assert.deepStrictEqual(DECISION_STATUS, { approve: 'approved', reject: 'rejected' });
});

test('resolveDecision: "approve" and "reject" resolve to their target status', () => {
  assert.deepStrictEqual(resolveDecision('approve'), { ok: true, status: 'approved' });
  assert.deepStrictEqual(resolveDecision('reject'), { ok: true, status: 'rejected' });
});

test('resolveDecision: anything else is rejected, never throws', () => {
  for (const bad of ['approved', 'REJECT', '', null, undefined, 42, {}, []]) {
    const r = resolveDecision(bad);
    assert.strictEqual(r.ok, false, 'decision=' + JSON.stringify(bad) + ' must be rejected');
    assert.strictEqual(r.error, 'decision must be "approve" or "reject"');
  }
});

test('canDecide: a row with status "needs_review" may be decided', () => {
  assert.deepStrictEqual(canDecide({ status: 'needs_review' }), { ok: true });
});

test('canDecide: any other status is rejected with 409 and the status echoed in the message', () => {
  for (const status of ['saved', 'approved', 'rejected', 'weird-status']) {
    const r = canDecide({ status });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.error, 'expense is not pending review (status=' + status + ')');
  }
});

test('canDecide: a null/undefined row (not found) is rejected with 404, never throws', () => {
  for (const row of [null, undefined]) {
    const r = canDecide(row);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 404);
    assert.strictEqual(r.error, 'expense not found');
  }
});

test('buildReviewAudit: merges a `.review` entry into an existing anomaly object', () => {
  const before = { fraud_score: 0.9 };
  const out = buildReviewAudit(before, 'approve', 'looks fine');
  assert.strictEqual(out.fraud_score, 0.9);
  assert.strictEqual(out.review.decision, 'approve');
  assert.strictEqual(out.review.note, 'looks fine');
  assert.ok(!Number.isNaN(Date.parse(out.review.at)), 'review.at must be a parseable ISO timestamp');
});

test('buildReviewAudit: tolerates a garbage/non-object anomaly, falling back to {}', () => {
  for (const bad of [null, undefined, 'not-an-object', 42, [], ['x']]) {
    const out = buildReviewAudit(bad, 'reject', null);
    assert.strictEqual(out.review.decision, 'reject');
    assert.strictEqual(out.review.note, null);
    assert.ok(!Number.isNaN(Date.parse(out.review.at)));
  }
});

test('buildReviewAudit: note is passed through as-is (route is responsible for trimming/length)', () => {
  const out = buildReviewAudit({}, 'approve', 'a short note');
  assert.strictEqual(out.review.note, 'a short note');
});
