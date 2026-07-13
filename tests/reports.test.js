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

test('per-category BILL COUNT within a bucket (money total vs. number of bills are tracked separately)', () => {
  const r = buildReport([
    E('2026-06-02', 10, 'Food'), E('2026-06-03', 4, 'Petrol'), E('2026-06-04', 6, 'Food'),
  ], 'month');
  assert.deepStrictEqual(r.buckets[0].byCategoryCount, { Food: 2, Petrol: 1 });
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

// --- QA re-review round 2 (SOP §4.8) — adversarial pass on the pushed fixes ---
// These are REAL, verified bugs in `Number(e.amount) || 0` coercion (lib/reports.js:56), not hypotheticals.

test('BUG: boolean amount is silently coerced into real money (Number(true) === 1)', () => {
  // A malformed/garbage `amount: true` field should be rejected like other non-numeric
  // junk (objects, NaN-strings), not fabricate a $1 expense. Number(true) = 1 (truthy),
  // so `Number(e.amount) || 0` lets it through as legitimate money.
  const r = buildReport([E('2026-06-01', true)], 'month');
  assert.strictEqual(r.total, 0, 'boolean amount must not be counted as money');
  assert.strictEqual(r.count, 0, 'row with non-numeric amount must not inflate count');
});

test('BUG: array amount is silently coerced into real money (Number([5]) === 5)', () => {
  // Number([5]) unwraps the single-element array to 5 — a malformed amount field
  // (e.g. bad JSON/driver bug) silently becomes a real $5 line in the report.
  const r = buildReport([E('2026-06-01', [5])], 'month');
  assert.strictEqual(r.total, 0, 'array amount must not be counted as money');
  assert.strictEqual(r.count, 0, 'row with non-numeric amount must not inflate count');
});

test('BUG: Infinity amount poisons the entire report total, not just its own row', () => {
  // A single corrupt row with amount: Infinity (or -Infinity) turns every total/bucket
  // that sums it into Infinity/NaN territory once further arithmetic touches it —
  // a single bad record must not be able to destroy the whole money report.
  const r = buildReport([E('2026-06-01', Infinity), E('2026-06-02', 50)], 'month');
  assert.ok(Number.isFinite(r.total), 'grand total must stay finite');
  assert.ok(Number.isFinite(r.buckets[0].total), 'bucket total must stay finite');
});

test('data quality: non-numeric amount is excluded from count like other invalid rows', () => {
  // Mirrors the existing "rows with missing/invalid dates are skipped" contract:
  // a row that fails basic amount validation should be treated as an excluded/invalid
  // record (dropped, counted in neither total nor count), not silently counted as $0
  // while still incrementing count (which would corrupt averages downstream).
  const r = buildReport([E('2026-06-01', 10), E('2026-06-02', 'not-a-number')], 'month');
  assert.strictEqual(r.count, 1, 'the garbage-amount row must not inflate count');
  assert.strictEqual(r.total, 10);
});

test('toAmount and isISO are exported for reuse by lib/excel.js (#2)', () => {
  const { toAmount, isISO } = require('../lib/reports');
  assert.strictEqual(typeof toAmount, 'function');
  assert.strictEqual(typeof isISO, 'function');
  assert.strictEqual(toAmount('12.50'), 12.5);
  assert.strictEqual(toAmount(true), null);
  assert.strictEqual(toAmount(Infinity), null);
  assert.strictEqual(isISO('2026-07-01'), true);
  assert.strictEqual(isISO('2026-13-45'), false);
});

test('line-item category split: report byCategory distributes a mixed receipt while count stays per receipt', () => {
  const r = buildReport([E('2026-06-01', 80, 'Food', {
    line_items: [{ amount: 50, category: 'Food' }, { amount: 30, category: 'Petrol' }],
  })], 'month', { categories: ['Food', 'Petrol', 'Others'] });
  assert.deepStrictEqual(r.buckets[0].byCategory, { Food: 50, Petrol: 30 });
  assert.deepStrictEqual(r.buckets[0].byCategoryCount, { Food: 1, Petrol: 1 });
  assert.strictEqual(r.total, 80);
  assert.strictEqual(r.count, 1);
});

test('line-item category split: off-template portions fall back and remainder reconciles', () => {
  const r = buildReport([E('2026-06-01', 80, 'Food', {
    line_items: [{ amount: 50.01, category: 'Food' }, { amount: 29.98, category: 'Unknown' }],
  })], 'month', { categories: ['Food', 'Petrol', 'Others'] });
  assert.deepStrictEqual(r.buckets[0].byCategory, { Food: 80 });
  assert.strictEqual(r.total, 80);
});
