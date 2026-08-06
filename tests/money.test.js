'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose, isDatePlausible, resolveReceiptDate } = require('../lib/money');

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

// Issue #149 (live client QA): a thermal receipt's date carried a trailing timestamp
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

// resolveReceiptDate — the smart format resolver (Owner directive 2026-07-22, live
// incident: a Mesincashier2u receipt printed "7/21/26" [M/D/Y] and the MODEL, asked to
// convert it itself, produced 2021-07-26 — wrong year AND wrong day. Format logic now
// lives here instead, deterministically, off the impossible-value rule + current-era
// year expansion, never left to the AI to guess.
test('resolveReceiptDate: the exact live-incident receipt (7/21/26 M/D/Y) resolves correctly', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  // 21 > 12 -> 21 MUST be the day -> 7 is the month -> 21 Jul 2026, not 2021-07-26.
  assert.deepStrictEqual(resolveReceiptDate('7/21/26', { now }), { iso: '2026-07-21', ambiguous: false });
});

test('resolveReceiptDate: impossible-value rule catches M/D/Y even when D/M/Y is the account default', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  // 24 > 12 -> forced day=24, month=7 -> 24 Jul 2026 (the Owner's own worked example).
  assert.deepStrictEqual(resolveReceiptDate('7/24/26', { now }), { iso: '2026-07-24', ambiguous: false });
  // Same logic the other way round: 24/07/26 is unambiguous D/M/Y already (24>12 -> day).
  assert.deepStrictEqual(resolveReceiptDate('24/07/26', { now }), { iso: '2026-07-24', ambiguous: false });
});

test('resolveReceiptDate: 2-digit year always expands to the CURRENT era, never the 1900s/2000s-past', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.strictEqual(resolveReceiptDate('21/07/26', { now }).iso, '2026-07-21');
  assert.strictEqual(resolveReceiptDate('01/01/25', { now }).iso, '2025-01-01');
});

test('resolveReceiptDate: genuinely ambiguous (both parts <=12) assumes D/M/Y by default and flags ambiguous', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  const r = resolveReceiptDate('3/4/26', { now });               // could be 3 Apr or 4 Mar
  assert.strictEqual(r.iso, '2026-04-03');                        // D/M/Y default -> 3 April
  assert.strictEqual(r.ambiguous, true);
  const r2 = resolveReceiptDate('3/4/26', { now, preferDMY: false });
  assert.strictEqual(r2.iso, '2026-03-04');                       // M/D/Y opt-out -> 4 March
  assert.strictEqual(r2.ambiguous, true);
});

test('resolveReceiptDate: unambiguous dates are never marked ambiguous', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.strictEqual(resolveReceiptDate('7/21/26', { now }).ambiguous, false);
  assert.strictEqual(resolveReceiptDate('2026-07-21', { now }).ambiguous, false);
  assert.strictEqual(resolveReceiptDate('21/07/2026', { now }).ambiguous, false);
});

test('resolveReceiptDate: ISO input passes straight through regardless of year length', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.deepStrictEqual(resolveReceiptDate('2026-07-21', { now }), { iso: '2026-07-21', ambiguous: false });
});

test('resolveReceiptDate: strips a trailing 12-hour AM/PM timestamp (the exact live receipt, "7/21/26 2:06 PM")', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.deepStrictEqual(resolveReceiptDate('7/21/26 2:06 PM', { now }), { iso: '2026-07-21', ambiguous: false });
  assert.deepStrictEqual(resolveReceiptDate('7/21/26 2:06 pm', { now }), { iso: '2026-07-21', ambiguous: false });
  assert.deepStrictEqual(resolveReceiptDate('30/06/2026 12:46:53 AM', { now }), { iso: '2026-06-30', ambiguous: false });
});

test('resolveReceiptDate: genuinely invalid input returns null, no silent default', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  assert.strictEqual(resolveReceiptDate('not a date', { now }), null);
  assert.strictEqual(resolveReceiptDate('13/13/26', { now }), null);  // both >12 -> impossible
  assert.strictEqual(resolveReceiptDate('', { now }), null);
  assert.strictEqual(resolveReceiptDate(null, { now }), null);
});

// normaliseDate/parseDateLoose now delegate to resolveReceiptDate, so the M/D/Y fix
// applies through the whole pipeline, not just the new function in isolation. Uses
// parseDateLoose (pure format resolution, no future-cap) rather than normaliseDate here
// deliberately — normaliseDate's future-cap runs off the REAL wall clock (untestable with
// a fixed date without flaking as real time passes); that policy has its own coverage
// below ('normaliseDate future-cap tolerates the MYT/UTC skew...').
test('parseDateLoose resolves the live-incident M/D/Y receipt correctly end-to-end', () => {
  assert.strictEqual(parseDateLoose('7/21/26'), '2026-07-21');
  assert.strictEqual(parseDateLoose('7/24/26'), '2026-07-24');
});

// The future-cap fix itself (found while writing the tests above): normaliseDate used to
// cap ANY date past the UTC instant of "now" — but this server runs in UTC while receipts
// are dated in Malaysia time (UTC+8), so a receipt legitimately dated "today" in MYT can
// still read as "tomorrow" in UTC for several hours each night, and got wrongly rolled
// back a day. Fixed by giving normaliseDate the same RECEIPT_FUTURE_GRACE_DAYS tolerance
// isDatePlausible already uses for exactly this skew.
test('normaliseDate future-cap tolerates the MYT/UTC skew (does not roll back a same-day receipt)', () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.strictEqual(normaliseDate(tomorrow), tomorrow);   // within the 2-day grace window
});

test('normaliseDate future-cap still catches a genuinely far-future/misread date', () => {
  assert.strictEqual(normaliseDate('2999-01-01'), todayISO());
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
