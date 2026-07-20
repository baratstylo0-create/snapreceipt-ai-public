'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expenseFromPhoto } = require('../lib/ocr');

function makeDeps({ extractReceipt, sleep = async () => {} } = {}) {
  const sent = [];
  return {
    sent,
    tgFileUrl: async () => ({ url: 'https://telegram.test/receipt.jpg' }),
    getFieldSpec: async () => ({ columns: [] }),
    extractReceipt: extractReceipt || (async () => ({
      fields: { merchant: 'Acme', amount: 10, expense_date: '2026-01-01' },
      rawParsed: {},
    })),
    downloadAndStoreReceiptImage: async () => null,
    assembleExpense: async ({ fields }) => ({
      expense: {
        id: 'expense-1',
        merchant: fields.merchant,
        amount: fields.amount,
        currency: 'MYR',
        expense_date: fields.expense_date,
        category: 'Food',
      },
      conf: { perField: { expense_date: 'high' } },
      flagged: false,
      skipped: false,
      awaitingCategory: false,
      duplicate: false,
    }),
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    sleep,
  };
}

test('expenseFromPhoto retries a rate-limited single-photo OCR call once after the injected delay', async () => {
  let attempts = 0;
  let storageCalls = 0;
  const delays = [];
  const deps = makeDeps({
    extractReceipt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('429');
      return {
        fields: { merchant: 'Acme', amount: 10, expense_date: '2026-01-01' },
        rawParsed: {},
      };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  deps.downloadAndStoreReceiptImage = async () => {
    storageCalls += 1;
    return null;
  };

  const result = await expenseFromPhoto('chat-1', 'Jeevan', 'file-1', {}, deps);

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(storageCalls, 1);
  assert.deepEqual(delays, [15000]);
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0].text, /Expense Captured/);
});

test('expenseFromPhoto preserves the rate-limit fallback when the retry is also rate-limited', async () => {
  let attempts = 0;
  const delays = [];
  const deps = makeDeps({
    extractReceipt: async () => {
      attempts += 1;
      throw new Error('429');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  const result = await expenseFromPhoto('chat-2', 'Jeevan', 'file-2', {}, deps);

  assert.equal(result, false);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [15000]);
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0].text, /Too many receipts sent at once/);
});

test('expenseFromPhoto does not retry non-rate-limit OCR errors', async () => {
  let attempts = 0;
  const delays = [];
  const deps = makeDeps({
    extractReceipt: async () => {
      attempts += 1;
      throw new Error('invalid response');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  const result = await expenseFromPhoto('chat-3', 'Jeevan', 'file-3', {}, deps);

  assert.equal(result, false);
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0].text, /This receipt was NOT saved/);
});
