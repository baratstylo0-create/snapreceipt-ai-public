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

// Owner request 2026-07-14: lib/anomaly.js can attach an LLM-generated `summary` — a plain-
// English sentence ("even I got confused" reading the raw joined reasons). anomalyReasonText
// must prefer it over the joined reasons[].detail strings when present.
test('anomalyReasonText: prefers `summary` over the joined reasons[].detail strings', () => {
  const anomaly = {
    flagged: true,
    summary: 'This looks like the same receipt uploaded twice.',
    reasons: [{ type: 'duplicate', detail: 'matches existing expense abc123', severity: 'high' }],
  };
  assert.strictEqual(Activity.anomalyReasonText(anomaly), 'This looks like the same receipt uploaded twice.');
});

test('anomalyReasonText: falls back to joined reasons when summary is absent/blank/not a string', () => {
  const noSummary = { flagged: true, reasons: [{ detail: 'real one' }] };
  assert.strictEqual(Activity.anomalyReasonText(noSummary), 'real one');
  const blankSummary = { flagged: true, summary: '   ', reasons: [{ detail: 'real one' }] };
  assert.strictEqual(Activity.anomalyReasonText(blankSummary), 'real one');
  const nullSummary = { flagged: true, summary: null, reasons: [{ detail: 'real one' }] };
  assert.strictEqual(Activity.anomalyReasonText(nullSummary), 'real one');
  const nonStringSummary = { flagged: true, summary: 42, reasons: [{ detail: 'real one' }] };
  assert.strictEqual(Activity.anomalyReasonText(nonStringSummary), 'real one');
});

test('anomalyReasonText: a hostile summary string is returned raw for the render layer to escape (matches the reasons contract)', () => {
  const anomaly = { flagged: true, summary: '<svg onload=alert(3)>weird', reasons: [] };
  assert.strictEqual(Activity.anomalyReasonText(anomaly), '<svg onload=alert(3)>weird');
});
