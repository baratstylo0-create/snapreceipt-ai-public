'use strict';
// Pure logic behind the Reports screen (Task F) drill-down redesign
// (2026-07-05): Day/Week/Month/Year each drill into ONE unit (Prev/Next steps
// between them) instead of an open date range:
//   Day   -> category breakdown only (no time chart).
//   Week  -> Sun..Sat bars, zero-filled.
//   Month -> W1..W4 bars (day-count chunks), zero-filled.
//   Year  -> Jan..Dec bars, zero-filled.
// Covered: date math (addDaysIso/startOfWeekIso/shift*), the query builder
// (buildAnchorQuery), the zero-filled bucket builders, heading-label
// formatters, categoryBreakdown, excelFilename, exportErrorMessage. Written
// TDD-first (watch fail, then implement). No DOM, no network.
//
// Endpoint contracts read from routes/reports.js + lib/reports.js + routes/excel.js:
//   GET /api/reports?period=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
//     -> 200 { period, from, to, total, count, buckets:[{key,total,count,byCategory}],
//              fetched_count, truncated }
//   GET /api/excel?from=&to=
//     -> 200 binary xlsx, Content-Disposition: attachment; filename="...",
//        optional X-Truncated: true header
//     -> non-2xx JSON { error } (502 on failure)
const test = require('node:test');
const assert = require('node:assert');

const Reports = require('../../public/js/components/reports');
const Escape = require('../../public/js/escape');
const {
  categoryBreakdown, buildAnchorQuery,
  weekdayBuckets, monthWeekBuckets, yearMonthBuckets,
  formatDayHeading, formatWeekHeading, formatMonthHeading, formatYearHeading,
  startOfWeekIso, addDaysIso, shiftDay, shiftWeek, shiftMonth, shiftYear,
  monthRangeFor, weekRangeFor, yearRangeFor,
  excelFilename, exportErrorMessage,
  EXPORT_CHOICES, exportChoiceLabel, exportRangeFor,
} = Reports;

// --- date math ---------------------------------------------------------------

