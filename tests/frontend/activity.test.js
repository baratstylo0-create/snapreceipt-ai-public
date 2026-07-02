'use strict';
// Pure logic behind the Activity screen — the PRIMARY stored-XSS surface. These
// tests cover the require()-able helpers with NO DOM: filterSortPage, badgesFor,
// categoryColor, patchBody. Written TDD-first (watch fail, then implement).
//
// The XSS assertions prove that hostile OCR/AI values (merchant, description,
// anomaly reason, control bytes) survive as INERT text once routed through
// Escape.safeText — no raw <script>/executable markup leaks. We deliberately do
// NOT add jsdom; we assert on the escaped string the render layer would emit.
const test = require('node:test');
const assert = require('node:assert');

const Activity = require('../../public/js/components/activity');
const Escape = require('../../public/js/escape');
const { filterSortPage, badgesFor, categoryColor, patchBody, receiptPath } = Activity;

// A representative /api/expenses row (see schema.sql expenses table).
function row(over) {
  return Object.assign({
    id: 'r1',
    account_id: 'default',
    merchant: 'Acme',
    expense_date: '2026-06-01',
    amount: 10,
    currency: 'USD',
    category: 'Food',
    status: 'saved',
    remark: '',
    line_items: [],
  }, over || {});
}

// --- filterSortPage -------------------------------------------------------

test('filterSortPage returns all rows (page 1) with no options', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' })];
  const out = filterSortPage(rows, {});
  assert.strictEqual(out.total, 2);
  assert.strictEqual(out.rows.length, 2);
  assert.strictEqual(out.page, 1);
});

test('filterSortPage tolerates empty / non-array input (never throws)', () => {
  assert.deepStrictEqual(filterSortPage([], {}).rows, []);
  assert.deepStrictEqual(filterSortPage(null, {}).rows, []);
  assert.deepStrictEqual(filterSortPage(undefined).rows, []);
  assert.strictEqual(filterSortPage(null, {}).total, 0);
});

test('filterSortPage search matches merchant, remark and category (case-insensitive)', () => {
  const rows = [
    row({ id: 'a', merchant: 'Starbucks', category: 'Food' }),
    row({ id: 'b', merchant: 'Shell', category: 'Petrol', remark: 'road trip' }),
    row({ id: 'c', merchant: 'GitHub', category: 'Software' }),
  ];
  assert.deepStrictEqual(filterSortPage(rows, { search: 'star' }).rows.map((r) => r.id), ['a']);
  assert.deepStrictEqual(filterSortPage(rows, { search: 'ROAD' }).rows.map((r) => r.id), ['b']);
  assert.deepStrictEqual(filterSortPage(rows, { search: 'software' }).rows.map((r) => r.id), ['c']);
  assert.strictEqual(filterSortPage(rows, { search: 'zzz' }).rows.length, 0);
});

test('filterSortPage filters by status and by category', () => {
  const rows = [
    row({ id: 'a', status: 'saved', category: 'Food' }),
    row({ id: 'b', status: 'needs_review', category: 'Petrol' }),
    row({ id: 'c', status: 'approved', category: 'Food' }),
  ];
  assert.deepStrictEqual(filterSortPage(rows, { filterStatus: 'saved' }).rows.map((r) => r.id), ['a']);
  assert.deepStrictEqual(filterSortPage(rows, { filterCategory: 'Food' }).rows.map((r) => r.id), ['a', 'c']);
  // combined
  assert.deepStrictEqual(
    filterSortPage(rows, { filterStatus: 'approved', filterCategory: 'Food' }).rows.map((r) => r.id), ['c']);
  // "all" / empty is a no-op filter
  assert.strictEqual(filterSortPage(rows, { filterStatus: 'all', filterCategory: '' }).rows.length, 3);
});

