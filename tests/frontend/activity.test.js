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
const {
  filterSortPage, badgesFor, categoryColor, patchBody, receiptPath, normaliseViewMode,
  resolveCategories, labelFor, awaitingCategoryRows, receiptByIdPath, hasReceiptImage,
} = Activity;

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

// --- receiptByIdPath / hasReceiptImage (ADR-018 durable receipt images) ----

test('receiptByIdPath builds the by-id serve URL, encoding the id', () => {
  assert.strictEqual(receiptByIdPath('abc-123'), '/receipt/by-id/abc-123');
  assert.strictEqual(receiptByIdPath('a/b c'), '/receipt/by-id/a%2Fb%20c');
});

test('hasReceiptImage is true when EITHER receipt_url or receipt_file_id is present', () => {
  assert.strictEqual(hasReceiptImage({ receipt_url: 'default/x.jpg' }), true);
  assert.strictEqual(hasReceiptImage({ receipt_file_id: 'fid' }), true);
  assert.strictEqual(hasReceiptImage({ receipt_url: null, receipt_file_id: null }), false);
  assert.strictEqual(hasReceiptImage({}), false);
  assert.strictEqual(hasReceiptImage(null), false);
});

// --- awaitingCategoryRows (dashboard category-picker) ---------------------

test('awaitingCategoryRows returns only rows whose status is awaiting_category', () => {
  const rows = [
    row({ id: 'a', status: 'saved' }),
    row({ id: 'b', status: 'awaiting_category', category: '__pending__' }),
    row({ id: 'c', status: 'needs_review' }),
    row({ id: 'd', status: 'awaiting_category', category: '__pending__' }),
  ];
  assert.deepStrictEqual(awaitingCategoryRows(rows).map((r) => r.id), ['b', 'd']);
});

