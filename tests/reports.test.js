'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildReport } = require('../lib/reports');

const E = (expense_date, amount, category = 'Food', extra = {}) => ({ expense_date, amount, category, ...extra });

test('empty input → zeroed report, no buckets', () => {
  const r = buildReport([], 'month');
  assert.deepStrictEqual(r.buckets, []);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.period, 'month');
});

test('monthly bucketing sums per month and overall', () => {
  const r = buildReport([
    E('2026-06-02', 10), E('2026-06-20', 5), E('2026-07-01', 7),
  ], 'month');
  assert.strictEqual(r.buckets.length, 2);
  assert.deepStrictEqual(r.buckets.map(b => b.key), ['2026-06', '2026-07']); // sorted asc
  assert.strictEqual(r.buckets[0].total, 15);
  assert.strictEqual(r.buckets[0].count, 2);
  assert.strictEqual(r.buckets[1].total, 7);
  assert.strictEqual(r.total, 22);
  assert.strictEqual(r.count, 3);
});

test('per-category breakdown within a bucket', () => {
  const r = buildReport([
    E('2026-06-02', 10, 'Food'), E('2026-06-03', 4, 'Petrol'), E('2026-06-04', 6, 'Food'),
  ], 'month');
  assert.deepStrictEqual(r.buckets[0].byCategory, { Food: 16, Petrol: 4 });
});

test('date range [from,to] is inclusive and filters out the rest', () => {
  const r = buildReport([
    E('2026-05-31', 100), E('2026-06-01', 10), E('2026-06-30', 20), E('2026-07-01', 100),
  ], 'month', { from: '2026-06-01', to: '2026-06-30' });
  assert.strictEqual(r.total, 30);
  assert.strictEqual(r.count, 2);
});

test('soft-deleted rows are excluded', () => {
  const r = buildReport([
    E('2026-06-02', 10), E('2026-06-03', 999, 'Food', { deleted_at: '2026-06-05T00:00:00Z' }),
  ], 'month');
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.count, 1);
});

test('rows with missing/invalid dates are skipped', () => {
  const r = buildReport([
    E('2026-06-02', 10), E('', 5), E('not-a-date', 5), E('2026/06/03', 5),
  ], 'month');
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.count, 1);
});

test('yearly bucketing', () => {
  const r = buildReport([E('2025-11-01', 3), E('2026-02-01', 4)], 'year');
  assert.deepStrictEqual(r.buckets.map(b => b.key), ['2025', '2026']);
});

test('daily bucketing keys are the ISO date', () => {
  const r = buildReport([E('2026-06-02', 3), E('2026-06-02', 4), E('2026-06-03', 5)], 'day');
  assert.deepStrictEqual(r.buckets.map(b => [b.key, b.total]), [['2026-06-02', 7], ['2026-06-03', 5]]);
});

test('ISO week bucketing handles the year boundary (2025-12-31 belongs to 2026-W01)', () => {
  const r = buildReport([E('2025-12-31', 2), E('2026-01-01', 3), E('2026-01-05', 9)], 'week');
  const keys = Object.fromEntries(r.buckets.map(b => [b.key, b.total]));
  assert.strictEqual(keys['2026-W01'], 5, '2025-12-31 + 2026-01-01 both fall in ISO week 2026-W01');
  assert.strictEqual(keys['2026-W02'], 9, '2026-01-05 (Mon) starts 2026-W02');
});

test('invalid period falls back to month', () => {
  const r = buildReport([E('2026-06-02', 10)], 'decade');
  assert.strictEqual(r.period, 'month');
  assert.strictEqual(r.buckets[0].key, '2026-06');
});

// --- QA-added edge cases (SOP §4.8) ---

test('negative amounts (refunds) reduce bucket + overall totals', () => {
  const r = buildReport([E('2026-06-01', 100), E('2026-06-02', -30, 'Food')], 'month');
  assert.strictEqual(r.buckets[0].total, 70);
  assert.strictEqual(r.buckets[0].byCategory.Food, 70);
  assert.strictEqual(r.total, 70);
  assert.strictEqual(r.count, 2);
});

test('zero-amount row is counted with total 0', () => {
  const r = buildReport([E('2026-06-01', 0)], 'month');
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.buckets[0].total, 0);
});

test('string amounts (some drivers) are coerced, not skipped', () => {
  const r = buildReport([E('2026-06-01', '12.50'), E('2026-06-02', '7.25')], 'month');
  assert.strictEqual(r.total, 19.75);
});

test('from > to yields an empty report, not an error', () => {
  const r = buildReport([E('2026-06-10', 10)], 'month', { from: '2026-07-01', to: '2026-06-01' });
  assert.deepStrictEqual(r.buckets, []);
  assert.strictEqual(r.total, 0);
});

test('from === to includes exactly that one day', () => {
  const r = buildReport([E('2026-06-09', 5), E('2026-06-10', 9), E('2026-06-11', 5)], 'day', { from: '2026-06-10', to: '2026-06-10' });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.total, 9);
});

test('null/garbage rows in the array are skipped, not crashed', () => {
  const r = buildReport([null, undefined, {}, E('2026-06-01', 10)], 'month');
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.total, 10);
});

test('impossible dates (2026-13-45, 2026-02-30) are rejected, produce no bucket', () => {
  const r = buildReport([E('2026-13-45', 99), E('2026-02-30', 99), E('2026-06-01', 10)], 'month');
  assert.deepStrictEqual(r.buckets.map(b => b.key), ['2026-06']);
  assert.strictEqual(r.total, 10);
});

test('week 53 appears as a real bucket, and byCategory is per-bucket', () => {
  const r = buildReport([
    E('2026-12-28', 2, 'Food'), E('2026-12-31', 3, 'Petrol'), E('2026-06-01', 5, 'Food'),
  ], 'week');
  const byKey = Object.fromEntries(r.buckets.map(b => [b.key, b]));
  assert.strictEqual(byKey['2026-W53'].total, 5);
  assert.deepStrictEqual(byKey['2026-W53'].byCategory, { Food: 2, Petrol: 3 });
  // the June expense is in a different week bucket, not W53
  assert.ok(!('Food' in byKey['2026-W53'].byCategory && byKey['2026-W53'].byCategory.Food === 7));
});
