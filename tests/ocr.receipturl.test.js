'use strict';
// ADR-018 receipt-image storage: assembleExpense echoes an optional `receipt_url`
// (the Supabase Storage object path, produced by routes/upload.js) onto the saved
// expense. Additive: absent -> the key is not present (byte-for-byte unchanged for
// every existing caller); a failed upload (null) is treated as absent.
const test = require('node:test');
const assert = require('node:assert');
const { assembleExpense } = require('../lib/ocr');

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
    chatId: 1, repName: 'Dashboard', fileId: null, fieldSpec: FIELDSPEC,
    fields: { merchant: 'Acme', amount: 100, currency: 'MYR', expense_date: '2026-07-04' },
    rawParsed: { merchant: 'Acme', amount: '100', expense_date: '2026-07-04' },
    ...over,
  };
}
function deps(over = {}) {
  return {
    categorizeLineItems: async () => ({ category: 'Others', items: [] }),
    detectAnomalies:     async () => ({ flagged: false, reasons: [], status_suggestion: 'saved' }),
    convertCurrency:     async () => ({ ok: false, rate: null }),
    loadHistory:         async () => [],
    insertExpense:       over.insertExpense || (async () => {}),
  };
}

test('assembleExpense: receipt_url arg -> set on the saved expense + inserted row', async () => {
  let inserted = null;
  const { expense } = await assembleExpense(
    input({ receipt_url: 'default/abc-123.jpg' }),
    deps({ insertExpense: async (row) => { inserted = row; return row; } }));
  assert.strictEqual(expense.receipt_url, 'default/abc-123.jpg');
  assert.strictEqual(inserted.receipt_url, 'default/abc-123.jpg');
});

test('assembleExpense: no receipt_url arg -> key absent (byte-for-byte unchanged)', async () => {
  const { expense } = await assembleExpense(input(), deps());
  assert.ok(!('receipt_url' in expense), 'receipt_url must not be added when not provided');
});

test('assembleExpense: a failed upload (null receipt_url) is treated as absent', async () => {
  const { expense } = await assembleExpense(input({ receipt_url: null }), deps());
  assert.ok(!('receipt_url' in expense));
});
