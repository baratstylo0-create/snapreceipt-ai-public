'use strict';
// Pure transforms behind the Overview screen: chartModel (reports.buckets ->
// bar-chart rows) and kpiModel (reports totals -> KPI cards). No DOM, no network.
// Written TDD first. Escaping of labels is asserted separately from the numeric math.
const test = require('node:test');
const assert = require('node:assert');
const { chartModel, kpiModel, topCategory } = require('../../public/js/components/overview');

// A representative /api/reports response shape (see lib/reports.js buildReport).
const sample = {
  period: 'month',
  from: null,
  to: null,
  total: 300,
  count: 5,
  buckets: [
    { key: '2026-05', total: 100, count: 2, byCategory: { Food: 60, Petrol: 40 } },
    { key: '2026-06', total: 200, count: 3, byCategory: { Food: 150, Software: 50 } },
  ],
  fetched_count: 5,
  truncated: false,
};

test('chartModel maps buckets to {label, value} rows in bucket order', () => {
  const rows = chartModel(sample);
  assert.deepStrictEqual(rows, [
    { label: '2026-05', value: 100 },
    { label: '2026-06', value: 200 },
  ]);
});

test('chartModel returns [] for empty / missing / malformed input (never throws)', () => {
  assert.deepStrictEqual(chartModel({ buckets: [] }), []);
  assert.deepStrictEqual(chartModel({}), []);
  assert.deepStrictEqual(chartModel(null), []);
  assert.deepStrictEqual(chartModel(undefined), []);
  assert.deepStrictEqual(chartModel({ buckets: 'nope' }), []);
});

test('chartModel coerces bad bucket totals to 0 and stringifies the key label', () => {
  const rows = chartModel({
    buckets: [
      { key: 'A', total: 'oops' },
      { key: 123, total: 50 },
      { total: 10 }, // missing key
    ],
  });
  assert.deepStrictEqual(rows, [
    { label: 'A', value: 0 },
    { label: '123', value: 50 },
    { label: '', value: 10 },
  ]);
});

test('chartModel does NOT escape here — escaping happens at DOM render time', () => {
  // The transform stays a pure data mapping; the renderer is responsible for
  // routing every label through Escape.setText. We only assert the raw label
  // survives so a later escape assertion (render layer) is meaningful.
  const rows = chartModel({ buckets: [{ key: '<script>x</script>', total: 5 }] });
  assert.strictEqual(rows[0].label, '<script>x</script>');
  assert.strictEqual(rows[0].value, 5);
});

test('topCategory sums byCategory across all buckets and returns the largest', () => {
  // Food = 60 + 150 = 210 wins over Petrol 40, Software 50.
  assert.deepStrictEqual(topCategory(sample), { name: 'Food', total: 210 });
});

test('topCategory returns null when there is no category data', () => {
  assert.strictEqual(topCategory({ buckets: [] }), null);
  assert.strictEqual(topCategory({}), null);
  assert.strictEqual(topCategory(null), null);
  assert.strictEqual(topCategory({ buckets: [{ key: 'x', total: 0, byCategory: {} }] }), null);
});

test('kpiModel produces total / count / top-category cards from the report', () => {
  const cards = kpiModel(sample);
  const byLabel = {};
  cards.forEach((c) => { byLabel[c.label] = c; });
  assert.strictEqual(byLabel['Total spend'].value, '300.00');
  assert.strictEqual(byLabel['Expenses'].value, '5');
  assert.strictEqual(byLabel['Top category'].value, 'Food');
});

test('kpiModel handles an empty report gracefully (zeros, no top category)', () => {
  const cards = kpiModel({ total: 0, count: 0, buckets: [] });
  const byLabel = {};
  cards.forEach((c) => { byLabel[c.label] = c; });
  assert.strictEqual(byLabel['Total spend'].value, '0.00');
  assert.strictEqual(byLabel['Expenses'].value, '0');
  assert.strictEqual(byLabel['Top category'].value, '—');
});

test('kpiModel top-category value keeps the raw (unescaped) string for the render layer to escape', () => {
  const cards = kpiModel({
    total: 5, count: 1,
    buckets: [{ key: 'x', total: 5, byCategory: { '<script>evil</script>': 5 } }],
  });
  const top = cards.find((c) => c.label === 'Top category');
  assert.strictEqual(top.value, '<script>evil</script>');
});

test('kpiModel is defensive against null/undefined input', () => {
  assert.doesNotThrow(() => kpiModel(null));
  assert.doesNotThrow(() => kpiModel(undefined));
  const cards = kpiModel(null);
  assert.ok(Array.isArray(cards) && cards.length >= 3);
});
