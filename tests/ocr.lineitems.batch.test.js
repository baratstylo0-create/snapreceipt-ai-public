'use strict';
// Round-2 task (docs/plans/2026-07-13-round2-metrics-ux-and-task-split.md §2.1): CONFIRM that
// per-item line-item categorization is populated identically for the ALBUM/PDF batch capture
// path, not just the single-photo path (already covered by tests/ocr.lineitems.test.js).
//
// The album/PDF path goes through lib/massupload.js's runBatch(), NOT expenseFromPhoto()
// directly — this test proves the two things that differ from the single-photo call site:
//   1. extractReceipts() (the PLURAL, multi-receipt OCR call) actually carries `line_items` on
//      each receipt's `rawParsed` (buildInstructionMulti requests it — confirmed by code read).
//   2. runBatch passes that `rawParsed` straight through to the REAL assembleExpense unmodified,
//      so per-item categorization lands on `expense.line_items` exactly like the single-photo
//      path — for MULTIPLE receipts in one batch, independently.
// Uses the real runBatch (lib/massupload.js) + the real assembleExpense (lib/ocr.js, its own
// sub-dependencies injected via closure) — an actual integration, not two isolated unit tests.
const test = require('node:test');
const assert = require('node:assert');
const { runBatch } = require('../lib/massupload');
const { assembleExpense } = require('../lib/ocr');

const FIELDSPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant', label: 'Merchant', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'currency', required: true },
    { key: 'expense_date', label: 'Date', type: 'date', required: true },
  ],
};

// Wraps the REAL assembleExpense with hermetic sub-deps (no network/Supabase), matching the
// deps shape tests/ocr.lineitems.test.js already exercises directly.
function realAssemble(categorizeLineItemsImpl) {
  return (args) => assembleExpense(args, {
    categorizeLineItems: categorizeLineItemsImpl,
    detectAnomalies: async () => ({ flagged: false, reasons: [], status_suggestion: 'saved' }),
    convertCurrency: async () => ({ ok: false, rate: null }),
    loadHistory: async () => [],
    insertExpense: async () => {},
  });
}

test('batch capture (album/PDF path): TWO receipts in one runBatch call each get their OWN per-item line_items, independently', async () => {
  // Shaped exactly like extractReceipts()'s real output: { fields, rawParsed } per receipt,
  // rawParsed carrying line_items (buildInstructionMulti's LINE_ITEMS_KEY).
  const extractReceipts = async () => ({
    receipts: [
      {
        fields: { merchant: 'Shell', amount: 80, currency: 'MYR', expense_date: '2026-07-10' },
        rawParsed: { merchant: 'Shell', amount: '80', expense_date: '2026-07-10',
          line_items: [{ description: 'Diesel', amount: 50 }, { description: 'Snacks', amount: 30 }] },
      },
      {
        fields: { merchant: 'Mydin', amount: 25, currency: 'MYR', expense_date: '2026-07-11' },
        rawParsed: { merchant: 'Mydin', amount: '25', expense_date: '2026-07-11',
          line_items: [{ description: 'Stationery', amount: 25 }] },
      },
    ],
    truncated: false, raw: '[]',
  });

  // Distinct categorizer output PER receipt (keyed by merchant) — proves the two receipts'
  // line_items don't bleed into each other across the batch loop.
  const categorizeLineItems = async (receipt) => {
    if (receipt.merchant === 'Shell') {
      return { category: 'Petrol/Diesel', items: [
        { description: 'Diesel', amount: 50, category: 'Petrol/Diesel', source: 'rule', confidence: 0.9, flagged: false },
        { description: 'Snacks', amount: 30, category: 'Food', source: 'llm', confidence: 0.85, flagged: false },
      ] };
    }
    return { category: 'Sundry', items: [
      { description: 'Stationery', amount: 25, category: 'Sundry', source: 'rule', confidence: 0.9, flagged: false },
    ] };
  };

  const saved = [];
  const captureAssemble = async (args) => {
    const res = await realAssemble(categorizeLineItems)(args);
    if (res && res.expense) saved.push(res.expense);
    return res;
  };

  const summary = await runBatch(['img-1'], FIELDSPEC, { extractReceipts, assembleExpense: captureAssemble });

  assert.strictEqual(summary.saved, 2, 'both receipts in the batch saved');
  const shell = saved.find((e) => e.merchant === 'Shell');
  const mydin = saved.find((e) => e.merchant === 'Mydin');
  assert.ok(shell && mydin);

  assert.strictEqual(shell.line_items.length, 2);
  assert.strictEqual(shell.line_items[0].category, 'Petrol/Diesel');
  assert.strictEqual(shell.line_items[1].category, 'Food');
  assert.strictEqual(shell.line_items[0].amount, 50);
  assert.strictEqual(shell.line_items[1].amount, 30);

  assert.strictEqual(mydin.line_items.length, 1);
  assert.strictEqual(mydin.line_items[0].category, 'Sundry');
  assert.strictEqual(mydin.line_items[0].amount, 25);
});

test('batch capture: a receipt with NO line items in the batch behaves exactly like the single-photo path (rollup only, line_items:[])', async () => {
  const extractReceipts = async () => ({
    receipts: [{
      fields: { merchant: 'Toll Plaza', amount: 6, currency: 'MYR', expense_date: '2026-07-10' },
      rawParsed: { merchant: 'Toll Plaza', amount: '6', expense_date: '2026-07-10', line_items: [] },
    }],
    truncated: false, raw: '[]',
  });
  const saved = [];
  const captureAssemble = async (args) => {
    const res = await realAssemble(async () => ({ category: 'Travelling', items: [] }))(args);
    if (res && res.expense) saved.push(res.expense);
    return res;
  };
  await runBatch(['img-1'], FIELDSPEC, { extractReceipts, assembleExpense: captureAssemble });
  assert.strictEqual(saved.length, 1);
  assert.deepStrictEqual(saved[0].line_items, []);
  assert.strictEqual(saved[0].category, 'Travelling', 'whole-receipt rollup category still set (backward-compatible)');
});
