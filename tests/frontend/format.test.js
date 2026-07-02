'use strict';
// Pure money/number formatting for the Overview screen. No DOM, no network —
// unit-testable under node:test. Written TDD first.
const test = require('node:test');
const assert = require('node:assert');
const { formatMoney, formatCount } = require('../../public/js/format');

test('formatMoney renders two decimals with thousands separators', () => {
  assert.strictEqual(formatMoney(0), '0.00');
  assert.strictEqual(formatMoney(5), '5.00');
  assert.strictEqual(formatMoney(1234.5), '1,234.50');
  assert.strictEqual(formatMoney(1000000), '1,000,000.00');
});

test('formatMoney coerces numeric strings', () => {
  assert.strictEqual(formatMoney('42'), '42.00');
  assert.strictEqual(formatMoney('1234.567'), '1,234.57');
});

test('formatMoney is defensive: non-finite / junk → 0.00 (never NaN/Infinity in the UI)', () => {
  assert.strictEqual(formatMoney(NaN), '0.00');
  assert.strictEqual(formatMoney(Infinity), '0.00');
  assert.strictEqual(formatMoney(-Infinity), '0.00');
  assert.strictEqual(formatMoney(null), '0.00');
  assert.strictEqual(formatMoney(undefined), '0.00');
  assert.strictEqual(formatMoney('not-a-number'), '0.00');
  assert.strictEqual(formatMoney({}), '0.00');
});

test('formatMoney handles negatives', () => {
  assert.strictEqual(formatMoney(-1234.5), '-1,234.50');
});

test('formatCount renders integers with separators', () => {
  assert.strictEqual(formatCount(0), '0');
  assert.strictEqual(formatCount(7), '7');
  assert.strictEqual(formatCount(1234), '1,234');
  assert.strictEqual(formatCount('56'), '56');
});

test('formatCount is defensive: junk → 0', () => {
  assert.strictEqual(formatCount(NaN), '0');
  assert.strictEqual(formatCount(Infinity), '0');
  assert.strictEqual(formatCount(null), '0');
  assert.strictEqual(formatCount(undefined), '0');
  assert.strictEqual(formatCount('nope'), '0');
});

test('formatCount floors fractional inputs (counts are whole)', () => {
  assert.strictEqual(formatCount(3.9), '3');
});
