'use strict';
// Pure transforms behind the Overview screen: chartModel (reports.buckets ->
// bar-chart rows) and kpiModel (reports totals -> KPI cards). No DOM, no network.
// Written TDD first. Escaping of labels is asserted separately from the numeric math.
const test = require('node:test');
const assert = require('node:assert');
const {
  chartModel, kpiModel, topCategory, overviewReportsPath,
  monthlySeries, categoryPercentBreakdown, categoryColor, formatPercent, allTimeReportsPath,
  smoothPathD, donutSlicePath, normaliseCategoryKey, resolveCategoryOverride, COLOR_PRESETS,
  categoryCountBreakdown, formatDateRange, yearlyBreakdown,
} = require('../../public/js/components/overview');

// Overview scopes its report to the current year (fixes the all-years-mixed chart bug).
test('overviewReportsPath scopes to the given clock year (Jan1–Dec31, month buckets)', () => {
  assert.strictEqual(overviewReportsPath(Date.UTC(2026, 4, 15)), '/api/reports?period=month&from=2026-01-01&to=2026-12-31');
  assert.strictEqual(overviewReportsPath(Date.UTC(2024, 0, 1)), '/api/reports?period=month&from=2024-01-01&to=2024-12-31');
});
test('overviewReportsPath uses the real clock with no arg (never throws)', () => {
  assert.match(overviewReportsPath(), /^\/api\/reports\?period=month&from=\d{4}-01-01&to=\d{4}-12-31$/);
});

// A representative /api/reports response shape (see lib/reports.js buildReport).
const sample = {
  period: 'month',
  from: null,
  to: null,
  total: 300,
  count: 5,
  buckets: [
    { key: '2026-05', total: 100, count: 2, byCategory: { Food: 60, Petrol: 40 }, byCategoryCount: { Food: 1, Petrol: 1 } },
    { key: '2026-06', total: 200, count: 3, byCategory: { Food: 150, Software: 50 }, byCategoryCount: { Food: 2, Software: 1 } },
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
  assert.strictEqual(byLabel['Total bills'].value, '5');
  assert.strictEqual(byLabel['Top category'].value, 'Food');
});

