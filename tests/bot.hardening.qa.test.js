'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Tier-2 QA regressions for PR #42 (P6 Telegram-lane hardening) — gaps not covered
// by tests/bot.batch.test.js or tests/bot.pdf.qa.test.js: untrusted media_group_id
// shapes, concurrent flush races on the shared `groups` Map, and non-Error throws
// (string/undefined/null) from runBatch/rasterizePdf inside the never-throws paths.
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

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

function baseDeps(over = {}) {
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
    expenseFromPhoto: async () => { throw new Error('should not be called'); },
    ...over,
  };
  return { deps, sent, runBatchCalls };
}

function photoUpdate(mediaGroupId, fileId, chatId = 1) {
  return { message: { chat: { id: chatId }, from: { first_name: 'A' }, media_group_id: mediaGroupId, photo: [{ file_id: fileId }] } };
}

// ---- (1) untrusted media_group_id shapes: object/array/number all coerce via String() ----
// handleUpdate does `const id = String(msg.media_group_id)`. An object media_group_id
// becomes the literal string "[object Object]" for EVERY such payload — meaning two
// DIFFERENT senders who both send an object media_group_id would collide into the
// SAME buffer bucket. Prove this is the actual (documented-here) behaviour.
test('untrusted media_group_id: an object value coerces to "[object Object]" — two different senders with object ids COLLIDE into one bucket', async () => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  const updA = photoUpdate({ weird: 1 }, 'fileA', 111);
  const updB = photoUpdate({ other: 2 }, 'fileB', 222); // different chat/sender, also an object id
  await handleUpdate(updA, deps);
  await handleUpdate(updB, deps);
  assert.strictEqual(timers.size(), 1, 'both object-id groups collided into a single String(...) bucket key');
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 1);
  // The bucket keeps the chatId/repName from whichever update created the group (first one) —
  // so chat 222's photo would be flushed to chat 111. This documents a real cross-chat mixing
  // risk when media_group_id is not a string, even though Telegram itself always sends strings.
  assert.strictEqual(runBatchCalls[0].meta.chatId, 111);
  assert.deepStrictEqual(runBatchCalls[0].images, ['https://tg/fileA', 'https://tg/fileB']);
});

test('untrusted media_group_id: an array value also coerces via String() without throwing', async () => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await assert.doesNotReject(() => handleUpdate(photoUpdate([1, 2, 3], 'f1'), deps));
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 1);
});

test('untrusted media_group_id: a numeric value behaves identically to the equivalent string (Telegram sends strings, but a bridge/relay might not)', async () => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(photoUpdate(12345, 'fnum1'), deps);
  await handleUpdate(photoUpdate('12345', 'fnum2'), deps); // string form of the same id
  assert.strictEqual(timers.size(), 1, 'numeric 12345 and string "12345" must bucket together (both String()-coerce identically)');
  await timers.runPending();
  assert.deepStrictEqual(runBatchCalls[0].images, ['https://tg/fnum1', 'https://tg/fnum2']);
});

// ---- (2) an extremely long media group (Telegram caps real albums at 10; ensure our
// cap independently protects an attacker-forged payload with e.g. 1000 photos) ----
test('an attacker-forged media group with 1000 photos is still clamped to MAX_GROUP_IMAGES, no unbounded growth', async () => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  for (let i = 0; i < 1000; i++) {
    await handleUpdate(photoUpdate('bigattack', 'f' + i), deps);
  }
  await timers.runPending();
  assert.strictEqual(runBatchCalls[0].images.length, 10, 'default MAX_GROUP_IMAGES cap must hold regardless of how many updates arrive');
});

// ---- (3) file_id that is not a string (number, object) must not crash the buffer/flush path ----
test('a non-string file_id (number) in a media group does not crash flush — passed through to tgFileUrl as-is', async () => {
  const timers = fakeTimers();
  const seenFileIds = [];
  const { deps, runBatchCalls } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    tgFileUrl: async (fid) => { seenFileIds.push(fid); return { url: 'https://tg/' + String(fid) }; },
  });
  await assert.doesNotReject(() => handleUpdate({
    message: { chat: { id: 1 }, from: { first_name: 'A' }, media_group_id: 'g1', photo: [{ file_id: 999999 }] },
  }, deps));
  await timers.runPending();
  assert.deepStrictEqual(seenFileIds, [999999]);
  assert.strictEqual(runBatchCalls.length, 1);
});