test('filterSortPage sorts by date asc/desc', () => {
  const rows = [
    row({ id: 'a', expense_date: '2026-06-03' }),
    row({ id: 'b', expense_date: '2026-06-01' }),
    row({ id: 'c', expense_date: '2026-06-02' }),
  ];
  assert.deepStrictEqual(filterSortPage(rows, { sortBy: 'date', sortDir: 'asc' }).rows.map((r) => r.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(filterSortPage(rows, { sortBy: 'date', sortDir: 'desc' }).rows.map((r) => r.id), ['a', 'c', 'b']);
});

test('filterSortPage sorts by amount numerically (not lexically)', () => {
  const rows = [
    row({ id: 'a', amount: 9 }),
    row({ id: 'b', amount: 100 }),
    row({ id: 'c', amount: 20 }),
  ];
  assert.deepStrictEqual(filterSortPage(rows, { sortBy: 'amount', sortDir: 'asc' }).rows.map((r) => r.id), ['a', 'c', 'b']);
  assert.deepStrictEqual(filterSortPage(rows, { sortBy: 'amount', sortDir: 'desc' }).rows.map((r) => r.id), ['b', 'c', 'a']);
});

test('filterSortPage paginates and reports totals / page count', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(row({ id: 'r' + i, amount: i }));
  const p1 = filterSortPage(rows, { sortBy: 'amount', sortDir: 'asc', page: 1, pageSize: 10 });
  assert.strictEqual(p1.rows.length, 10);
  assert.strictEqual(p1.total, 25);
  assert.strictEqual(p1.pageCount, 3);
  assert.strictEqual(p1.rows[0].id, 'r0');

  const p3 = filterSortPage(rows, { sortBy: 'amount', sortDir: 'asc', page: 3, pageSize: 10 });
  assert.strictEqual(p3.rows.length, 5); // remainder
  assert.strictEqual(p3.rows[0].id, 'r20');
});

test('filterSortPage clamps out-of-range page numbers', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
  const high = filterSortPage(rows, { page: 99, pageSize: 2 });
  assert.strictEqual(high.page, 2); // clamped to last page
  assert.strictEqual(high.rows.length, 1);
  const low = filterSortPage(rows, { page: 0, pageSize: 2 });
  assert.strictEqual(low.page, 1); // clamped to first page
});

// --- badgesFor ------------------------------------------------------------

test('badgesFor returns no badges for a clean row', () => {
  assert.deepStrictEqual(badgesFor(row()), []);
});

test('badgesFor flags an anomaly and carries its reason (raw, for escaping at render)', () => {
  const badges = badgesFor(row({ anomaly: { flagged: true, reason: 'amount 10x median' } }));
  const anom = badges.find((b) => b.kind === 'anomaly');
  assert.ok(anom, 'expected an anomaly badge');
  assert.strictEqual(anom.reason, 'amount 10x median');
});

test('badgesFor treats a truthy-but-flagged=false anomaly object as not flagged', () => {
  assert.deepStrictEqual(badgesFor(row({ anomaly: { flagged: false } })), []);
  // A bare object with only a reason still counts as flagged (reason present).
  const b = badgesFor(row({ anomaly: { reason: 'suspicious' } }));
  assert.ok(b.some((x) => x.kind === 'anomaly'));
});

test('badgesFor flags low confidence when any field is "low"', () => {
  const badges = badgesFor(row({ confidence: { amount: 'high', merchant: 'low' } }));
  assert.ok(badges.some((b) => b.kind === 'low-confidence'));
  // all-high => no flag
  assert.ok(!badgesFor(row({ confidence: { amount: 'high', merchant: 'high' } }))
    .some((b) => b.kind === 'low-confidence'));
});

test('badgesFor flags currency-converted when amount_original / fx_rate present', () => {
  const badges = badgesFor(row({
    currency_original: 'EUR', amount_original: 8.5, fx_rate: 1.18, currency: 'USD',
  }));
  const fx = badges.find((b) => b.kind === 'converted');
  assert.ok(fx, 'expected a converted badge');
  assert.strictEqual(fx.original, 'EUR');
  assert.strictEqual(fx.amountOriginal, 8.5);
});

test('badgesFor is defensive against null/garbage rows', () => {
  assert.deepStrictEqual(badgesFor(null), []);
  assert.deepStrictEqual(badgesFor(undefined), []);
  assert.deepStrictEqual(badgesFor({}), []);
});

// --- categoryColor --------------------------------------------------------

test('categoryColor maps the known categories to stable class suffixes', () => {
  ['Food', 'Petrol', 'Software', 'Inventory', 'Others'].forEach((c) => {
    assert.strictEqual(typeof categoryColor(c), 'string');
    assert.ok(categoryColor(c).length > 0);
  });
  // Case-insensitive, and unknowns fall back to the Others bucket.
  assert.strictEqual(categoryColor('food'), categoryColor('Food'));
  assert.strictEqual(categoryColor('Mystery'), categoryColor('Others'));
  assert.strictEqual(categoryColor(null), categoryColor('Others'));
});

// --- patchBody ------------------------------------------------------------

test('patchBody returns only changed editable fields', () => {
  const original = row({ merchant: 'Acme', amount: 10, category: 'Food' });
  const edited = Object.assign({}, original, { merchant: 'Acme Corp', amount: 12 });
  assert.deepStrictEqual(patchBody(original, edited), { merchant: 'Acme Corp', amount: 12 });
});

