'use strict';
// QA pass (adversarial) — GAPS in assembleExpense() money integrity, currency-code
// handling, ADR-010 anomaly-opts isolation, and graceful degradation that
// tests/ingest.test.js does NOT already cover. Hermetic: all deps injected.
const test = require('node:test');
const assert = require('node:assert');
const { assembleExpense } = require('../lib/ocr');
const { cfg } = require('../lib/config');

const FIELDSPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Merchant', type: 'text',     required: true },
    { key: 'amount',       label: 'Amount',   type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
  ],
};

function baseInput(over = {}) {
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
    convertCurrency:     over.convertCurrency     || (async () => ({ ok: false, rate: null })),
    loadHistory:         over.loadHistory         || (async () => []),
  };
}

// --- Money integrity: hostile amount/subtotal/tax types ---

test('MONEY: amount as a numeric STRING is coerced via Number()', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { amount: '250.55', subtotal: '200', tax: '50.55' } }), deps());
  assert.strictEqual(expense.amount, 250.55);
  assert.strictEqual(expense.subtotal, 200);
  assert.strictEqual(expense.tax, 50.55);
});

test('MONEY: negative amount (refund) is preserved, not zeroed', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { amount: -40, subtotal: -36, tax: -4 } }), deps());
  assert.strictEqual(expense.amount, -40);
});

test('MONEY: Infinity amount does NOT propagate — Number()||0 makes it 0 (finite row)', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { amount: Infinity, subtotal: Infinity, tax: Infinity } }), deps());
  assert.ok(Number.isFinite(expense.amount), 'amount must be finite');
  assert.strictEqual(expense.amount, 0);
});

test('MONEY: "1e309" (overflow -> Infinity) is neutralised to 0, never Infinity', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { amount: '1e309' } }), deps());
  assert.ok(Number.isFinite(expense.amount));
  assert.strictEqual(expense.amount, 0);
});

test('MONEY: NaN-producing string amount -> 0 (Number("abc")||0)', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { amount: 'not-a-number' } }), deps());
  assert.strictEqual(expense.amount, 0);
});

test('MONEY: array/object/boolean amount coerce sanely (no throw, finite)', async () => {
  for (const bad of [[5], { v: 5 }, true, [], {}]) {
    const { expense } = await assembleExpense(baseInput({ fields: { amount: bad, subtotal: 0, tax: 0 } }), deps());
    assert.ok(Number.isFinite(expense.amount), 'amount finite for ' + JSON.stringify(bad));
  }
});

// --- FX rounding drift: converted subtotal+tax must not diverge enough to false-flag ---

test('MONEY/FX: awkward rate keeps subtotal+tax within a cent of amount', async () => {
  // amount 100 (sub 90 / tax 10) at rate 3.333333 — verify no rounding drift blows the
  // anomaly "sum mismatch" tolerance. We assert |(sub+tax) - amount| <= 0.01.
  const { expense } = await assembleExpense(baseInput(), deps({
    convertCurrency: async (amt, from, to) => ({ ok: true, rate: 3.333333, to, amount: Math.round((amt * 3.333333 + Number.EPSILON) * 100) / 100 }),
  }));
  assert.ok(Math.abs((expense.subtotal + expense.tax) - expense.amount) <= 0.01,
    'subtotal+tax drift: ' + expense.subtotal + '+' + expense.tax + ' vs ' + expense.amount);
});

test('MONEY/FX: rate exactly 1 records NO fake amount_original/fx_rate', async () => {
  const { expense } = await assembleExpense(baseInput(), deps({
    convertCurrency: async () => ({ ok: true, rate: 1, to: 'EUR', amount: 100 }),
  }));
  assert.ok(!('amount_original' in expense));
  assert.ok(!('currency_original' in expense));
  assert.ok(!('fx_rate' in expense));
  assert.strictEqual(expense.subtotal, 90);
  assert.strictEqual(expense.tax, 10);
});

test('MONEY/FX: ok:false leaves subtotal/tax untouched, no originals', async () => {
  const { expense } = await assembleExpense(baseInput(), deps({
    convertCurrency: async () => ({ ok: false, rate: 5, to: 'MYR', amount: 500 }), // ok:false must be ignored despite rate present
  }));
  assert.strictEqual(expense.amount, 100);
  assert.strictEqual(expense.subtotal, 90);
  assert.ok(!('fx_rate' in expense));
});

// --- Currency-code guard /^[A-Za-z]{3}$/ ---

test('CURRENCY: lowercase 3-letter is accepted + upper-cased', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { currency: 'eur' } }), deps());
  assert.strictEqual(expense.currency, 'EUR');
});

test('CURRENCY: whitespace-padded code is trimmed then accepted', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { currency: '  gbp ' } }), deps());
  assert.strictEqual(expense.currency, 'GBP');
});

