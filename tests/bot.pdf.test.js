'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

function pdfUpdate(fileId, chatId = 1, fileName = 'receipt.pdf') {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' },
    document: { file_id: fileId, mime_type: 'application/pdf', file_name: fileName } } };
}

const FAKE_PAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // stand-in PNG bytes, content irrelevant to these tests

function baseDeps(over = {}) {
  const sent = [];
  const runBatchCalls = [];
  const rasterizeCalls = [];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    hreq: async () => Buffer.from('%PDF-fake-bytes'),
    rasterizePdf: async (buf) => { rasterizeCalls.push(buf); return { pages: [FAKE_PAGE, FAKE_PAGE], truncated: false }; },
    getFieldSpec: async () => ({ account_id: 'default', columns: [{ key: 'merchant', label: 'M', type: 'text', required: true }] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: { merchant: 'X' }, flagged: false }),
    runBatch: async (images, fieldSpec, d) => {
      runBatchCalls.push({ images, meta: d.meta });
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    expenseFromPhoto: async () => { throw new Error('expenseFromPhoto should NOT be called for a PDF'); },
    ...over,
  };
  return { deps, sent, runBatchCalls, rasterizeCalls };
}

test('a PDF document -> rasterizePdf once -> runBatch once with the pages -> one counts-only reply', async () => {
  const { deps, sent, runBatchCalls, rasterizeCalls } = baseDeps();
  await handleUpdate(pdfUpdate('fileA'), deps);

  assert.strictEqual(rasterizeCalls.length, 1);
  assert.strictEqual(runBatchCalls.length, 1);
  assert.strictEqual(runBatchCalls[0].images.length, 2); // FAKE_PAGE x2
  assert.ok(runBatchCalls[0].images.every(s => typeof s === 'string' && s.startsWith('data:image/png;base64,')),
    'each rasterized page is passed to runBatch as a data URI string, not a raw Buffer');
  assert.strictEqual(runBatchCalls[0].meta.fileId, null, 'option A: single meta, fileId null');
  assert.strictEqual(sent.length, 1); // quiet mode: no "Reading…" ack — just the summary
  assert.match(sent[0].text, /Batch processed/);
});

test('reply NEVER contains failed[].reason (SOP §7.2) even when a receipt fails to save', async () => {
  const { deps, sent } = baseDeps({
    runBatch: async () => ({
      images: 2, receipts: 2, saved: 1, flagged: [], truncated_images: [],
      failed: [{ image_index: 1, reason: 'SECRET_STACK_TRACE at /srv/app/lib/ocr.js:99' }],
    }),
  });
  await handleUpdate(pdfUpdate('fileB'), deps);
  const lastMsg = sent[sent.length - 1].text;
  assert.ok(!lastMsg.includes('SECRET_STACK_TRACE'), 'raw failure reason must never reach the user');
  assert.match(lastMsg, /couldn't read/i);
});

test('rasterizePdf throwing PdfError -> one safe reply, no throw, runBatch NOT called', async () => {
  class FakePdfError extends Error { constructor(code) { super(code); this.name = 'PdfError'; this.code = code; } }
  const { deps, sent, runBatchCalls } = baseDeps({
    rasterizePdf: async () => { throw new FakePdfError('ENCRYPTED'); },
  });
  await assert.doesNotReject(() => handleUpdate(pdfUpdate('fileC'), deps));
  assert.strictEqual(runBatchCalls.length, 0);
  assert.match(sent[sent.length - 1].text, /couldn't read that pdf/i);
  assert.ok(!sent.some(s => /ENCRYPTED/.test(s.text)), 'raw PdfError code never reaches the user');
});

test('a normal single photo still goes through expenseFromPhoto — rasterizePdf/runBatch NOT called', async () => {
  let ranPhoto = null;
  const { deps, runBatchCalls, rasterizeCalls } = baseDeps({
    expenseFromPhoto: async (chatId, repName, fileId) => { ranPhoto = { chatId, repName, fileId }; },
  });
  await handleUpdate({ message: { chat: { id: 9 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'solo' }] } }, deps);
  assert.deepStrictEqual(ranPhoto, { chatId: 9, repName: 'Bo', fileId: 'solo' });
  assert.strictEqual(runBatchCalls.length, 0);
  assert.strictEqual(rasterizeCalls.length, 0);
});

test('download failure (no file url) -> safe message, rasterizePdf/runBatch NOT called', async () => {
  const { deps, sent, rasterizeCalls } = baseDeps({ tgFileUrl: async () => null });
  await handleUpdate(pdfUpdate('fileD'), deps);
  assert.strictEqual(rasterizeCalls.length, 0);
  assert.match(sent[sent.length - 1].text, /couldn't download/i);
});