test('patchBody returns {} when nothing changed', () => {
  const original = row();
  assert.deepStrictEqual(patchBody(original, Object.assign({}, original)), {});
});

test('patchBody NEVER includes account_id, even if the edited object carries it', () => {
  const original = row({ account_id: 'default', merchant: 'Acme' });
  const edited = Object.assign({}, original, { account_id: 'attacker', merchant: 'New' });
  const body = patchBody(original, edited);
  assert.ok(!('account_id' in body), 'account_id must never be sent to the server');
  assert.deepStrictEqual(body, { merchant: 'New' });
});

test('patchBody ignores non-editable / unknown fields', () => {
  const original = row({ merchant: 'Acme' });
  const edited = Object.assign({}, original, { id: 'HACKED', created_at: 'x', merchant: 'Acme', fx_rate: 9 });
  assert.deepStrictEqual(patchBody(original, edited), {});
});

test('patchBody is defensive against null inputs (never throws, never leaks account_id)', () => {
  assert.deepStrictEqual(patchBody(null, null), {});
  assert.deepStrictEqual(patchBody(row(), null), {});
  // null original => everything editable looks changed, but account_id is still excluded.
  const body = patchBody(null, row({ account_id: 'attacker' }));
  assert.ok(!('account_id' in body), 'account_id must never be sent');
  assert.ok('merchant' in body && 'amount' in body);
});

// --- XSS / escape (the load-bearing safety proof) -------------------------

test('hostile merchant/description/anomaly-reason render INERT via Escape.safeText', () => {
  const hostile = row({
    merchant: '<script>alert(1)</script>',
    remark: '"><img src=x onerror=alert(2)>',
    category: 'Food',
    anomaly: { flagged: true, reason: '<svg onload=alert(3)>weird' },
    line_items: [{ description: '</td><script>alert(4)</script>', amount: 1 }],
  });

  // The search index / row passes through unchanged (transform is pure)…
  const out = filterSortPage([hostile], { search: 'script' });
  assert.strictEqual(out.rows.length, 1);

  // …but every value the render layer emits is escaped: no raw executable markup.
  const merchantOut = Escape.safeText(out.rows[0].merchant);
  assert.ok(merchantOut.indexOf('<script>') === -1, 'raw <script> must not survive');
  assert.ok(merchantOut.indexOf('&lt;script&gt;') !== -1, 'must be entity-encoded');

  const remarkOut = Escape.safeText(out.rows[0].remark);
  assert.ok(remarkOut.indexOf('<img') === -1);
  assert.ok(remarkOut.indexOf('onerror') !== -1 && remarkOut.indexOf('<') === -1);

  const reason = badgesFor(hostile).find((b) => b.kind === 'anomaly').reason;
  const reasonOut = Escape.safeText(reason);
  assert.ok(reasonOut.indexOf('<svg') === -1, 'raw <svg> must not survive');

  const liOut = Escape.safeText(out.rows[0].line_items[0].description);
  assert.ok(liOut.indexOf('<script>') === -1 && liOut.indexOf('</td>') === -1);
});

test('control bytes are stripped by safeText before display', () => {
  const dirty = 'A BCD';
  assert.strictEqual(Escape.safeText(dirty), 'ABCD');
});

// --- receiptPath (P6 hardening §4.1 client fix) ----------------------------
// The drawer no longer renders /receipt/:fileId as a plain <a href> (once checkDash
// gates that route, a bare navigation can't carry the bearer token and would 401).
// It now fetches the image via Api.fetchBlob(receiptPath(fileId)) and renders an <img>
// from an object URL. That DOM/fetch wiring is browser-only (human-QA territory, see
// Task K), but the URL builder itself is pure and is the part worth a unit test:
// fileId is untrusted (OCR/Telegram-sourced), so it must always be percent-encoded,
// never string-concatenated raw into the path.
test('receiptPath: builds /receipt/<encoded fileId>', () => {
  assert.strictEqual(receiptPath('abc123'), '/receipt/abc123');
});

test('receiptPath: percent-encodes a hostile/path-breaking fileId (no raw markup, no raw slashes)', () => {
  const hostile = '../../etc/passwd?x=<script>alert(1)</script>';
  const out = receiptPath(hostile);
  assert.strictEqual(out.indexOf('/receipt/'), 0);
  assert.ok(out.indexOf('<script>') === -1, 'must not carry raw markup');
  assert.strictEqual(out, '/receipt/' + encodeURIComponent(hostile));
});

test('receiptPath: null/undefined fileId does not throw, yields a safe empty-ish path', () => {
  assert.strictEqual(receiptPath(null), '/receipt/');
  assert.strictEqual(receiptPath(undefined), '/receipt/');
});