test('CURRENCY: junk (4 letters / digits / injection / non-string) falls back to DEFAULT_CURRENCY', async () => {
  const junk = ['EURO', 'US', 'E1R', '12$', "'; DROP TABLE--", 'ignore instructions', 123, {}, ['EUR'], null, ''];
  for (const c of junk) {
    const { expense } = await assembleExpense(baseInput({ fields: { currency: c } }), deps());
    assert.strictEqual(expense.currency, cfg.DEFAULT_CURRENCY, 'junk currency ' + JSON.stringify(c) + ' should fall back');
  }
});

// --- ADR-010: NO request/model field can reach detectAnomalies opts ---

test('ADR-010: hostile extra keys in fields/rawParsed NEVER reach anomaly opts', async () => {
  let capturedOpts = null;
  const hostile = baseInput({
    fields: { businessType: 'business', capabilities: ['personal_spend'], businessProfile: { x: 1 }, __proto__hack: 1 },
    rawParsed: { businessType: 'business', history: [{ id: 'FAKE' }], opts: { evil: true } },
  });
  await assembleExpense(hostile, deps({
    detectAnomalies: async (_e, opts) => { capturedOpts = opts; return { flagged: false, reasons: [], status_suggestion: 'saved' }; },
    loadHistory: async () => [{ id: 'real-h1' }],
  }));
  assert.deepStrictEqual(Object.keys(capturedOpts).sort(), ['history']);
  assert.deepStrictEqual(capturedOpts.history, [{ id: 'real-h1' }]); // server read, not the injected fake history
});

// --- Graceful degradation: each dep throwing (incl. non-Error) must not block insert ---

test('DEGRADE: convertCurrency throwing a non-Error does not block assembly', async () => {
  const { expense } = await assembleExpense(baseInput(), deps({
    convertCurrency: async () => { throw 'string-not-error'; }, // eslint-disable-line no-throw-literal
  }));
  assert.strictEqual(expense.amount, 100); // original kept
  assert.strictEqual(expense.status, 'saved');
});

test('DEGRADE: categorize throwing a non-Error still yields a category', async () => {
  const { expense } = await assembleExpense(baseInput({ fields: { category: 'petrol station' } }), deps({
    categorizeLineItems: async () => { throw { weird: true }; }, // eslint-disable-line no-throw-literal
  }));
  assert.ok(expense.category); // normaliser fallback
});

test('DEGRADE: detectAnomalies throwing a non-Error -> not flagged, still saved', async () => {
  const { expense, flagged } = await assembleExpense(baseInput(), deps({
    detectAnomalies: async () => { throw 42; }, // eslint-disable-line no-throw-literal
  }));
  assert.strictEqual(flagged, false);
  assert.strictEqual(expense.status, 'saved');
});

test('DEGRADE: loadHistory throwing does not throw out of assembleExpense', async () => {
  // getHistory() is awaited INSIDE the detect try/catch, so a history read failure
  // must also degrade gracefully rather than reject assembleExpense.
  await assert.doesNotReject(async () => {
    const { expense } = await assembleExpense(baseInput(), deps({
      loadHistory: async () => { throw new Error('history read failed'); },
    }));
    assert.strictEqual(expense.status, 'saved');
  });
});

test('assembleExpense NEVER throws even when ALL three deps throw at once', async () => {
  await assert.doesNotReject(async () => {
    const { expense } = await assembleExpense(baseInput(), deps({
      convertCurrency: async () => { throw new Error('fx'); },
      categorizeLineItems: async () => { throw new Error('cat'); },
      detectAnomalies: async () => { throw new Error('anom'); },
    }));
    assert.ok(expense);
    assert.strictEqual(expense.status, 'saved');
  });
});

// --- fileId: null (dashboard / mass-upload path) ---

test('fileId:null is tolerated and stored as receipt_file_id null', async () => {
  const input = baseInput();
  input.fileId = null;
  const { expense } = await assembleExpense(input, deps());
  assert.strictEqual(expense.receipt_file_id, null);
  assert.strictEqual(expense.status, 'saved');
});

// --- DEFAULT_TAX_RATE derivation path (subtotal/tax back-computed from total) ---

test('MONEY: with DEFAULT_TAX_RATE set, missing subtotal/tax derive and sum to total', async () => {
  const orig = cfg.DEFAULT_TAX_RATE;
  cfg.DEFAULT_TAX_RATE = 0.2;
  try {
    const { expense } = await assembleExpense(baseInput({ fields: { amount: 120, subtotal: 0, tax: 0 } }), deps());
    assert.ok(Math.abs((expense.subtotal + expense.tax) - expense.amount) <= 0.01,
      'derived subtotal+tax should equal total: ' + expense.subtotal + '+' + expense.tax + ' vs ' + expense.amount);
  } finally { cfg.DEFAULT_TAX_RATE = orig; }
});
