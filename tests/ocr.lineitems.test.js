'use strict';
// Per-line-item categorization (spec 2026-07-04): OCR now extracts line items and
// assembleExpense PERSISTS the categorizer's per-item breakdown into expenses.line_items
// (previously computed then discarded). Two layers tested here:
//   1. coerceLineItems — pure, untrusted-model-output -> safe [{description, amount}] (SOP §7.3)
//   2. assembleExpense — persists the enriched per-item array, scaled to the stored currency
const test = require('node:test');
const assert = require('node:assert');
const { assembleExpense, coerceLineItems } = require('../lib/ocr');

// ---- coerceLineItems (pure) ---------------------------------------------

test('coerceLineItems: coerces a valid array to {description, amount}', () => {
  const out = coerceLineItems([{ description: 'Coffee', amount: 4.5 }, { description: 'Bread', amount: 3 }]);
  assert.deepStrictEqual(out, [{ description: 'Coffee', amount: 4.5 }, { description: 'Bread', amount: 3 }]);
});

test('coerceLineItems: reads description from `name` when `description` is absent', () => {
  const out = coerceLineItems([{ name: 'Nasi Lemak', amount: 12.5 }]);
  assert.strictEqual(out[0].description, 'Nasi Lemak');
  assert.strictEqual(out[0].amount, 12.5);
});

test('coerceLineItems: non-array input (null/object/string) -> []', () => {
  assert.deepStrictEqual(coerceLineItems(null), []);
  assert.deepStrictEqual(coerceLineItems({ description: 'x' }), []);
  assert.deepStrictEqual(coerceLineItems('coffee'), []);
  assert.deepStrictEqual(coerceLineItems(undefined), []);
});

test('coerceLineItems: caps the array at 100 items', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ description: 'item' + i, amount: 1 }));
  assert.strictEqual(coerceLineItems(many).length, 100);
});

test('coerceLineItems: a non-finite amount becomes 0 (never Infinity/NaN)', () => {
  const out = coerceLineItems([{ description: 'x', amount: '1e999' }, { description: 'y', amount: 'abc' }]);
  assert.strictEqual(out[0].amount, 0);
  assert.strictEqual(out[1].amount, 0);
});

test('coerceLineItems: drops non-object elements and fully-empty junk', () => {
  const out = coerceLineItems([null, 'str', 42, { description: '', amount: 0 }, { description: 'Real', amount: 2 }]);
  assert.deepStrictEqual(out, [{ description: 'Real', amount: 2 }]);
});

test('coerceLineItems: a hostile long description is truncated (untrusted output)', () => {
  const out = coerceLineItems([{ description: 'A'.repeat(5000), amount: 1 }]);
  assert.ok(out[0].description.length <= 500);
});

// ---- assembleExpense persistence ----------------------------------------

const FIELDSPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Merchant', type: 'text',     required: true },
    { key: 'amount',       label: 'Amount',   type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
  ],
};

function input(over = {}) {
  return {
    chatId: 1, repName: 'Tester', fileId: 'f1', fieldSpec: FIELDSPEC,
    fields: { merchant: 'Acme', amount: 100, currency: 'EUR', expense_date: '2026-01-02', ...(over.fields || {}) },
    rawParsed: { merchant: 'Acme', amount: '100', expense_date: '2026-01-02', ...(over.rawParsed || {}) },
  };
}
function deps(over = {}) {
  return {
    categorizeLineItems: over.categorizeLineItems || (async () => ({ category: 'Others', items: [] })),
    detectAnomalies:     over.detectAnomalies     || (async () => ({ flagged: false, reasons: [], status_suggestion: 'saved' })),
    convertCurrency:     over.convertCurrency     || (async () => ({ ok: false, rate: null })),
    loadHistory:         over.loadHistory         || (async () => []),
    insertExpense:       over.insertExpense       || (async () => {}),
  };
}

test('assembleExpense: persists the categorizer per-item breakdown onto expense.line_items', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Pen', amount: 2 }] } }),
    deps({
      categorizeLineItems: async () => ({
        category: 'Office Supplies',
        items: [
          { description: 'Coffee', amount: 4, category: 'Meals & Entertainment', source: 'llm', confidence: 0.9, flagged: false },
          { description: 'Pen', amount: 2, category: 'Office Supplies', source: 'rule', confidence: 0.8, flagged: false },
        ],
      }),
    }));
  assert.strictEqual(expense.line_items.length, 2);
  assert.strictEqual(expense.line_items[0].category, 'Meals & Entertainment');
  assert.strictEqual(expense.line_items[1].category, 'Office Supplies');
  assert.strictEqual(expense.line_items[0].amount, 4);
});

