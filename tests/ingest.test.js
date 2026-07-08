'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { assembleExpense } = require('../lib/ocr');

// assembleExpense runs the ingestion pipeline (currency #10 -> category #6 ->
// anomaly #5 -> confidence #11). All external calls are injected as deps, so
// these tests are hermetic (no Groq / Supabase / FX network).

const FIELDSPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Merchant', type: 'text',     required: true },
    { key: 'amount',       label: 'Amount',   type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
  ],
};

// Fully-read fields + rawParsed (=> confidence all-high, not flagged)
function goodInput(over = {}) {
  return {
    chatId: 1, repName: 'Tester', fileId: 'file123', fieldSpec: FIELDSPEC,
    fields: { merchant: 'Acme', amount: 100, currency: 'EUR', expense_date: '2026-01-02', subtotal: 90, tax: 10, ...(over.fields || {}) },
    rawParsed: { merchant: 'Acme', amount: '100', expense_date: '2026-01-02', ...(over.rawParsed || {}) },
  };
}

function deps(over = {}) {
  return {
    categorizeLineItems: over.categorizeLineItems || (async () => ({ category: 'Others', items: [] })),
    detectAnomalies:     over.detectAnomalies     || (async () => ({ flagged: false, reasons: [], status_suggestion: 'saved' })),
    convertCurrency:     over.convertCurrency     || (async () => ({ ok: false, rate: null })), // default: no conversion
    loadHistory:         over.loadHistory         || (async () => []),
    insertExpense:       over.insertExpense       || (async () => {}), // hermetic: never hit real Supabase
  };
}

test('#10 currency: converts total + scales subtotal/tax, records originals', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    convertCurrency: async () => ({ ok: true, rate: 4.5, to: 'MYR', amount: 450 }),
  }));
  assert.strictEqual(expense.amount, 450);
  assert.strictEqual(expense.currency, 'MYR');
  assert.strictEqual(expense.amount_original, 100);
  assert.strictEqual(expense.currency_original, 'EUR');
  assert.strictEqual(expense.fx_rate, 4.5);
  assert.strictEqual(expense.subtotal, 405); // 90 * 4.5
  assert.strictEqual(expense.tax, 45);       // 10 * 4.5
  // stays internally consistent so the anomaly subtotal+tax=total check won't false-flag
  assert.strictEqual(expense.subtotal + expense.tax, expense.amount);
});

test('#10 currency: same-currency (rate 1) leaves amount alone, no originals', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    convertCurrency: async () => ({ ok: true, rate: 1, to: 'EUR', amount: 100 }),
  }));
  assert.strictEqual(expense.amount, 100);
  assert.ok(!('amount_original' in expense));
  assert.ok(!('fx_rate' in expense));
});

test('#10 currency: fails safe (ok:false) — keeps original amount, no crash', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    convertCurrency: async () => ({ ok: false, rate: null, reason: 'fx_unavailable' }),
  }));
  assert.strictEqual(expense.amount, 100);
  assert.strictEqual(expense.currency, 'EUR');
  assert.ok(!('amount_original' in expense));
});

// --- issue #45: assembleExpense now normalizes the extracted currency via
// normalizeCurrencyCode BEFORE converting, so a non-ISO symbol like "RM" (Malaysian
// Ringgit) is treated as MYR instead of silently falling back to DEFAULT_CURRENCY. ---
test('#45 currency: "RM" is normalized to MYR before FX (not dropped to DEFAULT_CURRENCY)', async () => {
  let seenFrom = null;
  const { expense } = await assembleExpense(goodInput({ fields: { currency: 'RM' } }), deps({
    convertCurrency: async (amount, from, to) => { seenFrom = from; return { ok: true, rate: 0.21, to, amount: amount * 0.21 }; },
  }));
  assert.strictEqual(seenFrom, 'MYR', 'assembleExpense must map "RM" -> "MYR" and convert FROM MYR');
  assert.strictEqual(expense.currency_original, 'MYR', 'the original currency recorded must be MYR, not RM or USD');
});