test('awaitingCategoryRows tolerates null / non-array / empty (never throws)', () => {
  assert.deepStrictEqual(awaitingCategoryRows(null), []);
  assert.deepStrictEqual(awaitingCategoryRows(undefined), []);
  assert.deepStrictEqual(awaitingCategoryRows([]), []);
  assert.deepStrictEqual(awaitingCategoryRows('nope'), []);
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

// --- categoryColor ----------------------------------------------------------
// Deterministic palette-index colour assignment (dynamic-categories fix): with
// 18+ real chart-of-accounts categories (lib/categorize.js CATEGORIES), a
// hardcoded name->class map doesn't scale and drifts (the bug this branch
// fixes). categoryColor now hashes ANY category string to one of a fixed
// palette of class suffixes ('c0'..'c9'); only empty/null/'Others' get the
// dedicated neutral 'others' bucket — an arbitrary unmatched real category
// (e.g. "Mystery") gets its own stable palette slot, NOT silently merged into
// Others (that silent-merge was the old, stale 5-bucket behaviour).

test('categoryColor: same category string always maps to the same colour', () => {
  ['Meals & Entertainment', 'Groceries', 'Fuel & Auto', 'Software & Subscriptions', 'Random Category']
    .forEach((c) => {
      const a = categoryColor(c);
      const b = categoryColor(c);
      assert.strictEqual(a, b);
      assert.strictEqual(typeof a, 'string');
      assert.ok(a.length > 0);
    });
});

test('categoryColor: is case-insensitive / trims whitespace for the SAME identity', () => {
  assert.strictEqual(categoryColor('Groceries'), categoryColor('groceries'));
  assert.strictEqual(categoryColor('Groceries'), categoryColor('  Groceries  '));
  assert.strictEqual(categoryColor('Groceries'), categoryColor('GROCERIES'));
});

test('categoryColor: different strings are spread across the palette (not all one colour)', () => {
  const categories = [
    'Meals & Entertainment', 'Groceries', 'Fuel & Auto', 'Travel', 'Lodging',
    'Software & Subscriptions', 'Office Supplies', 'Utilities', 'Rent & Lease',
    'Professional Services', 'Marketing & Advertising', 'Inventory & COGS',
    'Equipment & Hardware', 'Shipping & Postage', 'Bank & Fees', 'Healthcare',
    'Education & Training',
  ];
  const colors = new Set(categories.map((c) => categoryColor(c)));
  // Not a strict pigeonhole (hash collisions are fine) but it must not collapse
  // to a single bucket for 17 distinct real category names.
  assert.ok(colors.size > 3, 'expected categories to spread across multiple palette slots, got ' + colors.size);
});

test('categoryColor: empty / "Others" / undefined fall back to the neutral "others" bucket', () => {
  assert.strictEqual(categoryColor(null), 'others');
  assert.strictEqual(categoryColor(undefined), 'others');
  assert.strictEqual(categoryColor(''), 'others');
  assert.strictEqual(categoryColor('   '), 'others');
  assert.strictEqual(categoryColor('Others'), 'others');
  assert.strictEqual(categoryColor('others'), 'others');
  assert.strictEqual(categoryColor('OTHERS'), 'others');
});

test('categoryColor: a real, unmatched category gets its OWN slot, not silently merged into Others', () => {
  // This is the exact behaviour the old hardcoded 5-bucket categoryColor got
  // wrong (any unknown category silently became "Others" grey).
  assert.notStrictEqual(categoryColor('Mystery Category'), categoryColor('Others'));
});

test('categoryColor: never throws on weird input', () => {
  [123, true, false, {}, [], NaN, Symbol('x'), function () {}].forEach((v) => {
    assert.doesNotThrow(() => categoryColor(v));
    assert.strictEqual(typeof categoryColor(v), 'string');
  });
});

test('categoryColor: returned class suffix is always drawn from a small fixed palette', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(categoryColor('Category #' + i));
  seen.forEach((s) => assert.ok(/^(c\d+|others)$/.test(s), 'unexpected class suffix: ' + s));
  // The palette is small and fixed (~8-10 colours) so 200 distinct names must
  // collapse into a small set of slots, not 200 unique classes.
  assert.ok(seen.size <= 12, 'expected a small fixed palette, got ' + seen.size + ' distinct classes');
});

// --- resolveCategories -------------------------------------------------------
// Builds the live category list the filter dropdown / edit-drawer dropdown use,
// from a /api/config-shaped response ({ categories: [...] }). Falls back to a
// small safe default when the config hasn't resolved yet / is malformed, so the
// dropdown is never empty and the app never throws.

test('resolveCategories: returns the real category list from a live /api/config-shaped object', () => {
  const REAL_18 = [
    'Meals & Entertainment', 'Groceries', 'Fuel & Auto', 'Travel', 'Lodging',
    'Software & Subscriptions', 'Office Supplies', 'Utilities', 'Rent & Lease',
    'Professional Services', 'Marketing & Advertising', 'Inventory & COGS',
    'Equipment & Hardware', 'Shipping & Postage', 'Bank & Fees', 'Healthcare',
    'Education & Training', 'Others',
  ];
  const cfg = { auth_required: false, default_currency: 'USD', categories: REAL_18 };
  const out = resolveCategories(cfg);
  assert.deepStrictEqual(out, REAL_18);
  assert.strictEqual(out.length, 18);
  // Not the old stale 5-name stub.
  assert.ok(out.includes('Meals & Entertainment'));
  assert.ok(!Object.is(out, ['Food', 'Petrol', 'Software', 'Inventory', 'Others']));
});

test('resolveCategories: config not yet resolved (undefined/null) falls back to a safe default list', () => {
  assert.deepStrictEqual(resolveCategories(undefined), ['Others']);
  assert.deepStrictEqual(resolveCategories(null), ['Others']);
  assert.doesNotThrow(() => resolveCategories());
});

test('resolveCategories: malformed categories field (missing / not an array / empty) falls back safely', () => {
  assert.deepStrictEqual(resolveCategories({}), ['Others']);
  assert.deepStrictEqual(resolveCategories({ categories: null }), ['Others']);
  assert.deepStrictEqual(resolveCategories({ categories: 'not-an-array' }), ['Others']);
  assert.deepStrictEqual(resolveCategories({ categories: [] }), ['Others']);
  assert.deepStrictEqual(resolveCategories({ categories: 123 }), ['Others']);
});

test('resolveCategories: never throws on hostile/garbage input', () => {
  [null, undefined, 123, 'x', [], { categories: [1, 2, {}] }, { categories: [null, undefined] }].forEach((v) => {
    assert.doesNotThrow(() => resolveCategories(v));
  });
});

// --- labelFor (FieldSpec-aware labels) --------------------------------------
// labelFor(key, fieldSpec, fallback) looks up the customer's own field label
// from their FieldSpec (GET /api/templates -> { columns:[{key,label,...}] })
// and falls back to the hardcoded English label when the key isn't present or
// the FieldSpec is missing/malformed. Pure, never throws.

function fieldSpec(columns) {
  return { account_id: 'default', columns: columns, updated_at: '2026-07-01T00:00:00Z' };
}

test('labelFor: returns the customer\'s own label when the key exists in their FieldSpec', () => {
  const spec = fieldSpec([{ key: 'merchant', label: 'Vendor', type: 'text', required: true }]);
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), 'Vendor');
});

test('labelFor: falls back to the hardcoded label when the key is absent from the FieldSpec', () => {
  const spec = fieldSpec([{ key: 'amount', label: 'Total', type: 'number', required: true }]);
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), 'Merchant');
});

