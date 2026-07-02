'use strict';
// Tier-2 QA regressions for the Telegram PDF path (handlePdfDocument / handleUpdate), PR #38.
// Complements tests/bot.pdf.test.js: focuses on never-throws + non-leak under the shapes Barat
// did NOT cover — a RAW (non-PdfError) rasterize throw, a runBatch throw, and secret-planting.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

function pdfUpdate(fileId = 'F', chatId = 1) {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' },
    document: { file_id: fileId, mime_type: 'application/pdf', file_name: 'r.pdf' } } };
}

function baseDeps(over = {}) {
  const sent = [];
  const runBatchCalls = [];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    hreq: async () => Buffer.from('%PDF-fake'),
    rasterizePdf: async () => ({ pages: [Buffer.from([0x89]), Buffer.from([0x89])], truncated: false }),
    getFieldSpec: async () => ({ account_id: 'default', columns: [] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    runBatch: async (images) => { runBatchCalls.push(images); return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; },
    expenseFromPhoto: async () => { throw new Error('should not be called'); },
    ...over,
  };
  return { deps, sent, runBatchCalls };
}

test('QA: a RAW (non-PdfError) rasterize throw — the render-bomb leak — never throws to the caller and never leaks the raw text', async () => {
  // Mirrors the real lib/pdf.js render-bomb defect: a raw Error with pdfium internals escapes rasterizePdf.
  const { deps, sent, runBatchCalls } = baseDeps({
    rasterizePdf: async () => { throw new Error('Failed to allocate memory for bitmap /srv/app/node_modules/@hyzyla/pdfium'); },
  });
  await assert.doesNotReject(() => handleUpdate(pdfUpdate('bomb'), deps),
    'handleUpdate must swallow even a raw library error for a PDF');
  assert.strictEqual(runBatchCalls.length, 0, 'runBatch must not run after a rasterize failure');
  const last = sent[sent.length - 1].text;
  assert.match(last, /couldn't read that pdf/i);
  assert.ok(!/memory|bitmap|pdfium|node_modules|srv/i.test(last),
    'raw library internals must never reach the user reply');
});

test('QA: a runBatch throw yields a safe reply, handleUpdate does not throw, no internals leak', async () => {
  const { deps, sent } = baseDeps({
    runBatch: async () => { throw new Error('ECONNREFUSED 10.0.0.5:443 groq internal'); },
  });
  await assert.doesNotReject(() => handleUpdate(pdfUpdate('rb'), deps));
  const last = sent[sent.length - 1].text;
  assert.match(last, /couldn't read that pdf/i);
  assert.ok(!/ECONNREFUSED|groq|10\.0\.0\.5/i.test(last), 'downstream error text must not leak');
});

test('QA: truncated pages surface a user-facing note (counts-only, no reasons)', async () => {
  const { deps, sent } = baseDeps({
    rasterizePdf: async () => ({ pages: [Buffer.from([1])], truncated: true }),
    runBatch: async () => ({ images: 1, receipts: 1, saved: 1, failed: [{ reason: 'SECRET' }], flagged: [], truncated_images: [] }),
  });
  await handleUpdate(pdfUpdate('tr'), deps);
  const last = sent[sent.length - 1].text;
  assert.match(last, /more pages than i could read/i, 'pagesTruncated note must be surfaced');
  assert.ok(!last.includes('SECRET'), 'failed[].reason must never surface');
});

test('QA: path isolation — a plain image DOCUMENT (image/jpeg) is NOT taken by the PDF branch', async () => {
  let pdf = false, photo = false;
  const deps = { tgSend: async () => {}, handlePdfDocument: async () => { pdf = true; }, expenseFromPhoto: async () => { photo = true; } };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, document: { file_id: 'd', mime_type: 'image/jpeg', file_name: 'x.jpg' } } }, deps);
  assert.strictEqual(pdf, false, 'an image document must not hit the PDF branch');
  assert.strictEqual(photo, true);
});

test('QA: path isolation — a grouped photo goes to the media-group buffer, never the PDF branch', async () => {
  let pdf = false, armed = false;
  const deps = { tgSend: async () => {}, handlePdfDocument: async () => { pdf = true; },
    setTimeout: () => { armed = true; return 0; }, clearTimeout: () => {} };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, media_group_id: 'g', photo: [{ file_id: 'p' }] } }, deps);
  assert.strictEqual(pdf, false);
  assert.strictEqual(armed, true, 'grouped photo must arm the debounce, not the PDF path');
});