test('#45 currency: a genuinely ambiguous symbol ("$") still falls back to DEFAULT_CURRENCY safely', async () => {
  const { cfg } = require('../lib/config');
  let seenFrom = null;
  await assembleExpense(goodInput({ fields: { currency: '$' } }), deps({
    convertCurrency: async (amount, from, to) => { seenFrom = from; return { ok: true, rate: 1, to, amount }; },
  }));
  assert.strictEqual(seenFrom, cfg.DEFAULT_CURRENCY, 'an ambiguous "$" must not be guessed — falls back to DEFAULT_CURRENCY');
});

test('#6 category: stores the categorizer result, called with the receipt shape', async () => {
  let seen = null;
  const { expense } = await assembleExpense(goodInput(), deps({
    categorizeLineItems: async (receipt) => { seen = receipt; return { category: 'Fuel & Auto' }; },
  }));
  assert.strictEqual(expense.category, 'Fuel & Auto');
  assert.strictEqual(seen.merchant, 'Acme');
  assert.strictEqual(seen.amount, 100); // post-currency (no conversion here)
});

test('#6 category: falls back to the legacy normaliser if the categorizer throws', async () => {
  const { expense } = await assembleExpense(
    goodInput({ fields: { category: 'uber ride' } }),
    deps({ categorizeLineItems: async () => { throw new Error('LLM down'); } }),
  );
  assert.strictEqual(expense.category, 'Petrol'); // normaliseExpenseCategory('uber ride')
});

// --- Category-picker (Owner request 2026-07-03): when the categorizer flags its own
// uncertainty (no memory/rule match, LLM watchdog didn't confirm/override), the receipt
// is saved immediately (nothing lost) with a pending placeholder, and the caller is told
// to ask the user instead of silently committing to a guessed category. ---

test('category picker: an uncertain categorizer result (item flagged) -> awaitingCategory, pending sentinel, status awaiting_category, still inserted', async () => {
  const { PENDING_CATEGORY } = require('../lib/ocr');
  let inserted = null;
  const result = await assembleExpense(goodInput(), deps({
    categorizeLineItems: async () => ({ category: 'Others', items: [{ description: 'Acme', category: 'Others', source: 'fallback', confidence: 0.3, flagged: true }] }),
    insertExpense: async (row) => { inserted = row; },
  }));
  assert.strictEqual(result.awaitingCategory, true);
  assert.strictEqual(result.expense.category, PENDING_CATEGORY);
  assert.strictEqual(result.expense.status, 'awaiting_category');
  assert.ok(result.expense.id, 'a client-generated id must be present so it can be encoded into a Telegram button before any DB round-trip');
  assert.ok(Array.isArray(result.categoryOptions) && result.categoryOptions.length > 0, 'a category list is returned for the picker buttons');
  assert.ok(inserted, 'the row must still be inserted immediately — nothing is lost while waiting on the user');
  assert.strictEqual(inserted.status, 'awaiting_category');
});

test('category picker: a CONFIDENT categorizer result never triggers the picker (regression lock)', async () => {
  const result = await assembleExpense(goodInput(), deps({
    categorizeLineItems: async () => ({ category: 'Fuel & Auto', items: [{ description: 'Shell', category: 'Fuel & Auto', source: 'rules', confidence: 0.8, flagged: false }] }),
  }));
  assert.ok(!('awaitingCategory' in result), 'the confident path must not even carry the key, matching every pre-existing caller/test');
  assert.strictEqual(result.expense.category, 'Fuel & Auto');
  assert.strictEqual(result.expense.status, 'saved');
});

test('category picker: every existing test-fake shape (no items[], or items:[]) never triggers the picker', async () => {
  const noItems = await assembleExpense(goodInput(), deps({ categorizeLineItems: async () => ({ category: 'Others' }) }));
  assert.ok(!('awaitingCategory' in noItems));
  const emptyItems = await assembleExpense(goodInput(), deps({ categorizeLineItems: async () => ({ category: 'Others', items: [] }) }));
  assert.ok(!('awaitingCategory' in emptyItems));
});

