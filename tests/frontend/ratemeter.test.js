'use strict';
// Pure-helper tests for public/js/components/ratemeter.js (no DOM). Mirrors the
// node:test style of the other frontend component tests.
const { test } = require('node:test');
const assert = require('node:assert');
const { rateModel, label } = require('../../public/js/components/ratemeter');

test('rateModel: null on missing/invalid data (no misleading meter)', () => {
  assert.strictEqual(rateModel(null), null);
  assert.strictEqual(rateModel(undefined), null);
  assert.strictEqual(rateModel({}), null);                       // no limit
  assert.strictEqual(rateModel({ limit: 0, remaining: 0 }), null);   // limit <= 0
  assert.strictEqual(rateModel({ limit: -5, remaining: 1 }), null);
  assert.strictEqual(rateModel({ limit: 'x', remaining: 1 }), null); // non-numeric limit
  assert.strictEqual(rateModel({ limit: 120, remaining: 'x' }), null); // non-numeric remaining
});

test('rateModel: usedPct = (limit-remaining)/limit, rounded', () => {
  assert.strictEqual(rateModel({ limit: 120, remaining: 120 }).usedPct, 0);
  assert.strictEqual(rateModel({ limit: 120, remaining: 0 }).usedPct, 100);
  assert.strictEqual(rateModel({ limit: 120, remaining: 60 }).usedPct, 50);
  assert.strictEqual(rateModel({ limit: 120, remaining: 108 }).usedPct, 10); // 12/120
});

test('rateModel: level thresholds ok(<70) / warn([70,90)) / critical(>=90)', () => {
  assert.strictEqual(rateModel({ limit: 100, remaining: 100 }).level, 'ok');   // 0%
  assert.strictEqual(rateModel({ limit: 100, remaining: 31 }).level, 'ok');    // 69%
  assert.strictEqual(rateModel({ limit: 100, remaining: 30 }).level, 'warn');  // 70%
  assert.strictEqual(rateModel({ limit: 100, remaining: 11 }).level, 'warn');  // 89%
  assert.strictEqual(rateModel({ limit: 100, remaining: 10 }).level, 'critical'); // 90%
  assert.strictEqual(rateModel({ limit: 100, remaining: 0 }).level, 'critical');  // 100%
});

test('rateModel: clamps remaining into [0, limit]', () => {
  assert.strictEqual(rateModel({ limit: 120, remaining: -5 }).remaining, 0);
  assert.strictEqual(rateModel({ limit: 120, remaining: 999 }).remaining, 120);
  assert.strictEqual(rateModel({ limit: 120, remaining: 999 }).usedPct, 0);
});

test('rateModel: reset floored, never negative, defaults 0', () => {
  assert.strictEqual(rateModel({ limit: 120, remaining: 1, reset: 34.9 }).reset, 34);
  assert.strictEqual(rateModel({ limit: 120, remaining: 1, reset: -3 }).reset, 0);
  assert.strictEqual(rateModel({ limit: 120, remaining: 1 }).reset, 0);
  assert.strictEqual(rateModel({ limit: 120, remaining: 1, reset: 'x' }).reset, 0);
});

test('label: quiet count when ok; reset hint when warn/critical; "" for null', () => {
  assert.strictEqual(label(null), '');
  assert.strictEqual(label(rateModel({ limit: 120, remaining: 118 })), 'Rate 118/120');
  const warn = label(rateModel({ limit: 120, remaining: 12, reset: 40 }));
  assert.match(warn, /12 of 120 left/);
  assert.match(warn, /resets in 40s/);
});