test('addDaysIso: adds/subtracts days, including across month/year boundaries', () => {
  assert.strictEqual(addDaysIso('2026-07-05', 1), '2026-07-06');
  assert.strictEqual(addDaysIso('2026-07-31', 1), '2026-08-01');
  assert.strictEqual(addDaysIso('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDaysIso('2026-07-05', -5), '2026-06-30');
});

test('startOfWeekIso: returns the Sunday on/before the given date', () => {
  // 2026-07-05 is a Sunday.
  assert.strictEqual(startOfWeekIso('2026-07-05'), '2026-07-05');
  // 2026-07-08 is a Wednesday -> that week's Sunday is 2026-07-05.
  assert.strictEqual(startOfWeekIso('2026-07-08'), '2026-07-05');
  // 2026-07-11 is a Saturday -> same week, still 2026-07-05.
  assert.strictEqual(startOfWeekIso('2026-07-11'), '2026-07-05');
});

test('shiftDay / shiftWeek: move by whole days / 7-day weeks', () => {
  assert.strictEqual(shiftDay('2026-07-05', 1), '2026-07-06');
  assert.strictEqual(shiftDay('2026-07-05', -1), '2026-07-04');
  assert.strictEqual(shiftWeek('2026-07-05', 1), '2026-07-12');
  assert.strictEqual(shiftWeek('2026-07-05', -1), '2026-06-28');
});

test('shiftMonth: wraps year forward and backward correctly', () => {
  assert.deepStrictEqual(shiftMonth(2026, 7, 1), { year: 2026, month: 8 });
  assert.deepStrictEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepStrictEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

test('shiftYear: adds/subtracts years', () => {
  assert.strictEqual(shiftYear(2026, 1), 2027);
  assert.strictEqual(shiftYear(2026, -1), 2025);
});

test('monthRangeFor: first-to-last day of the month, leap year aware', () => {
  assert.deepStrictEqual(monthRangeFor(2026, 7), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepStrictEqual(monthRangeFor(2026, 2), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepStrictEqual(monthRangeFor(2024, 2), { from: '2024-02-01', to: '2024-02-29' }); // leap year
});

test('weekRangeFor: 7-day span from the given Sunday', () => {
  assert.deepStrictEqual(weekRangeFor('2026-07-05'), { from: '2026-07-05', to: '2026-07-11' });
});

test('yearRangeFor: Jan 1 - Dec 31 of the given year', () => {
  assert.deepStrictEqual(yearRangeFor(2026), { from: '2026-01-01', to: '2026-12-31' });
});

// --- buildAnchorQuery ---------------------------------------------------------

test('buildAnchorQuery: day -> period=day, from=to=the anchor date', () => {
  assert.deepStrictEqual(buildAnchorQuery('day', '2026-07-05'),
    { period: 'day', from: '2026-07-05', to: '2026-07-05' });
});

test('buildAnchorQuery: week -> period=day over that week\'s 7-day span', () => {
  assert.deepStrictEqual(buildAnchorQuery('week', '2026-07-05'),
    { period: 'day', from: '2026-07-05', to: '2026-07-11' });
});

test('buildAnchorQuery: month -> period=day over that whole month', () => {
  assert.deepStrictEqual(buildAnchorQuery('month', { year: 2026, month: 7 }),
    { period: 'day', from: '2026-07-01', to: '2026-07-31' });
});

test('buildAnchorQuery: year -> period=month over that whole year', () => {
  assert.deepStrictEqual(buildAnchorQuery('year', 2026),
    { period: 'month', from: '2026-01-01', to: '2026-12-31' });
});

test('buildAnchorQuery: invalid period defaults to month', () => {
  const q = buildAnchorQuery('bogus', { year: 2026, month: 7 });
  assert.strictEqual(q.period, 'day');
  assert.strictEqual(q.from, '2026-07-01');
});

test('buildAnchorQuery: never throws on garbage anchors (falls back to today)', () => {
  assert.doesNotThrow(() => buildAnchorQuery('day', null));
  assert.doesNotThrow(() => buildAnchorQuery('week', undefined));
  assert.doesNotThrow(() => buildAnchorQuery('month', {}));
  assert.doesNotThrow(() => buildAnchorQuery('month', null));
  assert.doesNotThrow(() => buildAnchorQuery('year', 'nope'));
  assert.doesNotThrow(() => buildAnchorQuery(undefined, undefined));
});

// --- weekdayBuckets ------------------------------------------------------------

test('weekdayBuckets: 7 bars Sun..Sat, real data overlaid on a zero grid', () => {
  const reports = {
    buckets: [
      { key: '2026-07-05', total: 50 }, // Sunday
      { key: '2026-07-08', total: 30 }, // Wednesday
    ],
  };
  const rows = weekdayBuckets(reports, '2026-07-05');
  assert.deepStrictEqual(rows, [
    { label: 'Sun', value: 50 },
    { label: 'Mon', value: 0 },
    { label: 'Tue', value: 0 },
    { label: 'Wed', value: 30 },
    { label: 'Thu', value: 0 },
    { label: 'Fri', value: 0 },
    { label: 'Sat', value: 0 },
  ]);
});

test('weekdayBuckets: never throws on garbage input', () => {
  assert.doesNotThrow(() => weekdayBuckets(null, null));
  assert.doesNotThrow(() => weekdayBuckets({}, 'not-iso'));
  assert.deepStrictEqual(weekdayBuckets(null, '2026-07-05').length, 7);
});

// --- monthWeekBuckets ------------------------------------------------------------

test('monthWeekBuckets: exactly 4 bars W1..W4, day-count chunks', () => {
  const reports = {
    buckets: [
      { key: '2026-07-03', total: 10 },  // W1 (days 1-7)
      { key: '2026-07-10', total: 20 },  // W2 (days 8-14)
      { key: '2026-07-18', total: 30 },  // W3 (days 15-21)
      { key: '2026-07-25', total: 40 },  // W4 (days 22-28)
      { key: '2026-07-30', total: 5 },   // trailing day -> folds into W4
    ],
  };
  const rows = monthWeekBuckets(reports, 2026, 7);
  assert.deepStrictEqual(rows, [
    { label: 'W1', value: 10 },
    { label: 'W2', value: 20 },
    { label: 'W3', value: 30 },
    { label: 'W4', value: 45 },
  ]);
});

test('monthWeekBuckets: always 4 bars even for a short (28-day) month', () => {
  const rows = monthWeekBuckets({ buckets: [] }, 2026, 2);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.value), [0, 0, 0, 0]);
});

test('monthWeekBuckets: never throws on garbage input', () => {
  assert.doesNotThrow(() => monthWeekBuckets(null, null, null));
  assert.doesNotThrow(() => monthWeekBuckets({}, 'x', 99));
});

// --- yearMonthBuckets ------------------------------------------------------------

test('yearMonthBuckets: 12 bars Jan..Dec, zero-filled', () => {
  const reports = {
    buckets: [
      { key: '2026-01', total: 100 },
      { key: '2026-07', total: 250 },
    ],
  };
  const rows = yearMonthBuckets(reports, 2026);
  assert.strictEqual(rows.length, 12);
  assert.deepStrictEqual(rows[0], { label: 'Jan', value: 100 });
  assert.deepStrictEqual(rows[6], { label: 'Jul', value: 250 });
  assert.deepStrictEqual(rows[1], { label: 'Feb', value: 0 });
});

test('yearMonthBuckets: never throws on garbage input', () => {
  assert.doesNotThrow(() => yearMonthBuckets(null, null));
  assert.doesNotThrow(() => yearMonthBuckets({}, 'nope'));
});

// --- heading formatters --------------------------------------------------------

test('formatDayHeading / formatWeekHeading / formatMonthHeading / formatYearHeading', () => {
  assert.strictEqual(formatDayHeading('2026-07-05'), 'Sun, Jul 5, 2026');
  assert.strictEqual(formatWeekHeading('2026-07-05'), 'Jul 5–Jul 11, 2026');
  assert.strictEqual(formatMonthHeading(2026, 7), 'Jul 2026');
  assert.strictEqual(formatYearHeading(2026), '2026');
});

test('heading formatters never throw on garbage input', () => {
  assert.doesNotThrow(() => formatDayHeading(null));
  assert.doesNotThrow(() => formatWeekHeading(undefined));
  assert.doesNotThrow(() => formatMonthHeading(null, null));
  assert.doesNotThrow(() => formatYearHeading('nope'));
});

// --- categoryBreakdown -------------------------------------------------------

const sample = {
  period: 'month', from: null, to: null, total: 300, count: 5,
  buckets: [
    { key: '2026-05', total: 100, count: 2, byCategory: { Food: 60, Petrol: 40 } },
    { key: '2026-06', total: 200, count: 3, byCategory: { Food: 150, Software: 50 } },
  ],
  fetched_count: 5, truncated: false,
};

test('categoryBreakdown sums byCategory across all buckets, sorted desc', () => {
  const rows = categoryBreakdown(sample);
  assert.deepStrictEqual(rows, [
    { name: 'Food', total: 210 },
    { name: 'Software', total: 50 },
    { name: 'Petrol', total: 40 },
  ]);
});

test('categoryBreakdown excludes non-positive totals', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 10, byCategory: { Food: 10, Zero: 0, Negative: -5 } }],
  });
  assert.deepStrictEqual(rows, [{ name: 'Food', total: 10 }]);
});

