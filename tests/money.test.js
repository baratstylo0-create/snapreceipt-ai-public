'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { curSym, fmtMoney, todayISO, normaliseDate } = require('../lib/money');

test('curSym maps known currencies and falls back to CODE+space', () => {
  assert.strictEqual(curSym('USD'), '$');
  assert.strictEqual(curSym('myr'), 'RM');
  assert.strictEqual(curSym('XYZ'), 'XYZ ');
});

test('fmtMoney formats with two decimals and the right symbol', () => {
  assert.strictEqual(fmtMoney(1234.5, 'USD'), '$1,234.50');
  assert.strictEqual(fmtMoney(0, 'MYR'), 'RM0.00');
  assert.strictEqual(fmtMoney('not-a-number', 'USD'), '$0.00');
});

test('todayISO returns YYYY-MM-DD', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('normaliseDate passes ISO through, converts DD/MM/YYYY, caps future, falls back to today', () => {
  assert.strictEqual(normaliseDate('2026-06-12'), '2026-06-12');
  assert.strictEqual(normaliseDate('12/06/2026'), '2026-06-12');   // DD/MM/YYYY
  assert.strictEqual(normaliseDate('garbage'), todayISO());        // fallback
  assert.strictEqual(normaliseDate('2999-01-01'), todayISO());     // future capped
});
