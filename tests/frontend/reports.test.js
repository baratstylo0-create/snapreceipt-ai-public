'use strict';
// Pure logic behind the Reports screen (Task F): chartModel (mirrors overview.js),
// categoryBreakdown (per-category totals across buckets), buildReportsQuery
// (period/from/to validation for GET /api/reports), excelFilename (Content-
// Disposition parsing for the /api/excel blob download), and exportErrorMessage
// (status-only friendly messages, mirroring upload.js's errorMessage). Written
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
const { chartModel, categoryBreakdown, buildReportsQuery, excelFilename, exportErrorMessage,
  yearRange, yearsFromReport, pickDefaultYear } = Reports;

// A representative /api/reports response shape (mirrors overview.test.js's sample).
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

// --- chartModel (mirrors overview.js's tested behaviour) -------------------

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
  const rows = chartModel({ buckets: [{ key: '<script>x</script>', total: 5 }] });
  assert.strictEqual(rows[0].label, '<script>x</script>');
  assert.strictEqual(rows[0].value, 5);
});

// --- categoryBreakdown -------------------------------------------------------

test('categoryBreakdown sums byCategory across all buckets, sorted desc', () => {
  // Food = 60 + 150 = 210, Software = 50, Petrol = 40.
  const rows = categoryBreakdown(sample);
  assert.deepStrictEqual(rows, [
    { name: 'Food', total: 210 },
    { name: 'Software', total: 50 },
    { name: 'Petrol', total: 40 },
  ]);
});

test('categoryBreakdown excludes non-positive totals', () => {
  const rows = categoryBreakdown({
    buckets: [
      { key: 'x', total: 10, byCategory: { Food: 10, Zero: 0, Negative: -5 } },
    ],
  });
  assert.deepStrictEqual(rows, [{ name: 'Food', total: 10 }]);
});

test('categoryBreakdown tolerates garbage byCategory values (coerced to 0)', () => {
  const rows = categoryBreakdown({
    buckets: [
      { key: 'x', total: 10, byCategory: { Food: 'oops', Petrol: 40 } },
    ],
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

test('categoryBreakdown: ties are stable-ish (both present, sum correct) — sanity only', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 20, byCategory: { A: 10, B: 10 } }],
  });
  assert.strictEqual(rows.length, 2);
  const total = rows.reduce((s, r) => s + r.total, 0);
  assert.strictEqual(total, 20);
});

// --- buildReportsQuery -------------------------------------------------------

test('buildReportsQuery: valid period passes through', () => {
  assert.deepStrictEqual(buildReportsQuery('day'), { period: 'day' });
  assert.deepStrictEqual(buildReportsQuery('week'), { period: 'week' });
  assert.deepStrictEqual(buildReportsQuery('month'), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery('year'), { period: 'year' });
});

test('buildReportsQuery: invalid/missing period defaults to "month"', () => {
  assert.deepStrictEqual(buildReportsQuery('bogus'), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery(''), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery(null), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery(undefined), { period: 'month' });
});

test('buildReportsQuery: valid from/to (YYYY-MM-DD-shaped) are kept', () => {
  assert.deepStrictEqual(
    buildReportsQuery('month', '2026-01-01', '2026-06-30'),
    { period: 'month', from: '2026-01-01', to: '2026-06-30' }
  );
});

test('buildReportsQuery: malformed from/to are dropped', () => {
  assert.deepStrictEqual(buildReportsQuery('month', 'not-a-date', '2026-06-30'), { period: 'month', to: '2026-06-30' });
  assert.deepStrictEqual(buildReportsQuery('month', '2026-01-01', 'nope'), { period: 'month', from: '2026-01-01' });
  assert.deepStrictEqual(buildReportsQuery('month', '', ''), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery('month', 12345, {}), { period: 'month' });
});

test('buildReportsQuery: never throws on garbage input', () => {
  assert.doesNotThrow(() => buildReportsQuery({}, [], 42));
  assert.doesNotThrow(() => buildReportsQuery(undefined, undefined, undefined));
  assert.doesNotThrow(() => buildReportsQuery('month', '', '', {}));
});

