'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeMetrics } = require('../lib/metrics');

// Compact expense factory. Rows mirror the real `expenses` shape the aggregator
// reads: created_at/updated_at, status, confidence jsonb, deleted_at, amount.
const E = (over = {}) => ({
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  status: 'saved',
  amount: 10,
  confidence: null,
  deleted_at: null,
  ...over,
});

test('empty input → fully zeroed, no divide-by-zero, statements flagged unavailable', () => {
  const m = computeMetrics([], {});
  assert.strictEqual(m.client.receiptsProcessed, 0);
  assert.strictEqual(m.client.noEditCount, 0);
  assert.strictEqual(m.client.noEditPct, 0);
  assert.strictEqual(m.client.hoursSaved, 0);
  assert.strictEqual(m.client.statementsGenerated, null);
  assert.strictEqual(m.internal.attentionCount, 0);
  assert.strictEqual(m.internal.attentionRate, 0);
  assert.strictEqual(m.internal.avgDwellMinutes, null);
  assert.deepStrictEqual(m.internal.lowConfidenceByField, []);
  assert.deepStrictEqual(m.internal.mostCorrectedCategories, []);
  assert.strictEqual(m.meta.statementsGeneratedAvailable, false);
});

test('receiptsProcessed counts active rows, excludes soft-deleted', () => {
  const m = computeMetrics([E(), E(), E({ deleted_at: '2026-07-02T00:00:00.000Z' })], {});
  assert.strictEqual(m.client.receiptsProcessed, 2);
});

test('no-edit = clean status + no low-confidence field; needs_review / low-conf excluded', () => {
  const m = computeMetrics([
    E({ status: 'saved', confidence: { merchant: 'high', amount: 'high' } }), // clean
    E({ status: 'approved', confidence: { merchant: 'high' } }),              // clean (approved w/ high conf)
    E({ status: 'needs_review' }),                                            // needed attention
    E({ status: 'saved', confidence: { amount: 'low' } }),                    // low-conf → attention
  ], {});
  assert.strictEqual(m.client.receiptsProcessed, 4);
  assert.strictEqual(m.client.noEditCount, 2);
  assert.strictEqual(m.client.noEditPct, 50);
  assert.strictEqual(m.internal.attentionCount, 2);
  assert.strictEqual(m.internal.attentionRate, 50);
});

test('hoursSaved = processed × minutes/receipt ÷ 60, default 2.5, overridable', () => {
  const rows = [E(), E(), E(), E()]; // 4 receipts
  assert.strictEqual(computeMetrics(rows, {}).client.hoursSaved, 0.2);            // 4*2.5/60 = 0.166.. → 0.2
  assert.strictEqual(computeMetrics(rows, { manualMinutesPerReceipt: 15 }).client.hoursSaved, 1); // 4*15/60 = 1
});

test('avgDwellMinutes averages updated_at−created_at over reviewed rows only', () => {
  const m = computeMetrics([
    // reviewed: 10 min dwell
    E({ status: 'approved', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:10:00.000Z' }),
    // reviewed: 20 min dwell
    E({ status: 'rejected', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:20:00.000Z' }),
    // not reviewed (plain saved) → ignored for dwell
    E({ status: 'saved', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T05:00:00.000Z' }),
  ], {});
  assert.strictEqual(m.internal.avgDwellMinutes, 15); // (10+20)/2
});

test('lowConfidenceByField aggregates low fields, sorted desc by count', () => {
  const m = computeMetrics([
    E({ confidence: { amount: 'low', merchant: 'high' } }),
    E({ confidence: { amount: 'low', date: 'low' } }),
    E({ confidence: { amount: 'medium' } }), // only 'low' counts
  ], {});
  assert.deepStrictEqual(m.internal.lowConfidenceByField, [
    { field: 'amount', count: 2 },
    { field: 'date', count: 1 },
  ]);
});

test('mostCorrectedCategories comes from category_corrections, top 5 by hit_count desc', () => {
  const corrections = [
    { category: 'Food', hit_count: 3 },
    { category: 'Petrol', hit_count: 9 },
    { category: 'Software', hit_count: 1 },
  ];
  const m = computeMetrics([E()], { corrections });
  assert.deepStrictEqual(m.internal.mostCorrectedCategories, [
    { category: 'Petrol', count: 9 },
    { category: 'Food', count: 3 },
    { category: 'Software', count: 1 },
  ]);
});

test('meta carries the assumption used so the UI can state it', () => {
  const m = computeMetrics([E()], { manualMinutesPerReceipt: 3 });
  assert.strictEqual(m.meta.manualMinutesPerReceipt, 3);
});
