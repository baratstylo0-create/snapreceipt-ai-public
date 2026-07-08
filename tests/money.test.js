'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose } = require('../lib/money');

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

// Issue #149 (live Premala QA): a thermal receipt's date carried a trailing timestamp
// (30/06/2026 12:46:53) — the old anchored regex didn't match it at all and silently
// fell back to today. normaliseDate must strip the trailing time and parse the date.
test('normaliseDate tolerates a trailing time-of-day (issue #149)', () => {
  assert.strictEqual(normaliseDate('30/06/2026 12:46:53'), '2026-06-30');
  assert.strictEqual(normaliseDate('2026-06-30 12:46:53'), '2026-06-30');
  assert.strictEqual(normaliseDate('2026-06-30T12:46:53'), '2026-06-30');
});

test('parseDateLoose: never falls back — null means genuinely unparseable (issue #149)', () => {
  assert.strictEqual(parseDateLoose('2026-06-12'), '2026-06-12');
  assert.strictEqual(parseDateLoose('12/06/2026'), '2026-06-12');
  assert.strictEqual(parseDateLoose('30/06/2026 12:46:53'), '2026-06-30');
  assert.strictEqual(parseDateLoose('garbage'), null);
  assert.strictEqual(parseDateLoose(''), null);
  assert.strictEqual(parseDateLoose(null), null);
  // NOTE: unlike normaliseDate, parseDateLoose does NOT cap a future date — that's
  // normaliseDate's job (a future date still IS a parseable date, just capped later).
  assert.strictEqual(parseDateLoose('2999-01-01'), '2999-01-01');
});
