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
