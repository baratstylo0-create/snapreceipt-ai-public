'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Issue #152 parts 2+3 (batch/album): per-photo failure feedback (resend the SPECIFIC
// offending photo with a reason-specific ask) and duplicate handling (extends #162 D13's
// exact-reject to the batch path, plus file_unique_id-based exact-resend detection).
// runBatch itself is stubbed here (its own image_index/skippedDetails/duplicateDetails
// correlation logic is tested directly in tests/massupload.test.js) — these tests exercise
// flushGroup's OWN consumption of that summary shape: mapping image_index back to the
// right g.fileIds entry, and sending the right reply for each outcome.
const { test } = require('node:test');
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

function photoUpdate(mediaGroupId, fileId, fileUniqueId, chatId = 100) {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' }, media_group_id: mediaGroupId,
    photo: [{ file_id: fileId, file_unique_id: fileUniqueId }] } };
}

function baseDeps(over = {}) {
  const sent = [];
  const sentPhotos = [];
  const runBatchCalls = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); return { result: { message_id: 1 } }; },
    tgSendPhoto: async (chatId, fileId, caption) => { sentPhotos.push({ chatId, fileId, caption }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    downloadAndStoreReceiptImage: async () => null, // hermetic: never touch the real storage bucket
    getFieldSpec: async () => ({ account_id: 'default', columns: [{ key: 'merchant', label: 'M', type: 'text', required: true }] }),
    setTimeout: (fn) => fn, // overridden per-test by fakeTimers where needed
    ...over,
  };
  return { deps, sent, sentPhotos, runBatchCalls };
}

test('flushGroup: extends rejectDuplicates to the batch path (meta carries it, same as #162 single-photo)', async () => {
  const timers = fakeTimers();
  let capturedMeta = null;
  const { deps } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images, fieldSpec, d) => {
      capturedMeta = d.meta;
      return { images: images.length, receipts: 0, saved: 0, skipped: 0, skippedDetails: [], duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(photoUpdate('grpA', 'f1', 'fu1'), deps);
  await timers.runPending();
  assert.strictEqual(capturedMeta.rejectDuplicates, true);
});

test('flushGroup: metaForImage resolves the per-image file_unique_id, index-aligned with the photos sent', async () => {
  const timers = fakeTimers();
  let metaForImage;
  const { deps } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images, fieldSpec, d) => {
      metaForImage = d.metaForImage;
      return { images: images.length, receipts: 0, saved: 0, skipped: 0, skippedDetails: [], duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(photoUpdate('grpB', 'f1', 'fu-one'), deps);
  await handleUpdate(photoUpdate('grpB', 'f2', 'fu-two'), deps);
  await timers.runPending();
  assert.strictEqual(metaForImage(0).receipt_file_unique_id, 'fu-one');
  assert.strictEqual(metaForImage(1).receipt_file_unique_id, 'fu-two');
});

test('flushGroup: a PARTIAL download failure keeps index alignment (null, not dropped) instead of silently shrinking the array', async () => {
  const timers = fakeTimers();
  let capturedImages;
  // 2026-07-20: MAX_GROUP_IMAGES default lowered 10->2 (owner request) — raises the cap so
  // this test can still exercise 3 photos; it's testing index alignment, not the cap.
  const { deps } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 10,
    tgFileUrl: async (fid) => (fid === 'bad' ? null : { url: 'https://tg/' + fid }),
    runBatch: async (images) => {
      capturedImages = images;
      return { images: images.length, receipts: 0, saved: 0, skipped: 0, skippedDetails: [], duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(photoUpdate('grpC', 'good1', 'fu1'), deps);
  await handleUpdate(photoUpdate('grpC', 'bad', 'fu2'), deps);
  await handleUpdate(photoUpdate('grpC', 'good2', 'fu3'), deps);
  await timers.runPending();
  assert.deepStrictEqual(capturedImages, ['https://tg/good1', null, 'https://tg/good2']);
});

test('flushGroup: per-photo failure feedback — resends the SPECIFIC offending photo with a reason-specific caption', async () => {
  const timers = fakeTimers();
  const { deps, sentPhotos } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images) => ({
      images: images.length, receipts: 2, saved: 1, skipped: 1,
      skippedDetails: [{ image_index: 1, receipt_index: 0, reason: 'blurry' }],
      duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [],
    }),
  });
  await handleUpdate(photoUpdate('grpD', 'f1', 'fu1'), deps);
  await handleUpdate(photoUpdate('grpD', 'f2', 'fu2'), deps);
  await timers.runPending();
  assert.strictEqual(sentPhotos.length, 1);
  assert.strictEqual(sentPhotos[0].fileId, 'f2', 'must resend image_index 1\'s OWN file_id, not a generic one');
  assert.match(sentPhotos[0].caption, /blurry/i);
  // Owner directive 2026-07-11: the re-sent thumbnail must make it unmistakable the photo
  // was NOT saved and needs re-uploading, not just a soft "resend a clearer shot".
  assert.match(sentPhotos[0].caption, /NOT saved/, 'caption states the receipt was not saved');
  assert.match(sentPhotos[0].caption, /re-upload/i, 'caption asks the user to re-upload it');
});

test('flushGroup: multiple skips each get their OWN correctly-mapped photo + caption', async () => {
  const timers = fakeTimers();
  // 2026-07-20: raises the cap (default now 2) so this test can still exercise 3 photos.
  const { deps, sentPhotos } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 10,
    runBatch: async (images) => ({
      images: images.length, receipts: 3, saved: 0, skipped: 2,
      skippedDetails: [
        { image_index: 0, receipt_index: 0, reason: 'not_receipt' },
        { image_index: 2, receipt_index: 0, reason: 'unclear' },
      ],
      duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [],
    }),
  });
  await handleUpdate(photoUpdate('grpE', 'fA', 'fuA'), deps);
  await handleUpdate(photoUpdate('grpE', 'fB', 'fuB'), deps);
  await handleUpdate(photoUpdate('grpE', 'fC', 'fuC'), deps);
  await timers.runPending();
  assert.strictEqual(sentPhotos.length, 2);
  assert.strictEqual(sentPhotos[0].fileId, 'fA');
  assert.strictEqual(sentPhotos[1].fileId, 'fC');
});