// --- year scoping (bug: month/week were bucketed across ALL years at once) --------

test('buildReportsQuery: month + year auto-scopes to that year (Jan 1 – Dec 31)', () => {
  assert.deepStrictEqual(buildReportsQuery('month', '', '', '2026'),
    { period: 'month', from: '2026-01-01', to: '2026-12-31' });
});

test('buildReportsQuery: week + year auto-scopes to that year', () => {
  assert.deepStrictEqual(buildReportsQuery('week', '', '', '2024'),
    { period: 'week', from: '2024-01-01', to: '2024-12-31' });
});

test('buildReportsQuery: day + year auto-scopes to that year', () => {
  assert.deepStrictEqual(buildReportsQuery('day', '', '', '2023'),
    { period: 'day', from: '2023-01-01', to: '2023-12-31' });
});

test('buildReportsQuery: YEAR period is NOT year-scoped (it compares across years)', () => {
  assert.deepStrictEqual(buildReportsQuery('year', '', '', '2026'), { period: 'year' });
});

test('buildReportsQuery: an explicit from/to range overrides the year scope', () => {
  assert.deepStrictEqual(buildReportsQuery('month', '2026-03-01', '2026-03-31', '2026'),
    { period: 'month', from: '2026-03-01', to: '2026-03-31' });
});

test('buildReportsQuery: a partial explicit range (from only) still overrides — no year injected', () => {
  assert.deepStrictEqual(buildReportsQuery('month', '2026-03-01', '', '2026'),
    { period: 'month', from: '2026-03-01' });
});

test('buildReportsQuery: an invalid/missing year leaves the query unscoped (today’s behaviour)', () => {
  assert.deepStrictEqual(buildReportsQuery('month', '', '', 'nope'), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery('month', '', '', ''), { period: 'month' });
  assert.deepStrictEqual(buildReportsQuery('month', '', ''), { period: 'month' });
});

// --- yearRange -------------------------------------------------------------------

test('yearRange builds Jan1–Dec31 for a 4-digit year string, null otherwise', () => {
  assert.deepStrictEqual(yearRange('2026'), { from: '2026-01-01', to: '2026-12-31' });
  assert.strictEqual(yearRange('26'), null);
  assert.strictEqual(yearRange('abcd'), null);
  assert.strictEqual(yearRange(2026), null); // query values are strings; reject numbers
  assert.strictEqual(yearRange(null), null);
});

// --- yearsFromReport (populate the selector from a period=year report) -----------

test('yearsFromReport: 4-digit year keys only, sorted descending', () => {
  const r = { buckets: [{ key: '2018' }, { key: '2026' }, { key: '2023' }, { key: '2024' }] };
  assert.deepStrictEqual(yearsFromReport(r), ['2026', '2024', '2023', '2018']);
});

test('yearsFromReport: tolerant of junk / empty / missing (never throws)', () => {
  assert.deepStrictEqual(yearsFromReport(null), []);
  assert.deepStrictEqual(yearsFromReport({}), []);
  assert.deepStrictEqual(yearsFromReport({ buckets: [{ key: '2026-05' }, { key: 'x' }, { key: '2026' }] }), ['2026']);
});

// --- pickDefaultYear -------------------------------------------------------------

test('pickDefaultYear: current year if present, else the latest available, else current', () => {
  assert.strictEqual(pickDefaultYear(['2026', '2024', '2018'], 2026), '2026');
  assert.strictEqual(pickDefaultYear(['2024', '2018'], 2026), '2024');
  assert.strictEqual(pickDefaultYear([], 2026), '2026');
  assert.strictEqual(pickDefaultYear(null, 2026), '2026');
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

test('a hostile category name is inert once routed through Escape.safeText (defense in depth)', () => {
  const rows = categoryBreakdown({
    buckets: [{ key: 'x', total: 5, byCategory: { '<img src=x onerror=alert(1)>': 5 } }],
  });
  const safe = Escape.safeText(rows[0].name);
  assert.doesNotMatch(safe, /<img/);
});