test('assembleExpense: line-item amounts are scaled by fx_rate when the receipt is converted (decision D)', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Pen', amount: 2 }] } }),
    deps({
      convertCurrency: async () => ({ ok: true, rate: 5, to: 'MYR', amount: 500 }),
      categorizeLineItems: async () => ({
        category: 'Others',
        items: [
          { description: 'Coffee', amount: 4, category: 'Meals & Entertainment' },
          { description: 'Pen', amount: 2, category: 'Office Supplies' },
        ],
      }),
    }));
  assert.strictEqual(expense.currency, 'MYR');
  assert.strictEqual(expense.line_items[0].amount, 20); // 4 * 5
  assert.strictEqual(expense.line_items[1].amount, 10); // 2 * 5
});

test('assembleExpense: no OCR line items -> expense.line_items = [] (no synthetic whole-receipt echo)', async () => {
  const { expense } = await assembleExpense(input(), deps({
    // categorizer synthesises a single whole-receipt item internally; we must NOT persist that
    categorizeLineItems: async () => ({ category: 'Others', items: [{ description: 'Acme', amount: 100, category: 'Others' }] }),
  }));
  assert.deepStrictEqual(expense.line_items, []);
});

test('assembleExpense: line items arriving on rawParsed (the real OCR channel) are coerced + persisted', async () => {
  const { expense } = await assembleExpense(
    // production path: extractReceipt puts line_items on rawParsed, NOT on fields
    input({ rawParsed: { line_items: [{ description: 'Milk', amount: 6 }, { name: 'JUNK', amount: 'xxx' }, { description: '', amount: 0 }] } }),
    deps({ categorizeLineItems: async (receipt) => ({ category: 'Groceries', items: receipt.line_items.map(i => ({ ...i, category: 'Groceries' })) }) }));
  // the coffee row is kept + categorized; the non-finite-amount row coerces to 0; junk dropped
  assert.strictEqual(expense.line_items.length, 2);
  assert.strictEqual(expense.line_items[0].description, 'Milk');
  assert.strictEqual(expense.line_items[0].category, 'Groceries');
  assert.strictEqual(expense.line_items[1].amount, 0);
});

// --- Round-2 hardening (Jeevan, 2026-07-13): edge cases that Codex's C2 statement/reports
// category-splitting will depend on. De-risking these HERE (storage time) means C2 can just
// sum expense.line_items directly with zero extra reconciliation/fallback logic of its own. --

test('assembleExpense: categorizer THROWS -> items keep their description/amount but get NO category key (never a bad/off-template value)', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Pen', amount: 2 }] } }),
    deps({ categorizeLineItems: async () => { throw new Error('categorizer down'); } }));
  assert.strictEqual(expense.line_items.length, 2);
  assert.strictEqual(expense.line_items[0].category, undefined);
  assert.strictEqual(expense.line_items[1].category, undefined);
  assert.strictEqual(expense.line_items[0].description, 'Coffee');
  assert.strictEqual(expense.category, 'Others', 'whole-receipt rollup still falls back safely');
});

test('assembleExpense: ONE item in an otherwise-categorized batch has no category (categorizer left it out) -> that item alone has no category key, siblings unaffected', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Mystery', amount: 2 }] } }),
    deps({
      categorizeLineItems: async () => ({
        category: 'Meals & Entertainment',
        items: [
          { description: 'Coffee', amount: 4, category: 'Meals & Entertainment' },
          { description: 'Mystery', amount: 2 }, // no category field at all
        ],
      }),
    }));
  assert.strictEqual(expense.line_items[0].category, 'Meals & Entertainment');
  assert.strictEqual(expense.line_items[1].category, undefined);
});

test('assembleExpense: a hostile OCR line item claiming its own currency/category is stripped before it ever reaches assembleExpense (coerceLineItems only keeps description+amount)', async () => {
  const { expense } = await assembleExpense(
    input({ rawParsed: { line_items: [{ description: 'Coffee', amount: 4, currency: 'USD', category: 'Hacked' }] } }),
    deps({ categorizeLineItems: async (receipt) => {
      // Prove the categorizer itself never even SEES a currency/category field on the input item.
      assert.deepStrictEqual(Object.keys(receipt.line_items[0]).sort(), ['amount', 'description']);
      return { category: 'Others', items: [{ description: 'Coffee', amount: 4, category: 'Others' }] };
    } }));
  assert.strictEqual(expense.line_items[0].category, 'Others', 'only the REAL categorizer output ever sets category');
  assert.strictEqual(('currency' in expense.line_items[0]), false, 'no per-item currency field exists in the data model at all');
});