test('categoryBreakdown tolerates garbage byCategory values (coerced to 0)', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 10, byCategory: { Food: 'oops', Petrol: 40 } }],
  });
  assert.deepStrictEqual(rows, [{ name: 'Petrol', total: 40 }]);
});

test('categoryBreakdown: empty/null/undefined/malformed input -> [] (never throws)', () => {
  assert.deepStrictEqual(categoryBreakdown({ buckets: [] }), []);
  assert.deepStrictEqual(categoryBreakdown({}), []);
  assert.deepStrictEqual(categoryBreakdown(null), []);
  assert.deepStrictEqual(categoryBreakdown(undefined), []);
  assert.deepStrictEqual(categoryBreakdown({ buckets: 'nope' }), []);
  assert.deepStrictEqual(categoryBreakdown({ buckets: [{ key: 'x', byCategory: null }] }), []);
  assert.deepStrictEqual(categoryBreakdown({ buckets: [{ key: 'x', byCategory: 'nope' }] }), []);
});

test('categoryBreakdown keeps raw (unescaped) category names for the render layer to escape', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 5, byCategory: { '<script>evil</script>': 5 } }],
  });
  assert.strictEqual(rows[0].name, '<script>evil</script>');
});

test('a hostile category name is inert once routed through Escape.safeText (defense in depth)', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 5, byCategory: { '<img src=x onerror=alert(1)>': 5 } }],
  });
  const safe = Escape.safeText(rows[0].name);
  assert.doesNotMatch(safe, /<img/);
});

// --- excelFilename -------------------------------------------------------

test('excelFilename: extracts the filename from a real Content-Disposition header', () => {
  const cd = 'attachment; filename="expenses-2026-01-01-2026-06-30.xlsx"';
  assert.strictEqual(excelFilename(cd, '2026-01-01', '2026-06-30'), 'expenses-2026-01-01-2026-06-30.xlsx');
});