// ---- (4) concurrency: two "simultaneous" flushes for the same group id ----
// If two callers raced to invoke flushGroup(id) for the same group before either had
// deleted it from the Map, both could process the SAME fileIds twice (double insert /
// double runBatch). Prove the actual code's guard (groups.delete happens synchronously
// at the top of flushGroup, before any await) prevents this even when both calls are
// kicked off "simultaneously" (same microtask tick).
test('concurrency: two flushes racing for the same group id — only ONE actually runs runBatch (synchronous delete-then-await guard holds)', async () => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(photoUpdate('race1', 'r1'), deps);
  await handleUpdate(photoUpdate('race1', 'r2'), deps);
  // Simulate a race: fire the SAME pending timer callback twice "simultaneously"
  // (Promise.all so both run their first synchronous tick — including groups.delete —
  // before either's await resolves).
  const cbs = [...timers.size() ? [true] : []];
  assert.strictEqual(timers.size(), 1);
  const fns = [];
  // Grab the pending fn without clearing (runPending clears on invocation, so call it once
  // for a legit flush, and manually invoke flushGroup a second time directly to simulate a
  // stray duplicate timer firing for the same id after the group was already deleted).
  const { flushGroup } = require('../lib/bot');
  await Promise.all([
    timers.runPending(),           // the real, single pending timer fires flushGroup('race1', deps)
    flushGroup('race1', deps),     // a hypothetical duplicate/racing call for the same id
  ]);
  assert.strictEqual(runBatchCalls.length, 1, 'the group was already deleted by the first flush, so the racing duplicate call is a no-op');
});

// ---- (5) non-Error throws inside flushGroup / handlePdfDocument must still be swallowed ----

test('flushGroup: runBatch throwing a plain STRING (not an Error) is still swallowed safely, no crash, safe reply sent', async () => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async () => { throw 'plain string failure, not an Error object'; }, // eslint-disable-line no-throw-literal
  });
  await handleUpdate(photoUpdate('strthrow', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
  assert.ok(!sent.some(s => /plain string failure/.test(s.text)), 'the raw thrown string must never reach the user');
});

test('flushGroup: runBatch throwing undefined is still swallowed safely (console.error on e.message would itself throw if unguarded)', async () => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async () => { throw undefined; }, // eslint-disable-line no-throw-literal
  });
  await handleUpdate(photoUpdate('undefthrow', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
});

test('flushGroup: runBatch throwing null is still swallowed safely', async () => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps({
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async () => { throw null; }, // eslint-disable-line no-throw-literal
  });
  await handleUpdate(photoUpdate('nullthrow', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
});

test('handlePdfDocument: rasterizePdf throwing a plain string is swallowed safely, no crash, safe reply', async () => {
  const deps = {
    tgSend: async (chatId, text) => { (deps._sent ||= []).push(text); },
    tgFileUrl: async () => ({ url: 'https://tg/f' }),
    hreq: async () => Buffer.from('%PDF-fake'),
    rasterizePdf: async () => { throw 'raw pdfium panic string'; }, // eslint-disable-line no-throw-literal
    getFieldSpec: async () => ({ account_id: 'default', columns: [] }),
    runBatch: async () => { throw new Error('should not be reached'); },
  };
  const update = { message: { chat: { id: 5 }, from: { first_name: 'A' }, document: { file_id: 'd1', mime_type: 'application/pdf', file_name: 'x.pdf' } } };
  await assert.doesNotReject(() => handleUpdate(update, deps));
  assert.match(deps._sent[deps._sent.length - 1], /couldn't read that pdf/i);
  assert.ok(!deps._sent.some(t => /raw pdfium panic string/.test(t)), 'raw thrown string must never reach the user');
});

test('handlePdfDocument: runBatch throwing undefined is swallowed safely', async () => {
  const deps = {
    tgSend: async (chatId, text) => { (deps._sent ||= []).push(text); },
    tgFileUrl: async () => ({ url: 'https://tg/f' }),
    hreq: async () => Buffer.from('%PDF-fake'),
    rasterizePdf: async () => ({ pages: [Buffer.from([1])], truncated: false }),
    getFieldSpec: async () => ({ account_id: 'default', columns: [] }),
    runBatch: async () => { throw undefined; }, // eslint-disable-line no-throw-literal
  };
  const update = { message: { chat: { id: 5 }, from: { first_name: 'A' }, document: { file_id: 'd1', mime_type: 'application/pdf', file_name: 'x.pdf' } } };
  await assert.doesNotReject(() => handleUpdate(update, deps));
  assert.match(deps._sent[deps._sent.length - 1], /couldn't read that pdf/i);
});