test('kpiModel handles an empty report gracefully (zeros, no top category)', () => {
  const cards = kpiModel({ total: 0, count: 0, buckets: [] });
  const byLabel = {};
  cards.forEach((c) => { byLabel[c.label] = c; });
  assert.strictEqual(byLabel['Total spend'].value, '0.00');
  assert.strictEqual(byLabel['Total bills'].value, '0');
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

// --- categoryCountBreakdown (bill counts per category, for the Total-bills card) ---

test('categoryCountBreakdown sums byCategoryCount across buckets, biggest first', () => {
  // Food = 1 + 2 = 3, wins over Petrol 1, Software 1.
  assert.deepStrictEqual(categoryCountBreakdown(sample), [
    { name: 'Food', count: 3 },
    { name: 'Petrol', count: 1 },
    { name: 'Software', count: 1 },
  ]);
});

test('categoryCountBreakdown returns [] for missing/malformed/empty input (never throws)', () => {
  assert.deepStrictEqual(categoryCountBreakdown({ buckets: [] }), []);
  assert.deepStrictEqual(categoryCountBreakdown({}), []);
  assert.deepStrictEqual(categoryCountBreakdown(null), []);
  // Older bucket shape with no byCategoryCount at all -> contributes nothing, doesn't throw.
  assert.deepStrictEqual(categoryCountBreakdown({ buckets: [{ key: '2026-01', total: 10, count: 1, byCategory: { Food: 10 } }] }), []);
});

// --- formatDateRange (KPI-card sub-label: "Jan 1 – Jul 6, 2026") -------------

test('formatDateRange formats a same-year range without repeating the year', () => {
  assert.strictEqual(formatDateRange('2026-01-01', '2026-07-06'), 'Jan 1 – Jul 6, 2026');
});

test('formatDateRange includes both years when the range spans two years', () => {
  assert.strictEqual(formatDateRange('2025-12-15', '2026-01-05'), 'Dec 15, 2025 – Jan 5, 2026');
});

test('formatDateRange returns "" for missing/malformed input (never throws)', () => {
  assert.strictEqual(formatDateRange(null, null), '');
  assert.strictEqual(formatDateRange('2026-01-01', null), '');
  assert.strictEqual(formatDateRange('not-a-date', '2026-01-01'), '');
});

test('kpiModel adds a "Total spend" sub date-range (year start -> the injected clock date)', () => {
  // Local time (not UTC) to match isoDateLocal's own local-time reading, so this
  // is deterministic regardless of the test runner's timezone.
  const now = new Date(2026, 6, 6).getTime(); // Jul 6 2026, local
  const cards = kpiModel(sample, now);
  const spend = cards.find((c) => c.label === 'Total spend');
  assert.strictEqual(spend.sub, 'Jan 1 – Jul 6, 2026');
});

test('kpiModel "Total bills" card carries the category-count breakdown', () => {
  const cards = kpiModel(sample);
  const bills = cards.find((c) => c.label === 'Total bills');
  assert.deepStrictEqual(bills.breakdown, categoryCountBreakdown(sample));
});

test('kpiModel "Top category" carries an "in <year>" sub-label', () => {
  const now = new Date(2026, 6, 6).getTime();
  const cardsWithClock = kpiModel(sample, now);
  const top = cardsWithClock.find((c) => c.label === 'Top category');
  assert.strictEqual(top.sub, 'in 2026');
});

test('kpiModel no longer has a "Months with expenses" card (dropped 2026-07-06, folded into all-time card instead)', () => {
  const cards = kpiModel(sample);
  assert.strictEqual(cards.find((c) => c.label === 'Months with expenses'), undefined);
  assert.strictEqual(cards.length, 3);
});

// --- yearlyBreakdown (past-years list under "Overall spending until now") ---

test('yearlyBreakdown maps an all-time (period=year) report to [{name, total}], most recent first', () => {
  const allTime = {
    period: 'year', total: 500, count: 20,
    buckets: [
      { key: '2024', total: 100, count: 5 },
      { key: '2025', total: 150, count: 6 },
      { key: '2026', total: 250, count: 9 },
    ],
  };
  assert.deepStrictEqual(yearlyBreakdown(allTime), [
    { name: '2026', total: 250 },
    { name: '2025', total: 150 },
    { name: '2024', total: 100 },
  ]);
});

test('yearlyBreakdown drops zero/negative years and returns [] for missing/malformed input', () => {
  assert.deepStrictEqual(yearlyBreakdown({ buckets: [{ key: '2026', total: 0 }] }), []);
  assert.deepStrictEqual(yearlyBreakdown({ buckets: [] }), []);
  assert.deepStrictEqual(yearlyBreakdown({}), []);
  assert.deepStrictEqual(yearlyBreakdown(null), []);
});

// --- allTimeReportsPath -------------------------------------------------------

test('allTimeReportsPath: no date bounds (unlike overviewReportsPath)', () => {
  assert.strictEqual(allTimeReportsPath(), '/api/reports?period=year');
});

// --- monthlySeries -------------------------------------------------------------

test('monthlySeries: 12 rows Jan..Dec, zero-filled, real data overlaid', () => {
  const rows = monthlySeries(sample, 2026);
  assert.strictEqual(rows.length, 12);
  assert.deepStrictEqual(rows[0], { label: 'Jan', value: 0 });
  assert.deepStrictEqual(rows[4], { label: 'May', value: 100 });
  assert.deepStrictEqual(rows[5], { label: 'Jun', value: 200 });
});

test('monthlySeries: never throws on garbage input', () => {
  assert.doesNotThrow(() => monthlySeries(null, null));
  assert.doesNotThrow(() => monthlySeries({}, 'nope'));
  assert.strictEqual(monthlySeries(null, 2026).length, 12);
});

// --- categoryPercentBreakdown --------------------------------------------------

test('categoryPercentBreakdown: sorted desc, pct + exact frac sum to the whole', () => {
  // Food = 60+150=210, Software=50, Petrol=40 -> total 300.
  const rows = categoryPercentBreakdown(sample);
  assert.deepStrictEqual(rows.map((r) => r.name), ['Food', 'Software', 'Petrol']);
  assert.strictEqual(rows[0].total, 210);
  assert.strictEqual(rows[0].pct, 70);
  assert.ok(Math.abs(rows[0].frac - 210 / 300) < 1e-9);
  const fracSum = rows.reduce((s, r) => s + r.frac, 0);
  assert.ok(Math.abs(fracSum - 1) < 1e-9);
});

test('categoryPercentBreakdown: [] when there is no positive category spend', () => {
  assert.deepStrictEqual(categoryPercentBreakdown({ buckets: [] }), []);
  assert.deepStrictEqual(categoryPercentBreakdown(null), []);
  assert.deepStrictEqual(categoryPercentBreakdown({ buckets: [{ key: 'x', byCategory: { Food: -5 } }] }), []);
});

test('categoryPercentBreakdown: keeps raw (unescaped) names for the render layer to escape', () => {
  const rows = categoryPercentBreakdown({ buckets: [{ key: 'x', byCategory: { '<script>evil</script>': 5 } }] });
  assert.strictEqual(rows[0].name, '<script>evil</script>');
});

// --- categoryColor ---------------------------------------------------------------

test('categoryColor: deterministic, same category always gets the same slot', () => {
  assert.strictEqual(categoryColor('Food'), categoryColor('Food'));
  assert.strictEqual(categoryColor('Food'), categoryColor('  food  ')); // trim + case-insensitive
});

test('categoryColor: empty/blank/"Others" (any case) -> the neutral "others" slot', () => {
  assert.strictEqual(categoryColor(''), 'others');
  assert.strictEqual(categoryColor(null), 'others');
  assert.strictEqual(categoryColor(undefined), 'others');
  assert.strictEqual(categoryColor('Others'), 'others');
  assert.strictEqual(categoryColor('  OTHERS '), 'others');
});

test('categoryColor: a real category never lands on "others"', () => {
  assert.notStrictEqual(categoryColor('Fuel & Auto'), 'others');
});

// Bug fix 2026-07-06: every one of the app's 17 built-in categories
// (lib/categorize.js CATEGORIES, minus 'Others') must get its OWN slot — no
// two of them may ever collide. This is the actual reported bug: "Fuel & Auto"
// and "Office Supplies" used to hash to the same colour, so deleting bills
// that changed which categories were visible made it look like colours were
// randomly changing, when really a collision was becoming visible/invisible.
test('categoryColor: every built-in category gets its own unique slot (no collisions)', () => {
  const builtIns = [
    'Meals & Entertainment', 'Groceries', 'Fuel & Auto', 'Travel', 'Lodging',
    'Software & Subscriptions', 'Office Supplies', 'Utilities', 'Rent & Lease',
    'Professional Services', 'Marketing & Advertising', 'Inventory & COGS',
    'Equipment & Hardware', 'Shipping & Postage', 'Bank & Fees', 'Healthcare',
    'Education & Training',
  ];
  const slots = builtIns.map(categoryColor);
  assert.strictEqual(new Set(slots).size, builtIns.length, 'expected ' + builtIns.length + ' unique slots, got: ' + slots.join(', '));
  // Specifically the two categories the bug report actually named:
  assert.notStrictEqual(categoryColor('Fuel & Auto'), categoryColor('Office Supplies'));
});

test('categoryColor: a custom/unrecognised category still gets a deterministic (if not guaranteed-unique) slot', () => {
  assert.strictEqual(categoryColor('My Custom Field'), categoryColor('my custom field'));
});

// --- formatPercent -----------------------------------------------------------

test('formatPercent: one decimal + a % sign, tolerant of garbage', () => {
  assert.strictEqual(formatPercent(70), '70%');
  assert.strictEqual(formatPercent(33.333), '33.3%');
  assert.strictEqual(formatPercent('nope'), '0%');
  assert.strictEqual(formatPercent(null), '0%');
});

// --- smoothPathD (line-chart geometry) ------------------------------------------

test('smoothPathD: starts with M and has one C segment per gap between points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 5 }];
  const d = smoothPathD(pts);
  assert.match(d, /^M0,0/);
  assert.strictEqual((d.match(/C/g) || []).length, 2); // 3 points -> 2 segments
});

test('smoothPathD: 0 or 1 point degrades gracefully (no C segments)', () => {
  assert.strictEqual(smoothPathD([]), '');
  assert.strictEqual(smoothPathD([{ x: 5, y: 5 }]), 'M5,5');
});

test('smoothPathD: never throws on garbage input', () => {
  assert.doesNotThrow(() => smoothPathD(null));
  assert.doesNotThrow(() => smoothPathD(undefined));
  assert.doesNotThrow(() => smoothPathD('nope'));
});

// --- donutSlicePath (donut-chart geometry) --------------------------------------

test('donutSlicePath: a quarter slice (0deg-90deg) starts at the top and sweeps clockwise', () => {
  const d = donutSlicePath(100, 100, 80, 40, 0, 90);
  // Outer start at the top of the circle: (cx, cy-rO) = (100, 20).
  assert.match(d, /^M100,20/);
  assert.match(d, /A80,80/);
  assert.match(d, /A40,40/);
});

test('donutSlicePath: uses the large-arc flag for a span over 180deg', () => {
  const small = donutSlicePath(50, 50, 40, 20, 0, 90);
  const large = donutSlicePath(50, 50, 40, 20, 0, 270);
  assert.match(small, /A40,40 0 0 1/);
  assert.match(large, /A40,40 0 1 1/);
});

test('donutSlicePath: a zero/negative span -> "" (never throws)', () => {
  assert.strictEqual(donutSlicePath(50, 50, 40, 20, 90, 90), '');
  assert.strictEqual(donutSlicePath(50, 50, 40, 20, 90, 10), '');
  assert.doesNotThrow(() => donutSlicePath(null, null, null, null, null, null));
});

// --- custom category colours (Owner request 2026-07-05) -------------------------

test('normaliseCategoryKey: trims and lowercases, tolerant of null/undefined', () => {
  assert.strictEqual(normaliseCategoryKey(' Rent & Lease '), 'rent & lease');
  assert.strictEqual(normaliseCategoryKey(null), '');
  assert.strictEqual(normaliseCategoryKey(undefined), '');
});

test('resolveCategoryOverride: returns the stored hex for a matching (normalised) key', () => {
  const overrides = { 'rent & lease': '#112233' };
  assert.strictEqual(resolveCategoryOverride('Rent & Lease', overrides), '#112233');
  assert.strictEqual(resolveCategoryOverride('  RENT & LEASE  ', overrides), '#112233');
});

test('resolveCategoryOverride: null when there is no entry, a malformed entry, or garbage input', () => {
  assert.strictEqual(resolveCategoryOverride('Groceries', {}), null);
  assert.strictEqual(resolveCategoryOverride('Groceries', { groceries: 'not-a-hex' }), null);
  assert.strictEqual(resolveCategoryOverride('Groceries', { groceries: '#12345' }), null); // 5 digits, not 6
  assert.strictEqual(resolveCategoryOverride(null, null), null);
  assert.doesNotThrow(() => resolveCategoryOverride(undefined, undefined));
});

test('resolveCategoryOverride: accepts a valid 6-digit hex in either case', () => {
  assert.strictEqual(resolveCategoryOverride('Fuel', { fuel: '#AaBbCc' }), '#AaBbCc');
});

test('COLOR_PRESETS: a non-empty list of valid 6-digit hex colours', () => {
  assert.ok(Array.isArray(COLOR_PRESETS) && COLOR_PRESETS.length > 0);
  COLOR_PRESETS.forEach((hex) => assert.match(hex, /^#[0-9a-f]{6}$/i));
});