test('excelFilename: falls back cleanly when header is missing', () => {
  assert.strictEqual(excelFilename(null, '2026-01-01', '2026-06-30'), 'expenses-2026-01-01-2026-06-30.xlsx');
  assert.strictEqual(excelFilename(undefined, null, null), 'expenses-all-export.xlsx');
});

test('excelFilename: falls back cleanly when header is malformed', () => {
  assert.strictEqual(excelFilename('attachment', '2026-01-01', undefined), 'expenses-2026-01-01-export.xlsx');
  assert.strictEqual(excelFilename('garbage;;;', undefined, '2026-06-30'), 'expenses-all-2026-06-30.xlsx');
});

test('excelFilename: never throws on garbage input', () => {
  assert.doesNotThrow(() => excelFilename(42, {}, []));
  assert.doesNotThrow(() => excelFilename({}, undefined, undefined));
});

// --- exportErrorMessage -------------------------------------------------------

test('exportErrorMessage: maps known statuses to friendly messages', () => {
  assert.match(exportErrorMessage(502), /export/i);
  assert.match(exportErrorMessage(401), /try again|access|token/i);
});

test('exportErrorMessage: generic fallback for unknown status', () => {
  const msg = exportErrorMessage(500);
  assert.match(msg, /export/i);
  const msg2 = exportErrorMessage(999);
  assert.match(msg2, /export/i);
});

test('exportErrorMessage: never throws on garbage input', () => {
  assert.doesNotThrow(() => exportErrorMessage(undefined));
  assert.doesNotThrow(() => exportErrorMessage(null));
  assert.doesNotThrow(() => exportErrorMessage('oops'));
  assert.doesNotThrow(() => exportErrorMessage({}));
});

test('exportErrorMessage: never leaks internals (body is not even a parameter — status only)', () => {
  // Contract: the function signature takes status only, mirroring upload.js's
  // errorMessage's status-only design, so there is no way to leak body text.
  assert.strictEqual(exportErrorMessage.length, 1);
});

// --- export-timeframe choice (Owner request 2026-07-06) ----------------------

test('EXPORT_CHOICES: day, week, month, overall — in that order', () => {
  assert.deepStrictEqual(EXPORT_CHOICES, ['day', 'week', 'month', 'overall']);
});

test('exportChoiceLabel: a plain-language label for each choice, and a safe fallback for garbage', () => {
  assert.strictEqual(exportChoiceLabel('day'), 'Today');
  assert.strictEqual(exportChoiceLabel('week'), 'This week');
  assert.strictEqual(exportChoiceLabel('month'), 'This month');
  assert.strictEqual(exportChoiceLabel('overall'), 'Overall (all time)');
  assert.strictEqual(exportChoiceLabel('garbage'), 'Overall (all time)');
  assert.strictEqual(exportChoiceLabel(undefined), 'Overall (all time)');
});

test('exportRangeFor: "day" is anchored to the given "today", not whatever is browsed on screen', () => {
  assert.deepStrictEqual(exportRangeFor('day', '2026-07-06'), { from: '2026-07-06', to: '2026-07-06' });
});

test('exportRangeFor: "week" is the Sun-Sat week containing "today"', () => {
  // 2026-07-06 is a Monday; its week runs Sun 2026-07-05 .. Sat 2026-07-11.
  assert.deepStrictEqual(exportRangeFor('week', '2026-07-06'), { from: '2026-07-05', to: '2026-07-11' });
});

test('exportRangeFor: "month" is the full calendar month containing "today"', () => {
  assert.deepStrictEqual(exportRangeFor('month', '2026-07-06'), { from: '2026-07-01', to: '2026-07-31' });
  // February in a leap year (2028) -> 29 days.
  assert.deepStrictEqual(exportRangeFor('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

test('exportRangeFor: "overall" has no date bounds at all (routes/excel.js treats this as every expense ever)', () => {
  assert.deepStrictEqual(exportRangeFor('overall', '2026-07-06'), { from: null, to: null });
});

test('exportRangeFor: a malformed/missing "now" falls back to the real today, never throws', () => {
  assert.doesNotThrow(() => exportRangeFor('day', 'not-a-date'));
  assert.doesNotThrow(() => exportRangeFor('day', undefined));
  assert.doesNotThrow(() => exportRangeFor('garbage-choice', '2026-07-06'));
});
