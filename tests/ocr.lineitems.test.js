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

test('assembleExpense: backward-compatible — receipt-level category (rollup) is still set', async () => {
  const { expense } = await assembleExpense(
    input({ fields: { line_items: [{ description: 'Coffee', amount: 4 }] } }),
    deps({ categorizeLineItems: async () => ({ category: 'Meals & Entertainment', items: [{ description: 'Coffee', amount: 4, category: 'Meals & Entertainment' }] }) }));
  assert.strictEqual(expense.category, 'Meals & Entertainment');
});