test('category picker: a memory-sourced item that the LLM watchdog later flagged also triggers the picker (flagged, not just source==="fallback")', async () => {
  // Proves the trigger is the post-watchdog `flagged` bit, not a naive source==='fallback'
  // check — a memory-sourced guess the watchdog strongly disagreed with is ALSO uncertain.
  const result = await assembleExpense(goodInput(), deps({
    categorizeLineItems: async () => ({ category: 'Groceries', items: [{ description: 'Acme', category: 'Groceries', source: 'memory', confidence: 0.99, flagged: true }] }),
  }));
  assert.strictEqual(result.awaitingCategory, true);
});

test('#5 anomaly: flagged -> status needs_review + anomaly stored with reasons', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    detectAnomalies: async () => ({
      flagged: true,
      reasons: [{ type: 'duplicate', detail: 'matches existing expense h1', severity: 'high' }],
      status_suggestion: 'needs_review',
    }),
  }));
  assert.strictEqual(expense.status, 'needs_review');
  assert.strictEqual(expense.anomaly.flagged, true);
  assert.strictEqual(expense.anomaly.reasons[0].type, 'duplicate');
});

test('clean receipt -> status saved, anomaly null', async () => {
  const { expense, flagged } = await assembleExpense(goodInput(), deps());
  assert.strictEqual(flagged, false);
  assert.strictEqual(expense.status, 'saved');
  assert.strictEqual(expense.anomaly, null);
});

test('#11 low confidence on a required field routes to review even if no anomaly', async () => {
  // amount missing from rawParsed => confidence flags the required 'amount' field
  const input = goodInput({ rawParsed: { merchant: 'Acme', expense_date: '2026-01-02' } });
  delete input.rawParsed.amount;
  const { expense, flagged } = await assembleExpense(input, deps());
  assert.strictEqual(flagged, true);
  assert.strictEqual(expense.status, 'needs_review');
  assert.ok(expense.anomaly.reasons.some(r => r.type === 'low_confidence'));
});

test('ADR-010 SECURITY: anomaly opts is built server-side ONLY ({history}) — no injected caps', async () => {
  let capturedOpts = null;
  await assembleExpense(goodInput(), deps({
    detectAnomalies: async (_expense, opts) => { capturedOpts = opts; return { flagged: false, reasons: [], status_suggestion: 'saved' }; },
    loadHistory: async () => [{ id: 'h1', merchant: 'Acme', amount: 100 }],
  }));
  // ONLY history is passed — never businessProfile/capabilities/businessType from any client/model input.
  assert.deepStrictEqual(Object.keys(capturedOpts).sort(), ['history']);
  assert.deepStrictEqual(capturedOpts.history, [{ id: 'h1', merchant: 'Acme', amount: 100 }]);
});

test('detection failure degrades gracefully (not flagged, still inserts)', async () => {
  const { expense, flagged } = await assembleExpense(goodInput(), deps({
    detectAnomalies: async () => { throw new Error('anomaly service down'); },
  }));
  assert.strictEqual(flagged, false);
  assert.strictEqual(expense.status, 'saved');
});

// Regression: assembleExpense's own documented contract (docs/specs/2026-07-02-mass-upload-design.md)
// says it inserts the row, but until this fix it only ever RETURNED the built expense —
// nothing in the batch path (Telegram multi-photo/PDF, dashboard mass-upload) ever wrote
// to Supabase. expenseFromPhoto's own separate sbInsert masked this for single photos only.
test('a normal receipt is actually inserted (insertExpense called with the built row), skipped:false', async () => {
  let inserted = null;
  const { expense, skipped } = await assembleExpense(goodInput(), deps({
    insertExpense: async (row) => { inserted = row; },
  }));
  assert.strictEqual(skipped, false);
  assert.ok(inserted, 'insertExpense must be called for a real receipt');
  assert.strictEqual(inserted.merchant, expense.merchant);
  assert.strictEqual(inserted.amount, expense.amount);
});

