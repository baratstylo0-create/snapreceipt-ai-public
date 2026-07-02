'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate, formatBatchSummary } = require('../lib/bot');

// Deterministic fake timer: setTimeout stores the callback (keyed by id), clearTimeout
// removes it. A media group re-arms the timer on every photo, so after N updates exactly
// ONE pending callback should remain — runPending() fires it (= the debounce flush).
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    size: () => pending.size,
    runPending: async () => { for (const fn of [...pending.values()]) { pending.clear(); await fn(); } },
  };
}

function photoUpdate(mediaGroupId, fileId, chatId = 100) {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' }, media_group_id: mediaGroupId, photo: [{ file_id: fileId }] } };
}

// Base deps: fakes for every external call so nothing touches the network.
function baseDeps(t, over = {}) {
  const sent = [];
  const runBatchCalls = [];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => ({ account_id: 'default', columns: [{ key: 'merchant', label: 'M', type: 'text', required: true }] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: { merchant: 'X' }, flagged: false }),
    runBatch: async (images, fieldSpec, d) => {
      runBatchCalls.push({ images, meta: d.meta });
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    expenseFromPhoto: async () => { throw new Error('expenseFromPhoto should NOT be called for a media group'); },
    ...over,
  };
  return { deps, sent, runBatchCalls };
}

test('a media group (N updates, same media_group_id) → ONE runBatch call with N images + one summary', async (t) => {
  const timers = fakeTimers();
  const { deps, sent, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5 });

  await handleUpdate(photoUpdate('grp1', 'fileA'), deps);
  await handleUpdate(photoUpdate('grp1', 'fileB'), deps);
  await handleUpdate(photoUpdate('grp1', 'fileC'), deps);

  assert.strictEqual(timers.size(), 1, 'debounce coalesced to a single pending flush');
  assert.strictEqual(runBatchCalls.length, 0, 'nothing runs before the debounce fires');

  await timers.runPending();

  assert.strictEqual(runBatchCalls.length, 1, 'exactly one batch call for the group');
  assert.deepStrictEqual(runBatchCalls[0].images, ['https://tg/fileA', 'https://tg/fileB', 'https://tg/fileC']);
  assert.strictEqual(runBatchCalls[0].meta.fileId, null, 'option A: single meta, fileId null');
  // "Reading 3 receipts…" then the summary
  assert.strictEqual(sent.length, 2);
  assert.match(sent[0].text, /Reading 3 receipts/);
  assert.match(sent[1].text, /Batch processed/);
});

test('a single photo (no media_group_id) uses expenseFromPhoto — runBatch NOT called', async (t) => {
  let ranPhoto = null;
  const { deps, runBatchCalls } = baseDeps(t, {
    expenseFromPhoto: async (chatId, repName, fileId) => { ranPhoto = { chatId, repName, fileId }; },
  });
  await handleUpdate({ message: { chat: { id: 7 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'solo' }] } }, deps);
  assert.deepStrictEqual(ranPhoto, { chatId: 7, repName: 'Bo', fileId: 'solo' });
  assert.strictEqual(runBatchCalls.length, 0);
});

test('flush never throws and sends a safe message when runBatch throws', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async () => { throw new Error('boom'); },
  });
  await handleUpdate(photoUpdate('grpErr', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
});

test('MAX_GROUP_IMAGES clamp: an over-cap photo is dropped, not sent to runBatch', async (t) => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 2,
  });
  await handleUpdate(photoUpdate('grpCap', 'f1'), deps);
  await handleUpdate(photoUpdate('grpCap', 'f2'), deps);
  await handleUpdate(photoUpdate('grpCap', 'f3'), deps); // dropped (cap 2)
  await timers.runPending();
  assert.strictEqual(runBatchCalls[0].images.length, 2);
});

test('all photos fail to resolve → a "couldn\'t download" message, runBatch skipped', async (t) => {
  const timers = fakeTimers();
  const { deps, sent, runBatchCalls } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    tgFileUrl: async () => null,
  });
  await handleUpdate(photoUpdate('grpNoUrl', 'f1'), deps);
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 0);
  assert.match(sent[sent.length - 1].text, /Couldn't download/i);
});

// QA (Tier-2): a download that REJECTS (not just returns null) must also degrade safely —
// the per-file try/catch in flushGroup swallows it, so a group where every download throws
// still hits the "couldn't download" path, runBatch is skipped, and nothing throws.
test('every photo download rejects → safe "couldn\'t download" message, runBatch skipped, no throw', async (t) => {
  const timers = fakeTimers();
  const { deps, sent, runBatchCalls } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    tgFileUrl: async () => { throw new Error('ECONNREFUSED downloading file'); },
  });
  await handleUpdate(photoUpdate('grpThrow', 'f1'), deps);
  await handleUpdate(photoUpdate('grpThrow', 'f2'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.strictEqual(runBatchCalls.length, 0);
  assert.match(sent[sent.length - 1].text, /Couldn't download/i);
  assert.ok(!sent.some(s => /ECONNREFUSED/.test(s.text)), 'raw download error never reaches the user');
});

test('formatBatchSummary renders counts and NEVER surfaces failed[].reason (SOP §7.2)', () => {
  const text = formatBatchSummary({
    images: 4, receipts: 5, saved: 3,
    failed: [{ image_index: 1, reason: 'SECRET_STACK_TRACE at /srv/app/lib/ocr.js:42' }],
    flagged: [{ image_index: 0, receipt_index: 0, merchant: 'Shell', reason: true }],
    truncated_images: [2],
  });
  assert.match(text, /4 photos/);
  assert.match(text, /5 receipts/);
  assert.match(text, /3 saved/);
  assert.match(text, /1 need review/);
  assert.match(text, /1 couldn't read/);
  assert.match(text, /more receipts than I could read/);
  assert.ok(!text.includes('SECRET_STACK_TRACE'), 'raw failure reason must never reach the user');
});

test('two different media groups do not mix', async (t) => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(photoUpdate('A', 'a1', 1), deps);
  await handleUpdate(photoUpdate('B', 'b1', 2), deps);
  await handleUpdate(photoUpdate('A', 'a2', 1), deps);
  assert.strictEqual(timers.size(), 2, 'one pending flush per group');
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 2);
  const byImages = runBatchCalls.map(c => c.images).sort();
  assert.deepStrictEqual(byImages, [['https://tg/a1', 'https://tg/a2'], ['https://tg/b1']].sort());
});
