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
    uploadReceiptImage: async () => null, // hermetic: never touch the real storage bucket
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

// 2026-07-20: a multi-page PDF is exactly as exposed to the batch rate-limit issue as a photo
// album — handlePdfDocument must pace its runBatch call the same way flushGroup does.
test('handlePdfDocument passes the default pacingMs (MASS_IMAGE_PACING_MS) into runBatch', async () => {
  const runBatchDeps = [];
  const { deps } = baseDeps({
    runBatch: async (images, fieldSpec, d) => {
      runBatchDeps.push(d);
      return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(pdfUpdate('fileA'), deps);
  assert.strictEqual(runBatchDeps.length, 1);
  assert.strictEqual(runBatchDeps[0].pacingMs, 3000, 'the production default (MASS_IMAGE_PACING_MS) must reach runBatch for PDFs too');
});

test('handlePdfDocument: deps.batchPacingMs overrides the default, and deps.sleep is passed through', async () => {
  const runBatchDeps = [];
  const fakeSleep = async () => {};
  const { deps } = baseDeps({
    batchPacingMs: 0, sleep: fakeSleep,
    runBatch: async (images, fieldSpec, d) => {
      runBatchDeps.push(d);
      return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(pdfUpdate('fileA'), deps);
  assert.strictEqual(runBatchDeps[0].pacingMs, 0);
  assert.strictEqual(runBatchDeps[0].sleep, fakeSleep);
});

// --- ADR-018 gap fix (2026-07-11): a PDF receipt's pages are now stored durably, so each row
// gets a receipt_url (before, PDF rows saved with receipt_url=null → no dashboard thumbnail,
// no photo in exports). Uploads the rasterized page BYTES directly (we already hold them).
test('PDF: each rendered page is uploaded and its receipt_url threaded per-page into runBatch', async () => {
  const uploaded = [];
  const perImageMeta = [];
  const { deps } = baseDeps({
    uploadReceiptImage: async (buf) => { uploaded.push(buf); return 'default/page-' + uploaded.length + '.png'; },
    runBatch: async (images, fieldSpec, d) => {
      for (let i = 0; i < images.length; i++) perImageMeta.push(typeof d.metaForImage === 'function' ? d.metaForImage(i) : d.meta);
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(pdfUpdate('fileA'), deps);
  assert.strictEqual(uploaded.length, 2, 'both rendered pages uploaded (FAKE_PAGE x2)');
  assert.ok(uploaded.every(Buffer.isBuffer), 'uploads the raw page bytes, not a data URI');
  assert.deepStrictEqual(perImageMeta.map(m => m.receipt_url), ['default/page-1.png', 'default/page-2.png']);
});

test('PDF: a storage failure (null) still saves the row imageless — receipt_url null, never throws', async () => {
  const perImageMeta = [];
  const { deps } = baseDeps({
    uploadReceiptImage: async () => null,
    runBatch: async (images, fieldSpec, d) => {
      for (let i = 0; i < images.length; i++) perImageMeta.push(d.metaForImage(i));
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await assert.doesNotReject(() => handleUpdate(pdfUpdate('fileB'), deps));
  assert.ok(perImageMeta.every(m => m.receipt_url === null), 'a failed store degrades to null, rows still save');
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

// --- PDF summary parity fix (2026-07-03): a PDF that renders fine but yields nothing
// usable used to show a bare "0 saved" with no explanation — now matches the photo-album
// path (skip reasons + per-receipt breakdown), via the same captureAssemble wrapper. ---

test('a PDF page the model could not read as a receipt -> the reply explains why, not a bare "0 saved"', async () => {
  const { deps, sent } = baseDeps({
    // A runBatch that behaves like the real one: calls the injected assembleExpense per
    // extracted receipt so handlePdfDocument's captureAssemble wrapper sees the result.
    runBatch: async (images, fieldSpec, d) => {
      const r1 = await d.assembleExpense({ ...d.meta, fields: { merchant: 'Unknown', amount: 0 }, rawParsed: { looks_like_receipt: false } });
      return { images: images.length, receipts: 1, saved: 0, skipped: 1, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ rawParsed }) => ({ expense: {}, flagged: false, skipped: true, skipReason: rawParsed.looks_like_receipt === false ? 'not_receipt' : 'unclear' }),
  });
  await handleUpdate(pdfUpdate('fileSkip'), deps);
  const lastMsg = sent[sent.length - 1].text;
  assert.match(lastMsg, /not a clear receipt|didn't look like a receipt/i, 'the reply must explain the skip, not just say "0 saved"');
});

test('a PDF page that IS saved -> the reply lists it (merchant/amount/category), matching the photo-album breakdown', async () => {
  const { deps, sent } = baseDeps({
    runBatch: async (images, fieldSpec, d) => {
      await d.assembleExpense({ ...d.meta, fields: { merchant: 'Shell', amount: 86 } });
      return { images: images.length, receipts: 1, saved: 1, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ fields }) => ({ expense: { merchant: fields.merchant, amount: fields.amount, currency: 'MYR', category: 'Petrol' }, flagged: false }),
  });
  await handleUpdate(pdfUpdate('fileSaved'), deps);
  const lastMsg = sent[sent.length - 1].text;
  assert.match(lastMsg, /Shell/, 'the saved PDF receipt is listed by merchant, not just counted');
  assert.match(lastMsg, /Petrol/);
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