// ADR-017: voucher_no is a DB-generated column (a trigger fills it in on insert, not
// this code — see schema.sql). assembleExpense must echo it back from whatever
// insertExpense returns, onto the `expense` object it hands back to the caller.
test('ADR-017: voucher_no is echoed from the insert result onto the returned expense', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    insertExpense: async () => ({ id: 'row1', voucher_no: 'RC-2026-0007' }),
  }));
  assert.strictEqual(expense.voucher_no, 'RC-2026-0007');
});

test('ADR-017: no voucher_no in the insert result -> expense.voucher_no stays unset (no crash)', async () => {
  const { expense } = await assembleExpense(goodInput(), deps({
    insertExpense: async () => {}, // mirrors today's every existing test fake / a pre-migration DB
  }));
  assert.ok(!('voucher_no' in expense), 'must not fabricate a voucher_no that was never assigned');
});

test('ADR-017: insertExpense returning null (sbInsertReturning\'s own safe-fallback shape) does not crash', async () => {
  await assert.doesNotReject(() => assembleExpense(goodInput(), deps({ insertExpense: async () => null })));
});

// ADR-018 (Jeevan's receipt-image feature, foundation merged in #87): assembleExpense
// accepts an optional receipt_url arg and passes it straight into the inserted row.
// Additive — every existing caller that doesn't pass it gets undefined (dropped from the
// JSON insert body entirely, so it never overwrites/nulls an existing column value).
test('ADR-018: an explicit receipt_url is passed through onto the inserted/returned expense', async () => {
  let inserted = null;
  const { expense } = await assembleExpense(
    { ...goodInput(), receipt_url: 'https://storage.example/receipts/abc.jpg' },
    deps({ insertExpense: async (row) => { inserted = row; } }),
  );
  assert.strictEqual(expense.receipt_url, 'https://storage.example/receipts/abc.jpg');
  assert.strictEqual(inserted.receipt_url, 'https://storage.example/receipts/abc.jpg');
});

test('ADR-018: no receipt_url passed (every existing caller) -> stays undefined, no crash, not fabricated', async () => {
  const { expense } = await assembleExpense(goodInput(), deps());
  assert.strictEqual(expense.receipt_url, undefined);
});

// A photo the model couldn't read as a receipt at all (no merchant, no positive amount —
// e.g. a selfie) must never be saved, from ANY caller, not just the single-photo path.
test('a non-receipt (no merchant, no amount) is skipped: not inserted, no downstream work', async () => {
  let insertCalled = false, categorizeCalled = false, detectCalled = false, convertCalled = false;
  const input = goodInput({ fields: { merchant: 'Unknown', amount: 0 }, rawParsed: {} });
  const { expense, skipped, flagged } = await assembleExpense(input, deps({
    insertExpense: async () => { insertCalled = true; },
    categorizeLineItems: async () => { categorizeCalled = true; return { category: 'Others' }; },
    detectAnomalies: async () => { detectCalled = true; return { flagged: false, reasons: [], status_suggestion: 'saved' }; },
    convertCurrency: async () => { convertCalled = true; return { ok: false, rate: null }; },
  }));
  assert.strictEqual(skipped, true);
  assert.strictEqual(flagged, false);
  assert.strictEqual(insertCalled, false, 'a non-receipt must never be inserted');
  assert.strictEqual(categorizeCalled, false, 'no point categorizing junk that will not be saved');
  assert.strictEqual(detectCalled, false, 'no point anomaly-checking junk that will not be saved');
  assert.strictEqual(convertCalled, false, 'no point FX-converting junk that will not be saved');
  assert.strictEqual(expense.merchant, 'Unknown');
});

// A PARTIAL read (merchant OR amount present, not both missing) is still a real receipt
// worth keeping — must NOT be treated as empty, must still be inserted.
test('a partial read (merchant present, amount 0) is NOT skipped and is inserted', async () => {
  let inserted = null;
  const input = goodInput({ fields: { merchant: 'Starbucks', amount: 0 }, rawParsed: {} });
  const { skipped } = await assembleExpense(input, deps({ insertExpense: async (row) => { inserted = row; } }));
  assert.strictEqual(skipped, false);
  assert.ok(inserted, 'a partial read must still be saved for review');
  assert.strictEqual(inserted.merchant, 'Starbucks');
});

