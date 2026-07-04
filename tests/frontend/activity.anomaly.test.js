'use strict';
// QA report #10b — badgesFor()/anomalyReasonText() were reading a `.reason` field that
// NEVER existed on the real anomaly shape written by lib/ocr.js/lib/anomaly.js
// ({ flagged, reasons: [{type, detail, severity}] }). So every review-queue card and
// badge tooltip silently fell back to a generic "Flagged for review" — the exact
// transparency gap the QA report flagged ("what is the purpose of low conf and review").
const test = require('node:test');
const assert = require('node:assert');
const Activity = require('../../public/js/components/activity');

test('anomalyReasonText: joins real reasons[].detail (the actual data shape)', () => {
  const anomaly = { flagged: true, reasons: [
    { type: 'duplicate', detail: 'matches existing expense abc123 (same merchant & amount within 3d)', severity: 'high' },
    { type: 'low_confidence', detail: 'Low confidence on required field(s): amount', severity: 'low' },
  ] };
  assert.strictEqual(Activity.anomalyReasonText(anomaly),
    'matches existing expense abc123 (same merchant & amount within 3d); Low confidence on required field(s): amount');
});
test('anomalyReasonText: missing/non-array reasons -> generic fallback, never throws', () => {
  assert.strictEqual(Activity.anomalyReasonText({ flagged: true }), 'Flagged for review');
  assert.strictEqual(Activity.anomalyReasonText(null), 'Flagged for review');
  assert.strictEqual(Activity.anomalyReasonText({ flagged: true, reasons: 'not-an-array' }), 'Flagged for review');
});
test('anomalyReasonText: a reasons entry with no usable detail is skipped, not blank', () => {
  const anomaly = { flagged: true, reasons: [{ type: 'x' }, { detail: 'real one' }] };
  assert.strictEqual(Activity.anomalyReasonText(anomaly), 'real one');
});

test('badgesFor: an anomaly row carries the REAL reason text (regression lock for the bug fix)', () => {
  const row = { anomaly: { flagged: true, reasons: [{ type: 'duplicate', detail: 'matches existing expense X within 3d' }] } };
  const badges = Activity.badgesFor(row);
  const anomalyBadge = badges.find(b => b.kind === 'anomaly');
  assert.ok(anomalyBadge, 'anomaly badge present');
  assert.strictEqual(anomalyBadge.reason, 'matches existing expense X within 3d');
});
test('badgesFor: flagged:false never produces an anomaly badge', () => {
  const row = { anomaly: { flagged: false, reasons: [{ detail: 'should not show' }] } };
  assert.strictEqual(Activity.badgesFor(row).some(b => b.kind === 'anomaly'), false);
});