test('labelFor: falls back when fieldSpec is null/undefined/malformed', () => {
  assert.strictEqual(labelFor('merchant', null, 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', undefined, 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', {}, 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', 'garbage', 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', 123, 'Merchant'), 'Merchant');
});

test('labelFor: falls back when fieldSpec.columns is missing or not an array', () => {
  assert.strictEqual(labelFor('merchant', { account_id: 'x' }, 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', { columns: 'not-an-array' }, 'Merchant'), 'Merchant');
  assert.strictEqual(labelFor('merchant', { columns: null }, 'Merchant'), 'Merchant');
});

test('labelFor: falls back when the matching column has no usable label', () => {
  const spec = fieldSpec([{ key: 'merchant', label: '', type: 'text' }]);
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), 'Merchant');
  const spec2 = fieldSpec([{ key: 'merchant', label: null, type: 'text' }]);
  assert.strictEqual(labelFor('merchant', spec2, 'Merchant'), 'Merchant');
  const spec3 = fieldSpec([{ key: 'merchant' }]);
  assert.strictEqual(labelFor('merchant', spec3, 'Merchant'), 'Merchant');
});

test('labelFor: never throws on hostile/garbage columns entries', () => {
  const spec = fieldSpec([null, undefined, 123, 'x', {}, { key: null, label: 'y' }]);
  assert.doesNotThrow(() => labelFor('merchant', spec, 'Merchant'));
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), 'Merchant');
});

test('labelFor: a hostile customer-supplied label is returned as-is (raw) — rendering, not this function, must escape it', () => {
  const spec = fieldSpec([{ key: 'merchant', label: '<script>alert(1)</script>', type: 'text' }]);
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), '<script>alert(1)</script>');
});

test('labelFor: a hostile FieldSpec label used as a header is inert once escaped at render time (mirrors the file\'s XSS bar)', () => {
  const spec = fieldSpec([{ key: 'merchant', label: '<img src=x onerror=alert(1)>', type: 'text' }]);
  const label = labelFor('merchant', spec, 'Merchant');
  const escaped = Escape.safeText(label);
  assert.ok(escaped.indexOf('<img') === -1, 'raw <img> must not survive escaping');
  assert.ok(escaped.indexOf('onerror') !== -1 && escaped.indexOf('<') === -1);
});