// Owner feedback 2026-07-03: a blurry real receipt and a totally unrelated photo used to
// get the exact same "not a receipt" reply. assembleExpense must surface WHICH one this
// was (via the model's own looks_like_receipt signal) so the caller can reply honestly.
test('a skipped receipt carries skipReason "blurry" when the model says this looked like a receipt', async () => {
  const input = goodInput({ fields: { merchant: 'Unknown', amount: 0 }, rawParsed: { looks_like_receipt: true } });
  const { skipReason } = await assembleExpense(input, deps());
  assert.strictEqual(skipReason, 'blurry');
});

test('a skipped receipt carries skipReason "not_receipt" when the model says this was not a receipt', async () => {
  const input = goodInput({ fields: { merchant: 'Unknown', amount: 0 }, rawParsed: { looks_like_receipt: false } });
  const { skipReason } = await assembleExpense(input, deps());
  assert.strictEqual(skipReason, 'not_receipt');
});

test('a skipped receipt with no looks_like_receipt signal carries skipReason "unclear" (safe fallback)', async () => {
  const input = goodInput({ fields: { merchant: 'Unknown', amount: 0 }, rawParsed: {} });
  const { skipReason } = await assembleExpense(input, deps());
  assert.strictEqual(skipReason, 'unclear');
});

// A SAVED receipt must not carry a leftover skipReason from a previous call/shared state.
test('a saved (non-skipped) receipt has no skipReason key', async () => {
  const { skipReason } = await assembleExpense(goodInput(), deps());
  assert.strictEqual(skipReason, undefined);
});

// Issue #149 (live Premala QA): the exact reported bug, at the pipeline level. A real
// receipt's date carried a trailing OCR timestamp — merchant/amount/currency/category all
// read fine, but the date came out as today with NO signal that anything was wrong. This
// locks the fix: (a) the trailing-time date now parses correctly (money.js), and (b) a
// GENUINELY garbled date correctly scores low/flagged (confidence.js) instead of silently
// passing — lib/ocr.js's expenseFromPhoto uses this exact conf.perField.expense_date
// signal to decide whether to ask the user (see tests/bot.dateask.test.js for that half).
test('#149: a trailing-timestamp date parses correctly and scores high (the exact reported bug)', async () => {
  // fields.expense_date mirrors what coerce()/normaliseDate() would ALREADY have produced
  // upstream in the real pipeline (extractReceipt runs coerce before assembleExpense sees
  // it) — rawParsed carries the model's raw string, used only for confidence scoring here.
  const { normaliseDate } = require('../lib/money');
  const raw = '30/06/2026 12:46:53';
  const input = goodInput({
    fields: { expense_date: normaliseDate(raw) },
    rawParsed: { merchant: 'Acme', amount: '100', expense_date: raw },
  });
  const { expense, conf } = await assembleExpense(input, deps());
  assert.strictEqual(expense.expense_date, '2026-06-30', 'must use the real receipt date, not fall back to today');
  assert.strictEqual(conf.perField.expense_date, 'high', 'the model DID read this correctly — must not be flagged');
});

test('#149: a genuinely unreadable date scores low/flagged instead of silently defaulting to today', async () => {
  const { normaliseDate } = require('../lib/money');
  const raw = 'totally illegible';
  const input = goodInput({
    fields: { expense_date: normaliseDate(raw) },
    rawParsed: { merchant: 'Acme', amount: '100', expense_date: raw },
  });
  const { expense, conf, flagged } = await assembleExpense(input, deps());
  assert.strictEqual(expense.expense_date, require('../lib/money').todayISO(), 'storage still falls back to today (unchanged behaviour)');
  assert.strictEqual(conf.perField.expense_date, 'low', 'but confidence must now catch it');
  assert.strictEqual(flagged, true, 'expense_date is required -> must flag for review/ask');
});