test('flushGroup: an exact duplicate reject sends the View/Edit reply pointing at the EXISTING receipt', async () => {
  const timers = fakeTimers();
  const existing = { id: 'exp-existing-9', merchant: 'Shell', amount: 50, currency: 'MYR', expense_date: '2026-07-05' };
  const { deps, sent } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images) => ({
      images: images.length, receipts: 1, saved: 0, skipped: 0, skippedDetails: [],
      duplicates: 1, duplicateDetails: [{ image_index: 0, receipt_index: 0, duplicateOf: existing }],
      failed: [], flagged: [], truncated_images: [],
    }),
  });
  await handleUpdate(photoUpdate('grpF', 'f1', 'fu1'), deps);
  await timers.runPending();
  const dupReply = sent.find(s => /Rejected — duplicate/i.test(s.text));
  assert.ok(dupReply, 'must send the duplicate-reject reply');
  assert.match(dupReply.text, /Shell/);
  const buttons = dupReply.replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.callback_data), ['dupview:exp-existing-9', 'dupedit:exp-existing-9']);
});

test('flushGroup: no skips/duplicates at all -> no photo resends, no duplicate replies (unchanged quiet path)', async () => {
  const timers = fakeTimers();
  const { deps, sentPhotos, sent } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images) => ({
      images: images.length, receipts: 1, saved: 1, skipped: 0, skippedDetails: [],
      duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [],
    }),
  });
  await handleUpdate(photoUpdate('grpG', 'f1', 'fu1'), deps);
  await timers.runPending();
  assert.strictEqual(sentPhotos.length, 0);
  assert.ok(!sent.some(s => /Rejected/i.test(s.text)));
});
