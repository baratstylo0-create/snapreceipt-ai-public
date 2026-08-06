'use strict';
// #31 — runBatch optional per-image meta (metaForImage(i) / metas[]). Backward-compatible:
// falls back to the single shared `meta`. Lets the Telegram multi-photo adapter give each
// photo its own file_id so batch receipts keep a clickable original image.
const { test } = require('node:test');
const assert = require('node:assert');
const { runBatch } = require('../lib/massupload');

const FS = { columns: [{ key: 'merchant', type: 'text' }] };
// one receipt per image, merchant = the image string
const extractReceipts = async (image) => ({ receipts: [{ fields: { merchant: image }, rawParsed: {} }] });
function capture() {
  const seen = [];
  const assembleExpense = async (arg) => { seen.push(arg); return { expense: { merchant: arg.fields.merchant }, flagged: false }; };
  return { seen, assembleExpense };
}

test('metaForImage(i): each image gets its own meta (e.g. per-photo file_id)', async () => {
  const c = capture();
  await runBatch(['a', 'b'], FS, {
    extractReceipts, assembleExpense: c.assembleExpense,
    metaForImage: (i) => ({ fileId: 'file-' + i, repName: 'Tg' }),
  });
  assert.strictEqual(c.seen[0].fileId, 'file-0');
  assert.strictEqual(c.seen[1].fileId, 'file-1');
});

test('metas[] aligned to images[]: per-index meta', async () => {
  const c = capture();
  await runBatch(['a', 'b'], FS, {
    extractReceipts, assembleExpense: c.assembleExpense,
    metas: [{ fileId: 'x' }, { fileId: 'y' }],
  });
  assert.strictEqual(c.seen[0].fileId, 'x');
  assert.strictEqual(c.seen[1].fileId, 'y');
});

test('no per-image meta -> falls back to the single shared meta (byte-for-byte old behavior)', async () => {
  const c = capture();
  await runBatch(['a', 'b'], FS, { extractReceipts, assembleExpense: c.assembleExpense, meta: { fileId: null, repName: 'Dashboard' } });
  assert.strictEqual(c.seen[0].fileId, null);
  assert.strictEqual(c.seen[1].repName, 'Dashboard');
});

test('metaForImage that THROWS falls back to the shared meta, never aborts the batch', async () => {
  const c = capture();
  const summary = await runBatch(['a', 'b'], FS, {
    extractReceipts, assembleExpense: c.assembleExpense, meta: { fileId: 'shared' },
    metaForImage: () => { throw new Error('boom'); },
  });
  assert.strictEqual(summary.saved, 2);
  assert.strictEqual(c.seen[0].fileId, 'shared');
});

test('multiple receipts from the SAME image share that image meta', async () => {
  const c = capture();
  const twoPerImage = async (image) => ({ receipts: [{ fields: { merchant: image + '-1' }, rawParsed: {} }, { fields: { merchant: image + '-2' }, rawParsed: {} }] });
  await runBatch(['a'], FS, { extractReceipts: twoPerImage, assembleExpense: c.assembleExpense, metaForImage: (i) => ({ fileId: 'F' + i }) });
  assert.strictEqual(c.seen.length, 2);
  assert.strictEqual(c.seen[0].fileId, 'F0');
  assert.strictEqual(c.seen[1].fileId, 'F0'); // same photo -> same file_id
});
