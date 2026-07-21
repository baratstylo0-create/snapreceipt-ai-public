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
  normaliseDatePreset, thisMonthRange, monthRange, displayDate, mytDateOf,
  resolveCategories, labelFor, awaitingCategoryRows, receiptByIdPath, hasReceiptImage,
  bulkApprovePath, bulkDeletePath, allSelected, toggleAllSelected, summarizeBulkResult,
  deletedRowsPath, restorePath, isRejected, recategorizeBody, permanentDeletePath, reviewMetaParts,
  purgeReminderDate, DELETED_RETENTION_DAYS,
  receiptErrorMessage, statusLabel, decisionErrorText, reviewDecisionError, mixedCategoryLabel, lineItemDetails,
  branchNamesFromResponse, staffNamesFromResponse, activityBranchOptions,
  displayBranchName, displayStaffName,
} = Activity;

// A representative /api/expenses row (see schema.sql expenses table).
function row(over) {
  return Object.assign({
    id: 'r1',
    account_id: 'default',
    merchant: 'Acme',
    expense_date: '2026-06-01',
    created_at: '2026-06-01T00:00:00.000Z',
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
  assert.strictEqual(receiptByIdPath('abc-123'), '/api/receipt/by-id/abc-123');
  assert.strictEqual(receiptByIdPath('a/b c'), '/api/receipt/by-id/a%2Fb%20c');
});

test('hasReceiptImage is true when EITHER receipt_url or receipt_file_id is present', () => {
  assert.strictEqual(hasReceiptImage({ receipt_url: 'default/x.jpg' }), true);
  assert.strictEqual(hasReceiptImage({ receipt_file_id: 'fid' }), true);
  assert.strictEqual(hasReceiptImage({ receipt_url: null, receipt_file_id: null }), false);
  assert.strictEqual(hasReceiptImage({}), false);
  assert.strictEqual(hasReceiptImage(null), false);
});

// --- receiptErrorMessage (Owner-reported 2026-07-11: dead-end "could not load" for a --
// --- permanently-gone photo looked identical to a one-off network hiccup) ---------
// /receipt/by-id/:id returns 404 specifically when neither the durable Storage copy
// nor the live Telegram proxy can produce bytes (row not found, Storage object missing,
// or a stale/invalid file_id Telegram now rejects) -- the one case where "try again" is
// false hope. Every other failure (401 session, 502 upstream) IS worth retrying.

test('receiptErrorMessage: a 404 gets the "no photo available, re-send" message', () => {
  assert.match(receiptErrorMessage({ status: 404 }), /re-send it in Telegram/);
});

test('receiptErrorMessage: any other status (or no status) keeps the generic retry message', () => {
  assert.strictEqual(receiptErrorMessage({ status: 401 }), 'Could not load the receipt. Please try again shortly.');
  assert.strictEqual(receiptErrorMessage({ status: 502 }), 'Could not load the receipt. Please try again shortly.');
  assert.strictEqual(receiptErrorMessage(undefined), 'Could not load the receipt. Please try again shortly.');
  assert.strictEqual(receiptErrorMessage({}), 'Could not load the receipt. Please try again shortly.');
});

// --- statusLabel (Owner 2026-07-12: raw snake_case "needs_review" leaked into the UI) --
test('statusLabel: known machine statuses map to human labels ("needs_review" -> "Need Review")', () => {
  assert.strictEqual(statusLabel('needs_review'), 'Need Review');
  assert.strictEqual(statusLabel('saved'), 'Saved');
  assert.strictEqual(statusLabel('approved'), 'Approved');
  assert.strictEqual(statusLabel('rejected'), 'Rejected');
  assert.strictEqual(statusLabel('awaiting_category'), 'Awaiting Category');
});

test('statusLabel: an unknown status is Title-Cased from its raw value; empty/garbage never throws', () => {
  assert.strictEqual(statusLabel('some_new_state'), 'Some New State');
  assert.strictEqual(statusLabel(''), '');
  assert.strictEqual(statusLabel(null), '');
  assert.strictEqual(statusLabel(undefined), '');
});

// --- decisionErrorText (Owner 2026-07-12: Approve failed with a bare "Action failed", --
// hiding the real 403 valve reason "the branch clerk decides first...") ------------------
test('decisionErrorText: surfaces the server\'s specific error message when present', () => {
  assert.strictEqual(
    decisionErrorText({ status: 403, body: { error: 'the branch clerk decides first — the admin valve opens 7 days after flagging' } }),
    'the branch clerk decides first — the admin valve opens 7 days after flagging');
  assert.strictEqual(
    decisionErrorText({ status: 409, body: { error: 'expense is not pending review (status=approved)' } }),
    'expense is not pending review (status=approved)');
});

test('decisionErrorText: falls back to the generic line when there is no server message', () => {
  assert.strictEqual(decisionErrorText(undefined), 'Action failed. Please try again.');
  assert.strictEqual(decisionErrorText({}), 'Action failed. Please try again.');
  assert.strictEqual(decisionErrorText({ status: 502, body: {} }), 'Action failed. Please try again.');
  assert.strictEqual(decisionErrorText({ body: { error: 42 } }), 'Action failed. Please try again.');
});

// --- reviewDecisionError (Owner-reported 2026-07-12: Approve/Reject showed "action fail") --
// The review buttons now disable on click (re-entrancy guard) so a double-click / Approve-then-
// Reject can't fire a second POST. When one does slip through (or another tab/user decided first),
// the backend returns 409 — which used to render the scary generic "Action failed" even though the
// decision actually succeeded. reviewDecisionError maps the thrown { status } to {message, resync}:
// 409 -> quietly re-sync the queue; 401 -> specific guidance; 403/anything else -> decisionErrorText's
// real-server-message-first behavior (a merge of two independent same-day fixes for the same bug —
// #215's decisionErrorText already surfaces the real 403 valve reason, so 403 defers to it instead of
// a second hardcoded generic string that would have hidden that reason again).
// Pure so the mapping is unit-testable without a fetch/DOM (mirrors receiptErrorMessage).

test('reviewDecisionError: 409 (already decided) re-syncs the queue instead of showing a failure', () => {
  const out = reviewDecisionError({ status: 409 });
  assert.strictEqual(out.resync, true, '409 must trigger a queue re-sync, not a dead-end error');
  assert.match(out.message, /already decided/i);
});

test('reviewDecisionError: 401 gets specific, non-generic guidance and does NOT re-sync', () => {
  const s401 = reviewDecisionError({ status: 401 });
  assert.strictEqual(s401.resync, false);
  assert.match(s401.message, /session expired/i);
});

test('reviewDecisionError: 403 surfaces the real server reason when present (e.g. the valve message)', () => {
  const out = reviewDecisionError({ status: 403, body: { error: 'the branch clerk decides first, the admin valve opens 7 days after flagging' } });
  assert.strictEqual(out.resync, false);
  assert.strictEqual(out.message, 'the branch clerk decides first, the admin valve opens 7 days after flagging');
});

test('reviewDecisionError: any other status (400/404/502/none), or a 403 with no server message, keeps the generic retry, no re-sync', () => {
  [400, 404, 502].forEach((status) => {
    const out = reviewDecisionError({ status });
    assert.strictEqual(out.resync, false);
    assert.strictEqual(out.message, 'Action failed. Please try again.');
  });
  assert.strictEqual(reviewDecisionError({ status: 403 }).message, 'Action failed. Please try again.');
  // tolerates a thrown value with no status / a bare network error, never throws
  assert.doesNotThrow(() => reviewDecisionError(undefined));
  assert.strictEqual(reviewDecisionError(undefined).message, 'Action failed. Please try again.');
  assert.strictEqual(reviewDecisionError({}).resync, false);
});

// --- reviewMetaParts (review-queue card: receipt details, Owner 2026-07-10) --
// The review card now shows the receipt's key fields inline so an admin/clerk can decide
// approve/reject without opening it separately. reviewMetaParts is the pure builder of the
// muted meta line: [date, category, ref], skipping blanks and the '__pending__' sentinel.

test('reviewMetaParts: returns date, category and ref in order, skipping blanks', () => {
  assert.deepStrictEqual(
    reviewMetaParts({ expense_date: '2026-07-01', category: 'Food', voucher_no: 'RC-2026-0041' }),
    ['2026-07-01', 'Food', 'RC-2026-0041'],
  );
  assert.deepStrictEqual(
    reviewMetaParts({ expense_date: '2026-07-01', category: '', voucher_no: '' }),
    ['2026-07-01'],
  );
});

test('reviewMetaParts: skips the __pending__ category sentinel (never leaks it to the UI)', () => {
  assert.deepStrictEqual(
    reviewMetaParts({ expense_date: '2026-07-02', category: '__pending__' }),
    ['2026-07-02'],
  );
});

test('reviewMetaParts: tolerates null / non-object / missing fields, never throws', () => {
  assert.deepStrictEqual(reviewMetaParts(null), []);
  assert.deepStrictEqual(reviewMetaParts(undefined), []);
  assert.deepStrictEqual(reviewMetaParts({}), []);
  assert.deepStrictEqual(reviewMetaParts('nope'), []);
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

// QA report #10b fix: the real shape lib/ocr.js/lib/anomaly.js writes is
// `{ flagged, reasons: [{type, detail, severity}] }` — there is no singular `.reason`
// field. Fixtures below use the REAL shape (see tests/frontend/activity.anomaly.test.js
// for the dedicated regression coverage of this bug fix).
test('badgesFor flags an anomaly and carries its reason (raw, for escaping at render)', () => {
  const badges = badgesFor(row({ anomaly: { flagged: true, reasons: [{ detail: 'amount 10x median' }] } }));
  const anom = badges.find((b) => b.kind === 'anomaly');
  assert.ok(anom, 'expected an anomaly badge');
  assert.strictEqual(anom.reason, 'amount 10x median');
});

test('badgesFor treats a truthy-but-flagged=false anomaly object as not flagged', () => {
  assert.deepStrictEqual(badgesFor(row({ anomaly: { flagged: false } })), []);
  // A bare object with reasons but NO explicit flagged:true is NOT treated as flagged —
  // flagged:true is the one authoritative signal (matches the real writer's contract).
  const b = badgesFor(row({ anomaly: { reasons: [{ detail: 'suspicious' }] } }));
  assert.ok(!b.some((x) => x.kind === 'anomaly'));
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

// QA fix (PR #175): the edit-drawer Status field is now a <select> populated with
// STATUS_OPTIONS (saved/needs_review/approved/rejected). A row can legitimately be in an
// auto-only sentinel status (awaiting_category/awaiting_remark, set by the OCR pipeline,
// not user-selectable) when the drawer opens; the drawer seeds its edited copy straight
// from the row and never forces it onto an in-list value. Opening the drawer and saving
// without touching Status must therefore never rewrite a sentinel status onto the server.
test('patchBody: an unmodified sentinel status (awaiting_category) is never sent as a change', () => {
  const original = row({ status: 'awaiting_category' });
  const edited = Object.assign({}, original); // drawer opened, Status left untouched
  const body = patchBody(original, edited);
  assert.ok(!('status' in body), 'an untouched sentinel status must not be re-sent to the server');
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
test('receiptPath: builds /api/receipt/<encoded fileId> (ADR-027 collision-proof path)', () => {
  assert.strictEqual(receiptPath('abc123'), '/api/receipt/abc123');
});

test('receiptPath: percent-encodes a hostile/path-breaking fileId (no raw markup, no raw slashes)', () => {
  const hostile = '../../etc/passwd?x=<script>alert(1)</script>';
  const out = receiptPath(hostile);
  assert.strictEqual(out.indexOf('/api/receipt/'), 0);
  assert.ok(out.indexOf('<script>') === -1, 'must not carry raw markup');
  assert.strictEqual(out, '/api/receipt/' + encodeURIComponent(hostile));
});

test('receiptPath: null/undefined fileId does not throw, yields a safe empty-ish path', () => {
  assert.strictEqual(receiptPath(null), '/api/receipt/');
  assert.strictEqual(receiptPath(undefined), '/api/receipt/');
});

// --- filterSortPage: dateFrom / dateTo (Task L) ----------------------------

test('filterSortPage: dateFrom/dateTo applies an inclusive range on created_at (Malaysia time), not expense_date', () => {
  const rows = [
    row({ id: 'a', created_at: '2026-06-01T00:00:00.000Z' }),
    row({ id: 'b', created_at: '2026-06-15T00:00:00.000Z' }),
    row({ id: 'c', created_at: '2026-06-30T00:00:00.000Z' }),
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
    row({ id: 'a', created_at: '2026-06-01T00:00:00.000Z' }),
    row({ id: 'b', created_at: '2026-06-15T00:00:00.000Z' }),
    row({ id: 'c', created_at: '2026-06-30T00:00:00.000Z' }),
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

test('filterSortPage: malformed/non-ISO created_at is excluded from a range filter, never throws', () => {
  const rows = [
    row({ id: 'a', created_at: '2026-06-10T00:00:00.000Z' }),
    row({ id: 'b', created_at: 'not-a-date' }),
    row({ id: 'c', created_at: null }),
    row({ id: 'd', created_at: undefined }),
    row({ id: 'e', created_at: '' }),
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
    row({ id: 'a', created_at: '2026-06-01T00:00:00.000Z', category: 'Food' }),
    row({ id: 'b', created_at: '2026-06-01T00:00:00.000Z', category: 'Petrol' }),
    row({ id: 'c', created_at: '2026-07-01T00:00:00.000Z', category: 'Food' }),
  ];
  const out = filterSortPage(rows, { dateFrom: '2026-06-01', dateTo: '2026-06-30', filterCategory: 'Food' });
  assert.deepStrictEqual(out.rows.map((r) => r.id), ['a']);
});

// 2026-07-21 (live bug): a receipt SCANNED today, whose OCR-read expense_date is
// wildly wrong/backdated to a different month, used to silently vanish from "This
// Month" — the dashboard filtered by expense_date while the bot's own Today
// Bills/Weekly Record (already fixed 2026-07-04 for the identical reason) filtered by
// created_at. This locks in the fix: expense_date must now be completely IGNORED by
// the date-range filter, only created_at (when it was actually captured) matters.
test('filterSortPage: a receipt captured today but with a garbage/backdated expense_date still matches "This Month" (the live bug)', () => {
  const rows = [
    row({ id: 'good', created_at: '2026-07-21T02:00:00.000Z', expense_date: '2024-08-21' }),
  ];
  const range = thisMonthRange(new Date(2026, 6, 21)); // 2026-07-21 (local)
  const out = filterSortPage(rows, { dateFrom: range.from, dateTo: range.to });
  assert.deepStrictEqual(out.rows.map((r) => r.id), ['good'],
    'created_at (today) must win — expense_date being in a totally different year must not hide this row');
});

test('mytDateOf: shifts a UTC timestamp to its Malaysia-time (UTC+8) calendar date', () => {
  assert.strictEqual(mytDateOf('2026-07-20T20:00:00.000Z'), '2026-07-21', '20:00 UTC = 04:00 MYT next day');
  assert.strictEqual(mytDateOf('2026-07-21T02:00:00.000Z'), '2026-07-21', '02:00 UTC = 10:00 MYT same day');
});

test('mytDateOf: unparseable/empty values return null (excluded from range filters, never thrown)', () => {
  assert.strictEqual(mytDateOf('not-a-date'), null);
  assert.strictEqual(mytDateOf(null), null);
  assert.strictEqual(mytDateOf(undefined), null);
  assert.strictEqual(mytDateOf(''), null);
});

// --- Date filter presets (QA 2026-07-14, Untitled document (1).md): This Month /
// Month Selection / Custom Period + displayed dates in YYYY/MM/DD. -----------------

test('normaliseDatePreset: each real value passes through unchanged', () => {
  assert.strictEqual(normaliseDatePreset('month'), 'month');
  assert.strictEqual(normaliseDatePreset('pick'), 'pick');
  assert.strictEqual(normaliseDatePreset('custom'), 'custom');
});

test('normaliseDatePreset: garbage/unknown/null falls back to "month" (This Month is the default)', () => {
  assert.strictEqual(normaliseDatePreset(null), 'month');
  assert.strictEqual(normaliseDatePreset(undefined), 'month');
  assert.strictEqual(normaliseDatePreset(''), 'month');
  assert.strictEqual(normaliseDatePreset('yesterday'), 'month');
  assert.strictEqual(normaliseDatePreset({}), 'month');
});

test('thisMonthRange: 1st-of-month through today, using the given clock', () => {
  const r = thisMonthRange(new Date(2026, 6, 14)); // 2026-07-14 (local)
  assert.deepStrictEqual(r, { from: '2026-07-01', to: '2026-07-14' });
});

test('thisMonthRange: pads single-digit month/day', () => {
  const r = thisMonthRange(new Date(2026, 0, 5)); // 2026-01-05
  assert.deepStrictEqual(r, { from: '2026-01-01', to: '2026-01-05' });
});

test('thisMonthRange: an invalid clock falls back to "now" rather than throwing', () => {
  assert.doesNotThrow(() => thisMonthRange(new Date(NaN)));
  assert.doesNotThrow(() => thisMonthRange(null));
});

test('monthRange: a 31-day month', () => {
  assert.deepStrictEqual(monthRange('2026-07'), { from: '2026-07-01', to: '2026-07-31' });
});

test('monthRange: a 30-day month', () => {
  assert.deepStrictEqual(monthRange('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
});

test('monthRange: February — leap vs non-leap year', () => {
  assert.deepStrictEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' }, '2028 is a leap year');
  assert.deepStrictEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' }, '2026 is not a leap year');
});

test('monthRange: malformed input returns null, never throws', () => {
  assert.strictEqual(monthRange('2026-13'), null);
  assert.strictEqual(monthRange('2026-00'), null);
  assert.strictEqual(monthRange('July 2026'), null);
  assert.strictEqual(monthRange(''), null);
  assert.strictEqual(monthRange(null), null);
  assert.strictEqual(monthRange(undefined), null);
});

test('displayDate: ISO date -> YYYY/MM/DD', () => {
  assert.strictEqual(displayDate('2026-07-08'), '2026/07/08');
});

test('displayDate: a timestamp suffix is stripped to just the date', () => {
  assert.strictEqual(displayDate('2026-07-08T10:15:00Z'), '2026/07/08');
});

test('displayDate: a non-ISO / messy OCR date falls back to the raw string, never blanked', () => {
  assert.strictEqual(displayDate('08 July 2026'), '08 July 2026');
  assert.strictEqual(displayDate('not a date'), 'not a date');
});

test('displayDate: null/undefined/empty never throws, returns empty string', () => {
  assert.strictEqual(displayDate(null), '');
  assert.strictEqual(displayDate(undefined), '');
  assert.strictEqual(displayDate(''), '');
});

test('monthRange -> filterSortPage: selects exactly one calendar month, nothing outside it', () => {
  const rows = [
    row({ id: 'prev', created_at: '2026-06-30T00:00:00.000Z' }),
    row({ id: 'a', created_at: '2026-07-01T00:00:00.000Z' }),
    row({ id: 'b', created_at: '2026-07-15T00:00:00.000Z' }),
    row({ id: 'c', created_at: '2026-07-31T00:00:00.000Z' }),
    row({ id: 'next', created_at: '2026-08-01T00:00:00.000Z' }),
  ];
  const r = monthRange('2026-07');
  const out = filterSortPage(rows, { dateFrom: r.from, dateTo: r.to });
  assert.deepStrictEqual(out.rows.map((x) => x.id).sort(), ['a', 'b', 'c']);
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

// --- bulkApprovePath / bulkDeletePath / allSelected / toggleAllSelected / summarizeBulkResult
// --- (QA B4: bulk select -> Approve/Delete) --------------------------------

test('bulkApprovePath / bulkDeletePath: fixed endpoints', () => {
  assert.strictEqual(bulkApprovePath(), '/api/review/bulk');
  assert.strictEqual(bulkDeletePath(), '/api/expenses/bulk-delete');
});

test('allSelected: true iff every id on the current page is in the selected set', () => {
  assert.strictEqual(allSelected(['a', 'b'], new Set(['a', 'b'])), true);
  assert.strictEqual(allSelected(['a', 'b'], new Set(['a'])), false);
  assert.strictEqual(allSelected(['a', 'b'], new Set(['a', 'b', 'c'])), true, 'extra selections outside the page are fine');
});

test('allSelected: empty page is never "all selected" (nothing to tick)', () => {
  assert.strictEqual(allSelected([], new Set(['a'])), false);
  assert.strictEqual(allSelected([], new Set()), false);
});

test('allSelected: tolerates null/non-array/non-Set input, never throws', () => {
  assert.strictEqual(allSelected(null, null), false);
  assert.strictEqual(allSelected(undefined, undefined), false);
  assert.doesNotThrow(() => allSelected('nope', 'nope'));
});

test('toggleAllSelected: checked=true adds every page id; checked=false removes every page id', () => {
  const on = toggleAllSelected(['a', 'b'], new Set(), true);
  assert.deepStrictEqual(Array.from(on).sort(), ['a', 'b']);
  const off = toggleAllSelected(['a', 'b'], new Set(['a', 'b', 'c']), false);
  assert.deepStrictEqual(Array.from(off).sort(), ['c']);
});

test('toggleAllSelected: never mutates the input Set (returns a new one)', () => {
  const input = new Set(['x']);
  const out = toggleAllSelected(['a'], input, true);
  assert.deepStrictEqual(Array.from(input).sort(), ['x'], 'input Set must be untouched');
  assert.deepStrictEqual(Array.from(out).sort(), ['a', 'x']);
});

test('toggleAllSelected: tolerates null/non-array/non-Set input, never throws', () => {
  assert.doesNotThrow(() => toggleAllSelected(null, null, true));
  assert.deepStrictEqual(Array.from(toggleAllSelected(null, null, true)), []);
});

test('summarizeBulkResult: all succeeded', () => {
  assert.strictEqual(summarizeBulkResult({ requested: 3, updated: 3 }, 'approved'), 'All 3 approved.');
  assert.strictEqual(summarizeBulkResult({ requested: 2, deleted: 2 }, 'deleted'), 'All 2 deleted.');
});

test('summarizeBulkResult: partial success reports the failure count', () => {
  assert.strictEqual(summarizeBulkResult({ requested: 4, updated: 3 }, 'approved'), '3 of 4 approved — 1 failed.');
});

test('summarizeBulkResult: zero requested / malformed input never throws', () => {
  assert.strictEqual(summarizeBulkResult({ requested: 0, updated: 0 }, 'approved'), 'Nothing to approved.');
  assert.doesNotThrow(() => summarizeBulkResult(null, 'approved'));
  assert.doesNotThrow(() => summarizeBulkResult(undefined, 'approved'));
  assert.strictEqual(summarizeBulkResult(null, 'approved'), 'Something went wrong. Please try again.');
});

// --- deletedRowsPath / restorePath (QA B7: Recently-deleted bin + Recover) ------

test('deletedRowsPath: the fixed "recently deleted" list endpoint', () => {
  assert.strictEqual(deletedRowsPath(), '/api/expenses/deleted');
});

test('restorePath: builds /api/expenses/<id>/restore, encoding the id', () => {
  assert.strictEqual(restorePath('abc-123'), '/api/expenses/abc-123/restore');
  assert.strictEqual(restorePath('a/b c'), '/api/expenses/a%2Fb%20c/restore');
});

test('restorePath: null/undefined id does not throw', () => {
  assert.strictEqual(restorePath(null), '/api/expenses//restore');
  assert.strictEqual(restorePath(undefined), '/api/expenses//restore');
});

// --- isRejected / recategorizeBody / permanentDeletePath (QA B8/B9) --------
// docs/qa/2026-07-09-qa-round.md PR-B: a rejected bill gets a recategorise chevron
// (B9) and a one-click permanent-delete icon (B8), both gated on isRejected(row).

test('isRejected: true only for status "rejected"', () => {
  assert.strictEqual(isRejected(row({ status: 'rejected' })), true);
  assert.strictEqual(isRejected(row({ status: 'saved' })), false);
  assert.strictEqual(isRejected(row({ status: 'approved' })), false);
  assert.strictEqual(isRejected(row({ status: 'needs_review' })), false);
});

test('isRejected: never throws on null/garbage rows', () => {
  assert.strictEqual(isRejected(null), false);
  assert.strictEqual(isRejected(undefined), false);
  assert.strictEqual(isRejected({}), false);
  assert.strictEqual(isRejected('nope'), false);
});

test('recategorizeBody: builds a category + status:"saved" patch (mirrors the awaiting-category picker)', () => {
  assert.deepStrictEqual(recategorizeBody('Groceries'), { category: 'Groceries', status: 'saved' });
});

test('permanentDeletePath: builds /api/expenses/<id>/permanent, encoding the id', () => {
  assert.strictEqual(permanentDeletePath('abc-123'), '/api/expenses/abc-123/permanent');
  assert.strictEqual(permanentDeletePath('a/b c'), '/api/expenses/a%2Fb%20c/permanent');
});

test('permanentDeletePath: null/undefined id does not throw', () => {
  assert.strictEqual(permanentDeletePath(null), '/api/expenses//permanent');
  assert.strictEqual(permanentDeletePath(undefined), '/api/expenses//permanent');
});

// --- purgeReminderDate (QA 2026-07-13, Untitled document (4).md): the recently-deleted
// bin didn't say WHEN a bill would fall out of the system, just that it could be recovered
// "for now". There is no automatic purge job today (deleted_at is a permanent soft-delete —
// confirmed by reading routes/expenses.js: nothing ever clears old deleted rows), so this is
// a DISPLAY-ONLY reminder of the retention policy, not a promise a job enforces yet. Building
// the actual auto-purge is a separate, infra-lane piece (a scheduled job); flagged, not built
// here — see the WORKLOG entry. -------------------------------------------------------------

test('purgeReminderDate: adds DELETED_RETENTION_DAYS to deleted_at, returned as YYYY-MM-DD', () => {
  assert.strictEqual(purgeReminderDate('2026-07-01T00:00:00Z'), '2026-07-31');
});

test('purgeReminderDate: an explicit retentionDays overrides the default', () => {
  assert.strictEqual(purgeReminderDate('2026-07-01T00:00:00Z', 7), '2026-07-08');
  assert.strictEqual(purgeReminderDate('2026-07-01T00:00:00Z', 90), '2026-09-29');
});

test('purgeReminderDate: crosses a month/year boundary correctly', () => {
  assert.strictEqual(purgeReminderDate('2026-12-15T00:00:00Z', 30), '2027-01-14');
});

test('purgeReminderDate: missing/invalid deleted_at never throws, returns null', () => {
  assert.strictEqual(purgeReminderDate(null), null);
  assert.strictEqual(purgeReminderDate(undefined), null);
  assert.strictEqual(purgeReminderDate(''), null);
  assert.strictEqual(purgeReminderDate('not-a-date'), null);
});

test('DELETED_RETENTION_DAYS: the documented default retention window', () => {
  assert.strictEqual(DELETED_RETENTION_DAYS, 30);
});

// --- inline line-item categorisation (QA C3) ------------------------------

test('mixedCategoryLabel counts distinct usable categories and labels mixed receipts', () => {
  assert.strictEqual(mixedCategoryLabel(row({
    line_items: [
      { description: 'Lunch', amount: 50, category: 'Food' },
      { description: 'Fuel', amount: 30, category: 'Petrol' },
    ],
  })), 'Mixed (2)');
  assert.strictEqual(mixedCategoryLabel(row({
    line_items: [
      { category: 'Food' }, { category: 'Petrol' }, { category: 'Software' },
    ],
  })), 'Mixed (3)');
});

test('mixedCategoryLabel leaves single, empty, and unusable categories unchanged', () => {
  assert.strictEqual(mixedCategoryLabel(row({ line_items: [{ category: 'Food' }, { category: 'Food' }] })), null);
  assert.strictEqual(mixedCategoryLabel(row({ line_items: [] })), null);
  assert.strictEqual(mixedCategoryLabel(row({ line_items: [{ category: '' }, { category: null }] })), null);
  assert.strictEqual(mixedCategoryLabel(row({})), null);
  assert.strictEqual(mixedCategoryLabel(null), null);
});

test('mixedCategoryLabel treats category case and surrounding whitespace as the same', () => {
  assert.strictEqual(mixedCategoryLabel(row({
    line_items: [{ category: ' Food ' }, { category: 'food' }, { category: ' PETROL' }],
  })), 'Mixed (2)');
});

test('lineItemDetails returns safe drawer fields without mutating line_items', () => {
  const items = [
    { description: 'Lunch', amount: 50, category: 'Food' },
    { name: 'Fuel', amount: '30.00', category: 'Petrol', flagged: true },
  ];
  const out = lineItemDetails(row({ line_items: items }));
  assert.deepStrictEqual(out, [
    { description: 'Lunch', amount: 50, category: 'Food', flagged: false },
    { description: 'Fuel', amount: '30.00', category: 'Petrol', flagged: true },
  ]);
  assert.deepStrictEqual(items, [
    { description: 'Lunch', amount: 50, category: 'Food' },
    { name: 'Fuel', amount: '30.00', category: 'Petrol', flagged: true },
  ]);
  assert.deepStrictEqual(lineItemDetails(row({ line_items: [] })), []);
  assert.deepStrictEqual(lineItemDetails(null), []);
});

// --- admin Activity branch/staff clarity (QA C6) --------------------------

test('filterSortPage applies the admin branch filter and My uploads scope', () => {
  const rows = [
    row({ id: 'own', branch_id: 'b1' }),
    row({ id: 'other', branch_id: 'b2' }),
    row({ id: 'legacy', branch_id: null }),
  ];
  assert.deepStrictEqual(
    filterSortPage(rows, { filterBranch: 'mine', sessionBranchId: 'b1' }).rows.map((r) => r.id),
    ['own'],
  );
  assert.deepStrictEqual(
    filterSortPage(rows, { filterBranch: 'b2', sessionBranchId: 'b1' }).rows.map((r) => r.id),
    ['other'],
  );
  assert.deepStrictEqual(
    filterSortPage(rows, { filterBranch: 'all', sessionBranchId: 'b1' }).rows.map((r) => r.id),
    ['own', 'other', 'legacy'],
  );
});

test('filterSortPage My uploads matches an unassigned admin branch without hiding the row', () => {
  const rows = [row({ id: 'hq', branch_id: null }), row({ id: 'branch', branch_id: 'b1' })];
  assert.deepStrictEqual(
    filterSortPage(rows, { filterBranch: 'mine', sessionBranchId: null }).rows.map((r) => r.id),
    ['hq'],
  );
});

test('branch/staff response maps use display labels and safe ID fallbacks', () => {
  assert.deepStrictEqual(branchNamesFromResponse({
    branches: [{ id: 'b1', office: 'Head Office' }, { id: 'b2', office: '' }, { id: null, office: 'bad' }],
  }), { b1: 'Head Office', b2: 'b2' });
  assert.deepStrictEqual(staffNamesFromResponse({
    staff: [
      { id: 's1', display_name: 'Alice' },
      { id: 's2', display_name: '', username: 'bob' },
      { id: 's3' },
    ],
  }), { s1: 'Alice', s2: 'bob', s3: 's3' });
  assert.strictEqual(displayBranchName({ branch_id: 'b1' }, { b1: 'Head Office' }), 'Head Office');
  assert.strictEqual(displayBranchName({ branch_id: 'missing' }, {}), 'missing');
  assert.strictEqual(displayBranchName({ branch_id: null }, {}), '—');
  assert.strictEqual(displayStaffName({ staff_user_id: 's1' }, { s1: 'Alice' }), 'Alice');
  assert.strictEqual(displayStaffName({ staff_user_id: 'missing' }, {}), 'missing');
  assert.strictEqual(displayStaffName({ staff_user_id: null }, {}), '—');
});

test('activityBranchOptions includes All branches, My uploads, mapped branches, and row-only IDs', () => {
  assert.deepStrictEqual(activityBranchOptions(
    [{ id: 'b2', office: 'Branch 2' }, { id: 'b1', office: 'Branch 1' }],
    [row({ branch_id: 'b1' }), row({ branch_id: 'legacy' }), row({ branch_id: null })],
    { role: 'admin', branch_id: 'b1' },
  ), [
    { value: 'all', label: 'All branches' },
    { value: 'mine', label: 'My uploads' },
    { value: 'b1', label: 'Branch 1' },
    { value: 'b2', label: 'Branch 2' },
    { value: 'legacy', label: 'legacy' },
    { value: 'unassigned', label: 'Unassigned' },
  ]);
  assert.deepStrictEqual(activityBranchOptions([], [], { role: 'clerk', branch_id: 'b1' }), []);
});
