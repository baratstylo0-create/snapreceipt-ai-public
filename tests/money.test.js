'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose, isDatePlausible } = require('../lib/money');

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

// isDatePlausible (2026-07-21 live incident): a receipt's year was misread (2026 -> 2024) —
// a value that PARSES fine, so it's not what parseDateLoose/normaliseDate catch. This range-
// checks the parsed date against a fixed injected `now` so results are deterministic.
const FIXED_NOW = new Date('2026-07-21T10:00:00Z');

test('isDatePlausible: true for a recent, sane date', () => {
  assert.strictEqual(isDatePlausible('2026-07-20', { now: FIXED_NOW }), true);
  assert.strictEqual(isDatePlausible('2026-01-05', { now: FIXED_NOW }), true);
});

test('isDatePlausible: false for a misread year more than maxAgeDays old (issue: 2026 read as 2024)', () => {
  assert.strictEqual(isDatePlausible('2024-07-03', { now: FIXED_NOW }), false);
});

test('isDatePlausible: false for a date beyond the future grace window, true just within it', () => {
  assert.strictEqual(isDatePlausible('2026-08-01', { now: FIXED_NOW }), false);   // ~11 days out
  assert.strictEqual(isDatePlausible('2026-07-23', { now: FIXED_NOW }), true);    // +2d grace
});

test('isDatePlausible: false for unparseable input', () => {
  assert.strictEqual(isDatePlausible('garbage', { now: FIXED_NOW }), false);
  assert.strictEqual(isDatePlausible(null, { now: FIXED_NOW }), false);
  assert.strictEqual(isDatePlausible('', { now: FIXED_NOW }), false);
});

test('isDatePlausible: maxAgeDays override respected', () => {
  assert.strictEqual(isDatePlausible('2026-01-01', { now: FIXED_NOW, maxAgeDays: 30 }), false);
  assert.strictEqual(isDatePlausible('2026-01-01', { now: FIXED_NOW, maxAgeDays: 400 }), true);
});