test('assembleExpense: a small OCR rounding remainder (items sum to slightly less than the total) is corrected onto the LARGEST item', async () => {
  // Receipt total 10.00; items read as 6.50 + 3.40 = 9.90 (a 0.10 OCR rounding slip).
  const { expense } = await assembleExpense(
    input({ fields: { amount: 10, line_items: [{ description: 'Diesel', amount: 6.5 }, { description: 'Snacks', amount: 3.4 }] } }),
    deps({
      categorizeLineItems: async () => ({
        category: 'Petrol/Diesel',
        items: [
          { description: 'Diesel', amount: 6.5, category: 'Petrol/Diesel' },
          { description: 'Snacks', amount: 3.4, category: 'Food' },
        ],
      }),
    }));
  const sum = expense.line_items.reduce((s, it) => s + it.amount, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, expense.amount, 'line_items now sum EXACTLY to expense.amount');
  assert.strictEqual(expense.line_items[0].amount, 6.6, 'remainder (0.10) landed on the LARGEST item (Diesel), not Snacks');
  assert.strictEqual(expense.line_items[1].amount, 3.4, 'the smaller item is untouched');
});

test('assembleExpense: items summing to slightly MORE than the total also reconcile (remainder can be negative)', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { amount: 10, line_items: [{ description: 'Diesel', amount: 6.5 }, { description: 'Snacks', amount: 3.6 }] } }), // sums to 10.10
    deps({
      categorizeLineItems: async () => ({
        category: 'Petrol/Diesel',
        items: [
          { description: 'Diesel', amount: 6.5, category: 'Petrol/Diesel' },
          { description: 'Snacks', amount: 3.6, category: 'Food' },
        ],
      }),
    }));
  const sum = expense.line_items.reduce((s, it) => s + it.amount, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, 10);
  assert.strictEqual(expense.line_items[0].amount, 6.4, 'the -0.10 remainder landed on the largest item');
});

test('assembleExpense: a LARGE mismatch (genuine OCR misread, not rounding) is left AS-IS — never silently force-reconciled', async () => {
  // Items (6) vs total (100) is not "rounding" — that is bad OCR, and forcing the ~94 remainder
  // onto one item would print a fabricated, misleading line. Leave the data honest; a mismatch
  // this large should surface through the existing anomaly/review path, not be papered over here.
  const { expense } = await assembleExpense(
    input({ fields: { amount: 100, line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Pen', amount: 2 }] } }),
    deps({
      categorizeLineItems: async () => ({
        category: 'Others',
        items: [
          { description: 'Coffee', amount: 4, category: 'Meals & Entertainment' },
          { description: 'Pen', amount: 2, category: 'Office Supplies' },
        ],
      }),
    }));
  assert.strictEqual(expense.line_items[0].amount, 4, 'untouched — no fabricated correction for a non-rounding-scale gap');
  assert.strictEqual(expense.line_items[1].amount, 2);
});

test('assembleExpense: reconciliation runs AFTER fx-scaling, against the FINAL converted total', async () => {
  // Raw items 4+2=6 EUR; fx rate 5 -> scaled 20+10=30 MYR; converted total (mock) is 30.50 MYR
  // (a 0.50 rounding slip after conversion) -> the remainder must reconcile against 30.50, not 6.
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }, { description: 'Pen', amount: 2 }] } }),
    deps({
      convertCurrency: async () => ({ ok: true, rate: 5, to: 'MYR', amount: 30.5 }),
      categorizeLineItems: async () => ({
        category: 'Others',
        items: [
          { description: 'Coffee', amount: 4, category: 'Meals & Entertainment' },
          { description: 'Pen', amount: 2, category: 'Office Supplies' },
        ],
      }),
    }));
  assert.strictEqual(expense.amount, 30.5);
  const sum = expense.line_items.reduce((s, it) => s + it.amount, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, 30.5);
  assert.strictEqual(expense.line_items[0].amount, 20.5, '20 + the 0.50 remainder (largest item)');
  assert.strictEqual(expense.line_items[1].amount, 10, 'unchanged');
});

test('assembleExpense: a single line item always absorbs the full reconciliation (only one candidate for "largest")', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { amount: 10.05, line_items: [{ description: 'Everything', amount: 10 }] } }),
    deps({ categorizeLineItems: async () => ({ category: 'Others', items: [{ description: 'Everything', amount: 10, category: 'Others' }] }) }));
  assert.strictEqual(expense.line_items[0].amount, 10.05);
});

test('assembleExpense: backward-compatible — receipt-level category (rollup) is still set', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }] } }),
    deps({ categorizeLineItems: async () => ({ category: 'Meals & Entertainment', items: [{ description: 'Coffee', amount: 4, category: 'Meals & Entertainment' }] }) }));
  assert.strictEqual(expense.category, 'Meals & Entertainment');
});
