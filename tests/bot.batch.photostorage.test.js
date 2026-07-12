'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// ADR-018 gap fix (2026-07-11): the Telegram ALBUM (media group) and PDF paths used to save
// receipts with receipt_url=null — no durable image — so the dashboard showed no thumbnail and
// PDF exports had no photo to attach (single-photo + dashboard-upload paths already stored the
// image; only flushGroup/handlePdfDocument were missing it). These tests lock in that each album
// image / PDF page now gets stored and its object path threaded per-image into runBatch's
// metaForImage (which assembleExpense persists as receipt_url). Storage helpers are injected so
// nothing touches the network.
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    runPending: async () => { for (const fn of [...pending.values()]) { pending.clear(); await fn(); } },
  };
}

function albumUpdate(mediaGroupId, fileId, chatId = 100) {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' }, media_group_id: mediaGroupId, photo: [{ file_id: fileId }] } };
}

// Capture the per-image meta runBatch actually receives by invoking metaForImage(i) — this is the
// exact object handed to assembleExpense per image, so asserting receipt_url here proves the row
// would be persisted with the stored path.
function baseDeps(over = {}) {
  const sent = [];
  const perImageMeta = [];
  const storedUrls = [];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => ({ account_id: 'default', columns: [{ key: 'merchant', label: 'M', type: 'text', required: true }] }),
    // the durable-store helper: record what it was asked to store, return a deterministic path
    downloadAndStoreReceiptImage: async (url) => { storedUrls.push(url); return 'default/' + url.split('/').pop() + '.jpg'; },
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: { merchant: 'X' }, flagged: false }),
    runBatch: async (images, fieldSpec, d) => {
      for (let i = 0; i < images.length; i++) perImageMeta.push(typeof d.metaForImage === 'function' ? d.metaForImage(i) : d.meta);
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    ...over,
  };
  return { deps, sent, perImageMeta, storedUrls };
}

test('album: each photo is stored once and its receipt_url is threaded per-image into runBatch', async () => {
  const timers = fakeTimers();
  const { deps, perImageMeta, storedUrls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(albumUpdate('grpP', 'fileA'), deps);
  await handleUpdate(albumUpdate('grpP', 'fileB'), deps);
  await timers.runPending();

  assert.deepStrictEqual(storedUrls, ['https://tg/fileA', 'https://tg/fileB'], 'both album images stored, in order');
  assert.strictEqual(perImageMeta.length, 2);
  assert.strictEqual(perImageMeta[0].receipt_url, 'default/fileA.jpg', 'image 0 carries its own stored path');
  assert.strictEqual(perImageMeta[1].receipt_url, 'default/fileB.jpg', 'image 1 carries its own stored path');
});

test('album: a storage failure (null) still saves the row imageless — receipt_url null, never throws', async () => {
  const timers = fakeTimers();
  const { deps, perImageMeta } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    downloadAndStoreReceiptImage: async () => null, // simulate a storage hiccup
  });
  await assert.doesNotReject(async () => {
    await handleUpdate(albumUpdate('grpF', 'fileA'), deps);
    await timers.runPending();
  });
  assert.strictEqual(perImageMeta.length, 1);
  assert.strictEqual(perImageMeta[0].receipt_url, null, 'a failed store degrades to null, row still saves');
});

test('album: each image ALSO carries its own Telegram fileId (2026-07-12 — receipt_file_id gives album rows the Telegram serve-fallback single photos always had)', async () => {
  const timers = fakeTimers();
  const { deps, perImageMeta } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(albumUpdate('grpFid', 'fileA'), deps);
  await handleUpdate(albumUpdate('grpFid', 'fileB'), deps);
  await timers.runPending();
  assert.strictEqual(perImageMeta[0].fileId, 'fileA', 'image 0 carries its own Telegram file id');
  assert.strictEqual(perImageMeta[1].fileId, 'fileB', 'image 1 carries its own Telegram file id');
});

test('album: personal mode is unchanged — image still stored, no branch_id, receipt_url present', async () => {
  const timers = fakeTimers();
  const { deps, perImageMeta } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    getCapabilities: () => ({ multiUser: false }),
  });
  await handleUpdate(albumUpdate('grpPersonal', 'fileA'), deps);
  await timers.runPending();
  assert.strictEqual(perImageMeta[0].receipt_url, 'default/fileA.jpg');
  assert.ok(!('branch_id' in perImageMeta[0]), 'personal mode adds no branch attribution (unchanged)');
});