test('labelFor: works for every known table column key', () => {
  const spec = fieldSpec([
    { key: 'merchant', label: 'Vendor' },
    { key: 'expense_date', label: 'Txn Date' },
    { key: 'amount', label: 'Total Due' },
    { key: 'category', label: 'Bucket' },
  ]);
  assert.strictEqual(labelFor('merchant', spec, 'Merchant'), 'Vendor');
  assert.strictEqual(labelFor('expense_date', spec, 'Date'), 'Txn Date');
  assert.strictEqual(labelFor('amount', spec, 'Amount'), 'Total Due');
  assert.strictEqual(labelFor('category', spec, 'Category'), 'Bucket');
  // status is a system concept never present in a customer FieldSpec — always
  // the hardcoded fallback regardless of what's in columns.
  assert.strictEqual(labelFor('status', spec, 'Status'), 'Status');
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

// --- filterSortPage: dateFrom / dateTo (Task L) ----------------------------

test('filterSortPage: dateFrom/dateTo applies an inclusive range on expense_date', () => {
  const rows = [
    row({ id: 'a', expense_date: '2026-06-01' }),
    row({ id: 'b', expense_date: '2026-06-15' }),
    row({ id: 'c', expense_date: '2026-06-30' }),
  ];
  assert.deepStrictEqual(
    filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-15' }).rows.map((r) => r.id),
    ['a', 'b'],
  );
  // boundaries are inclusive
  assert.deepStrictEqual(
    filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-01' }).rows.map((r) => r.id),
    ['a'],
  );
  assert.deepStrictEqual(
    filterSortPage(rows, { dateFrom: '2026-06-30', dateTo: '2026-06-30' }).rows.map((r) => r.id),
    ['c'],
  );
});

test('filterSortPage: dateFrom only / dateTo only work as open-ended ranges', () => {
  const rows = [
    row({ id: 'a', expense_date: '2026-06-01' }),
    row({ id: 'b', expense_date: '2026-06-15' }),
    row({ id: 'c', expense_date: '2026-06-30' }),
  ];
  assert.deepStrictEqual(
    filterSortPage(rows, { dateFrom: '2026-06-15' }).rows.map((r) => r.id),
    ['b', 'c'],
  );
  assert.deepStrictEqual(
    filterSortPage(rows, { dateTo: '2026-06-15' }).rows.map((r) => r.id),
    ['a', 'b'],
  );
});

test('filterSortPage: no dateFrom/dateTo set is a no-op (existing behavior unchanged)', () => {
  const rows = [row({ id: 'a', expense_date: '2026-06-01' }), row({ id: 'b', expense_date: '' })];
  assert.strictEqual(filterSortPage(rows, {}).rows.length, 2);
  assert.strictEqual(filterSortPage(rows, { dateFrom: '', dateTo: '' }).rows.length, 2);
});

test('filterSortPage: malformed/non-ISO expense_date is excluded from a range filter, never throws', () => {
  const rows = [
    row({ id: 'a', expense_date: '2026-06-10' }),
    row({ id: 'b', expense_date: 'not-a-date' }),
    row({ id: 'c', expense_date: null }),
    row({ id: 'd', expense_date: undefined }),
    row({ id: 'e', expense_date: '' }),
  ];
  assert.doesNotThrow(() => filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-30' }));
  const out = filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-30' }).rows.map((r) => r.id);
  assert.deepStrictEqual(out, ['a']);
});

test('filterSortPage: dateFrom/dateTo on an empty result set is handled gracefully', () => {
  const rows = [row({ id: 'a', expense_date: '2026-01-01' })];
  const out = filterSortPage(rows, { dateFrom: '2027-01-01', dateTo: '2027-12-31' });
  assert.deepStrictEqual(out.rows, []);
  assert.strictEqual(out.total, 0);
  assert.strictEqual(out.pageCount, 1);
});

test('filterSortPage: dateFrom/dateTo composes with search/status/category filters', () => {
  const rows = [
    row({ id: 'a', expense_date: '2026-06-01', category: 'Food' }),
    row({ id: 'b', expense_date: '2026-06-01', category: 'Petrol' }),
    row({ id: 'c', expense_date: '2026-07-01', category: 'Food' }),
  ];
  const out = filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-30', filterCategory: 'Food' });
  assert.deepStrictEqual(out.rows.map((r) => r.id), ['a']);
});

// --- badgesFor: shared between table row and card rendering (Task L) ------
// The table row and the new card view both build their badge chips by calling the
// SAME badgesFor(row) + a single badgeChips() DOM builder (see activity.js) rather
// than each having their own copy. We can't render DOM here (no jsdom), but we can
// prove the pure descriptor layer both paths are built from is deterministic and
// produces identical output for the identical input, which is what "no behavior
// drift between the two render paths" reduces to once there is only one DOM builder.
test('badgesFor: identical row produces identical badge descriptors on repeated calls (no hidden state)', () => {
  const hostile = row({
    anomaly: { flagged: true, reason: 'weird' },
    confidence: { merchant: 'low' },
    amount_original: 8.5, fx_rate: 1.18, currency_original: 'EUR',
  });
  const first = badgesFor(hostile);
  const second = badgesFor(hostile);
  assert.deepStrictEqual(first, second);
});

// --- normaliseViewMode: table/cards toggle persistence (Task L) -----------

test('normaliseViewMode: unset (null/undefined) defaults to "table"', () => {
  assert.strictEqual(normaliseViewMode(null), 'table');
  assert.strictEqual(normaliseViewMode(undefined), 'table');
});

test('normaliseViewMode: "table" and "cards" pass through unchanged', () => {
  assert.strictEqual(normaliseViewMode('table'), 'table');
  assert.strictEqual(normaliseViewMode('cards'), 'cards');
});

test('normaliseViewMode: garbage/unknown values fall back to "table"', () => {
  assert.strictEqual(normaliseViewMode('grid'), 'table');
  assert.strictEqual(normaliseViewMode('<script>alert(1)</script>'), 'table');
  assert.strictEqual(normaliseViewMode(123), 'table');
  assert.strictEqual(normaliseViewMode({}), 'table');
});

// --- card remark/merchant XSS safety (Task L) ------------------------------
// The card view renders remark/merchant through the same Escape.setText/safeText
// path as the table (see activity.js buildCard). Mirrors the existing hostile-value
// pattern above: assert the escaped string never carries raw executable markup.
test('hostile card remark/merchant render INERT via Escape.safeText (same bar as table)', () => {
  const hostile = row({
    merchant: '<img src=x onerror=alert(1)>',
    remark: '<script>alert(2)</script>' + 'x'.repeat(200),
  });
  const merchantOut = Escape.safeText(hostile.merchant);
  assert.ok(merchantOut.indexOf('<img') === -1);
  assert.ok(merchantOut.indexOf('onerror') !== -1 && merchantOut.indexOf('<') === -1);

  const remarkOut = Escape.safeText(hostile.remark);
  assert.ok(remarkOut.indexOf('<script>') === -1);
  assert.ok(remarkOut.indexOf('&lt;script&gt;') !== -1);
});
