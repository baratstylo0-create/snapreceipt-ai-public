'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
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
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    downloadAndStoreReceiptImage: async () => null, // hermetic: never touch the real storage bucket
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
  // 2026-07-20: MAX_GROUP_IMAGES default lowered 10->2 (owner request) — this test is about
  // coalescing N updates into one batch call, not the cap itself, so it raises the cap to
  // keep testing 3 images. The cap's own behavior is covered by its own dedicated test below.
  const { deps, sent, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5, maxGroupImages: 10 });

  await handleUpdate(photoUpdate('grp1', 'fileA'), deps);
  await handleUpdate(photoUpdate('grp1', 'fileB'), deps);
  await handleUpdate(photoUpdate('grp1', 'fileC'), deps);

  assert.strictEqual(timers.size(), 1, 'debounce coalesced to a single pending flush');
  assert.strictEqual(runBatchCalls.length, 0, 'nothing runs before the debounce fires');

  await timers.runPending();

  assert.strictEqual(runBatchCalls.length, 1, 'exactly one batch call for the group');
  assert.deepStrictEqual(runBatchCalls[0].images, ['https://tg/fileA', 'https://tg/fileB', 'https://tg/fileC']);
  assert.strictEqual(runBatchCalls[0].meta.fileId, null, 'option A: single meta, fileId null');
  // An immediate reassurance ack on the FIRST photo of the album, then ONE summary reply.
  assert.strictEqual(sent.length, 2, 'a reassuring "reading…" ack + the final summary');
  assert.match(sent[0].text, /reading them all now/i, 'the album gets an immediate ack so the chat is not silent');
  assert.match(sent[1].text, /Batch processed/);
});

// 2026-07-20: an unpaced batch can now trip the Groq key's per-minute token budget mid-album
// (OCR_MAX_TOKENS raised 2500->6000 fixed a real empty-output bug but shrank how many receipts
// fit in a minute). flushGroup must pass MASS_IMAGE_PACING_MS through to runBatch by default,
// and let a caller override it (deps.batchPacingMs) or supply its own sleep for tests.
test('flushGroup passes the default pacingMs (MASS_IMAGE_PACING_MS) into runBatch', async (t) => {
  const timers = fakeTimers();
  const runBatchDeps = [];
  const { deps } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5,
    runBatch: async (images, fieldSpec, d) => {
      runBatchDeps.push(d);
      return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(photoUpdate('grpPace1', 'f1'), deps);
  await timers.runPending();
  assert.strictEqual(runBatchDeps.length, 1);
  assert.strictEqual(runBatchDeps[0].pacingMs, 6000, 'the production default (MASS_IMAGE_PACING_MS) must reach runBatch');
});

test('flushGroup: deps.batchPacingMs overrides the default, and deps.sleep is passed through', async (t) => {
  const timers = fakeTimers();
  const runBatchDeps = [];
  const fakeSleep = async () => {};
  const { deps } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5,
    batchPacingMs: 0, sleep: fakeSleep,
    runBatch: async (images, fieldSpec, d) => {
      runBatchDeps.push(d);
      return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate(photoUpdate('grpPace2', 'f1'), deps);
  await timers.runPending();
  assert.strictEqual(runBatchDeps[0].pacingMs, 0, 'an explicit 0 must override the 3000ms default (test/dashboard-style opt-out)');
  assert.strictEqual(runBatchDeps[0].sleep, fakeSleep, 'a caller-supplied sleep must reach runBatch unchanged');
});

test('the album ack is sent ONCE per group (on the first photo), not per photo', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5 });
  await handleUpdate(photoUpdate('grpAck', 'f1'), deps);
  await handleUpdate(photoUpdate('grpAck', 'f2'), deps);
  await handleUpdate(photoUpdate('grpAck', 'f3'), deps);
  const acks = sent.filter(s => /reading them all now/i.test(s.text));
  assert.strictEqual(acks.length, 1, 'exactly one ack for the whole album, not one per photo');
});

test('a media group summary lists each saved receipt (details captured via the injected assembleExpense)', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    // A runBatch fake that behaves like the real one — it calls the injected assembleExpense
    // per image, so flushGroup's capture wrapper records each saved receipt's details.
    runBatch: async (images, fieldSpec, d) => {
      let saved = 0;
      for (let i = 0; i < images.length; i++) {
        await d.assembleExpense({ ...d.meta, fields: { merchant: 'Shop' + i, amount: 10 + i } });
        saved++;
      }
      return { images: images.length, receipts: images.length, saved, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ fields }) => ({ expense: { merchant: fields.merchant, amount: fields.amount, currency: 'MYR', category: 'Food' }, flagged: false }),
  });
  await handleUpdate(photoUpdate('grpDetail', 'f1'), deps);
  await handleUpdate(photoUpdate('grpDetail', 'f2'), deps);
  await timers.runPending();
  const summaryMsg = sent[sent.length - 1].text;
  assert.match(summaryMsg, /Batch processed/);
  assert.match(summaryMsg, /Shop0/, 'the summary lists the first saved receipt by merchant');
  assert.match(summaryMsg, /Shop1/, 'and the second');
  assert.match(summaryMsg, /Food/, 'with its category');
});

// 2026-07-20: a solo photo now buffers through the same debounce as an album (bulk-spam
// fix) so several individually-sent photos can still coalesce into one batch — a genuine
// single send still ends up at expenseFromPhoto (never runBatch), just after the debounce.
test('a single photo (no media_group_id) uses expenseFromPhoto — runBatch NOT called', async (t) => {
  const timers = fakeTimers();
  let ranPhoto = null;
  const { deps, runBatchCalls } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    expenseFromPhoto: async (chatId, repName, fileId) => { ranPhoto = { chatId, repName, fileId }; },
  });
  await handleUpdate({ message: { chat: { id: 7 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'solo' }] } }, deps);
  await timers.runPending();
  assert.deepStrictEqual(ranPhoto, { chatId: 7, repName: 'Bo', fileId: 'solo' });
  assert.strictEqual(runBatchCalls.length, 0);
});

test('a genuinely solo photo gets the singular "Reading your receipt…" ack, not the album wording', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    expenseFromPhoto: async () => ({ ok: true, expense: { id: 'e1', merchant: 'X', amount: 1, currency: 'MYR' } }),
  });
  await handleUpdate({ message: { chat: { id: 71 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'solo' }] } }, deps);
  await timers.runPending();
  assert.strictEqual(sent.length, 1, 'exactly one message: the ack (the fake expenseFromPhoto never replies itself)');
  assert.match(sent[0].text, /Reading your receipt…/);
  assert.doesNotMatch(sent[0].text, /Got your receipts/);
});

// Live incident (2026-07-20): a clerk sending several receipts as SEPARATE individual
// messages (not a true multi-select Telegram album) got one "Reading your receipt…" spam
// message PER photo, and all of them fired at the AI service with zero pacing — because
// nothing coalesced them (only a real media_group_id did). These lock in the fix: several
// individually-sent photos from the SAME chat within one debounce window now coalesce into
// ONE batch, exactly like a real album.
test('bulk-spam fix: several individually-sent photos (no media_group_id) from the SAME chat coalesce into ONE batch', async (t) => {
  const timers = fakeTimers();
  // 2026-07-20: raises the cap (default now 2) so this test can still exercise 3 photos —
  // it's testing coalescing, not the cap itself.
  const { deps, sent, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5, maxGroupImages: 10 });
  await handleUpdate({ message: { chat: { id: 72 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'p1' }] } }, deps);
  await handleUpdate({ message: { chat: { id: 72 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'p2' }] } }, deps);
  await handleUpdate({ message: { chat: { id: 72 }, from: { first_name: 'Bo' }, photo: [{ file_id: 'p3' }] } }, deps);
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 1, 'one coalesced batch call, not three separate expenseFromPhoto calls');
  assert.strictEqual(runBatchCalls[0].images.length, 3);
  const acks = sent.filter((s) => /Reading your receipt|Got your receipts/.test(s.text));
  assert.strictEqual(acks.length, 1, 'exactly ONE ack for the whole burst — this is the reported spam fix');
});

test('bulk-spam fix: individually-sent photos from DIFFERENT chats never coalesce together', async (t) => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 5 });
  await handleUpdate({ message: { chat: { id: 73 }, from: { first_name: 'A' }, photo: [{ file_id: 'a1' }] } }, deps);
  await handleUpdate({ message: { chat: { id: 74 }, from: { first_name: 'B' }, photo: [{ file_id: 'b1' }] } }, deps);
  await timers.runPending();
  // Two chats, each with exactly one photo -> two solo (single-receipt) flushes, no batch call.
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

// 2026-07-20 (owner request, revised): over-cap no longer processes the first `cap` photos
// and drops the rest — it rejects the WHOLE batch, unread. Nothing gets scanned at all.
test('MAX_GROUP_IMAGES clamp: over-cap batch is rejected WHOLESALE — runBatch is never called', async (t) => {
  const timers = fakeTimers();
  const { deps, runBatchCalls } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 2,
  });
  await handleUpdate(photoUpdate('grpCap', 'f1'), deps);
  await handleUpdate(photoUpdate('grpCap', 'f2'), deps);
  await handleUpdate(photoUpdate('grpCap', 'f3'), deps); // pushes the group over-cap
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 0, 'nothing gets scanned once a batch goes over-cap — not even the first 2');
});

test('MAX_GROUP_IMAGES clamp: over-cap batch gets a plain "max N per batch" reject message', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 2,
  });
  await handleUpdate(photoUpdate('grpCapMsg', 'f1'), deps);
  await handleUpdate(photoUpdate('grpCapMsg', 'f2'), deps);
  await handleUpdate(photoUpdate('grpCapMsg', 'f3'), deps);
  await handleUpdate(photoUpdate('grpCapMsg', 'f4'), deps);
  await timers.runPending();
  const rejectMsg = sent[sent.length - 1].text;
  assert.match(rejectMsg, /Max 2 receipts per batch/i);
  assert.match(rejectMsg, /1 to 2 receipts/i);
  assert.ok(!/Batch processed/.test(rejectMsg), 'must NOT be the normal batch-processed summary');
});

test('MAX_GROUP_IMAGES clamp: a batch WITHIN the cap processes normally, no reject message', async (t) => {
  const timers = fakeTimers();
  const { deps, sent, runBatchCalls } = baseDeps(t, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1 });
  await handleUpdate(photoUpdate('grpNoDrop', 'f1'), deps);
  await handleUpdate(photoUpdate('grpNoDrop', 'f2'), deps);
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 1, 'a within-cap batch still gets scanned normally');
  assert.match(sent[sent.length - 1].text, /Batch processed/);
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

// 2026-07-20 incident: a burst of receipts exhausted the Groq key pool's per-minute token
// budget; callGroq's own Error('429') landed in the generic "couldn't read" bucket and told
// the user their PHOTO was too blurry — false, and unhelpful (the honest fix is "wait and
// resend", not "take a clearer photo"). These lock in the fix at the batch-summary layer.
test('formatBatchSummary: a rate-limited failure gets an honest "high demand" message, not "couldn\'t read"', () => {
  const text = formatBatchSummary({
    images: 1, receipts: 0, saved: 0,
    failed: [{ image_index: 0, reason: '429', rateLimited: true }],
    flagged: [], truncated_images: [],
  });
  assert.match(text, /1 receipt delayed by high demand/);
  assert.doesNotMatch(text, /couldn't read/);
  assert.match(text, /temporary limit from sending too many at once/);
  assert.match(text, /wait about a minute/);
});

test('formatBatchSummary: a genuine unreadable failure keeps the original "couldn\'t read" wording, no rate-limit note', () => {
  const text = formatBatchSummary({
    images: 1, receipts: 0, saved: 0,
    failed: [{ image_index: 0, reason: 'some real OCR error' }], // rateLimited omitted, same as an older runBatch
    flagged: [], truncated_images: [],
  });
  assert.match(text, /1 couldn't read/);
  assert.doesNotMatch(text, /high demand/);
  assert.doesNotMatch(text, /temporary limit/);
});

test('formatBatchSummary: a mix of rate-limited and genuinely-unreadable failures reports both counts honestly', () => {
  const text = formatBatchSummary({
    images: 3, receipts: 1, saved: 0,
    failed: [
      { image_index: 0, reason: '429', rateLimited: true },
      { image_index: 1, reason: '429', rateLimited: true },
      { image_index: 2, reason: 'garbled OCR output' },
    ],
    flagged: [], truncated_images: [],
  });
  assert.match(text, /1 couldn't read/);
  assert.match(text, /2 receipts delayed by high demand/);
});

test('formatBatchSummary lists each saved receipt (merchant · amount · category) when given the saved list', () => {
  const summary = { images: 2, receipts: 2, saved: 2, failed: [], flagged: [], truncated_images: [] };
  const saved = [
    { merchant: 'L.C. Vegetarian', amount: 36, currency: 'MYR', category: 'Food', flagged: false },
    { merchant: 'Shell', amount: 86, currency: 'MYR', category: 'Petrol', flagged: true },
  ];
  const text = formatBatchSummary(summary, saved);
  assert.match(text, /L\.C\. Vegetarian/, 'first merchant listed');
  assert.match(text, /Shell/, 'second merchant listed');
  assert.match(text, /Food/);
  assert.match(text, /Petrol/);
  assert.match(text, /⚠️/, 'the flagged receipt is marked for review');
  // still counts-only compatible: passing no saved list renders exactly as before
  assert.ok(!formatBatchSummary(summary).includes('Shell'), 'omitting the saved list keeps the old counts-only summary');
});

test('ADR-017: formatBatchSummary shows voucher_no per receipt when present, omits it when absent', () => {
  const summary = { images: 2, receipts: 2, saved: 2, failed: [], flagged: [], truncated_images: [] };
  const saved = [
    { merchant: 'L.C. Vegetarian', amount: 36, currency: 'MYR', category: 'Food', voucher_no: 'RC-2026-0007', flagged: false },
    { merchant: 'Shell', amount: 86, currency: 'MYR', category: 'Petrol', flagged: false }, // no voucher_no (pre-migration row)
  ];
  const text = formatBatchSummary(summary, saved);
  assert.match(text, /RC-2026-0007/, 'the first receipt shows its reference number');
  const shellLine = text.split('\n').find(l => l.includes('Shell'));
  assert.ok(!/RC-/.test(shellLine), 'no reference number is fabricated for a receipt that has none');
});

test('a media group with a real assembleExpense-returned voucher_no flows into the summary', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images, fieldSpec, d) => {
      await d.assembleExpense({ ...d.meta, fields: { merchant: 'Bonda', amount: 10 } });
      return { images: images.length, receipts: images.length, saved: 1, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ fields }) => ({ expense: { merchant: fields.merchant, amount: fields.amount, currency: 'MYR', category: 'Food', voucher_no: 'RC-2026-0042' }, flagged: false }),
  });
  await handleUpdate(photoUpdate('grpVoucher', 'f1'), deps);
  await timers.runPending();
  assert.match(sent[sent.length - 1].text, /RC-2026-0042/);
});

test('formatBatchSummary humanizes a skipped (non-receipt) photo instead of silently omitting it', () => {
  const text = formatBatchSummary({
    images: 4, receipts: 4, saved: 2, skipped: 2,
    failed: [], flagged: [], truncated_images: [],
  });
  assert.match(text, /2 photos not a clear receipt/);
  assert.match(text, /didn't look like a clear receipt/i);
  assert.match(text, /NOT saved — please re-upload them/i);
});

test('formatBatchSummary: skipped=1 uses singular wording ("it was NOT saved")', () => {
  const text = formatBatchSummary({ images: 1, receipts: 1, saved: 0, skipped: 1, failed: [], flagged: [], truncated_images: [] });
  assert.match(text, /1 photo not a clear receipt/);
  assert.match(text, /it was NOT saved — please re-upload it/i);
});

test('formatBatchSummary: a loud NOT-saved warning appears near the top when anything was dropped (Owner directive 2026-07-11)', () => {
  // 3 saved, 2 skipped + 1 duplicate = 3 NOT saved -> plural warning line.
  const text = formatBatchSummary({ images: 6, receipts: 6, saved: 3, skipped: 2, duplicates: 1, failed: [], flagged: [], truncated_images: [] });
  assert.match(text, /⚠️/);
  assert.match(text, /3 receipts were NOT saved — please re-send them/);
  // Sits above the per-item saved breakdown, so it can't hide beneath the ✅ header.
  assert.ok(text.indexOf('NOT saved') < text.indexOf('Open your dashboard'), 'warning is near the top, before the footer');
});

test('formatBatchSummary: singular NOT-saved warning ("1 receipt was NOT saved … re-send it")', () => {
  const text = formatBatchSummary({ images: 2, receipts: 2, saved: 1, skipped: 0, duplicates: 1, failed: [], flagged: [], truncated_images: [] });
  assert.match(text, /1 receipt was NOT saved — please re-send it/);
});

test('formatBatchSummary: NO warning line when every receipt saved cleanly', () => {
  const text = formatBatchSummary({ images: 2, receipts: 2, saved: 2, skipped: 0, duplicates: 0, failed: [], flagged: [], truncated_images: [] });
  assert.ok(!text.includes('NOT saved'), 'a fully-clean batch never shows the scary warning');
});

test('a media group with a mix of real + non-receipt photos: the breakdown lists ONLY real saves, never the skipped junk', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    runBatch: async (images, fieldSpec, d) => {
      // Mirrors the real runBatch: calls the injected assembleExpense per image and
      // respects its skipped flag.
      let saved = 0, skipped = 0;
      for (let i = 0; i < images.length; i++) {
        const res = await d.assembleExpense({ ...d.meta, fields: { merchant: 'Img' + i } });
        if (res.skipped) skipped++; else saved++;
      }
      return { images: images.length, receipts: images.length, saved, skipped, failed: [], flagged: [], truncated_images: [] };
    },
    // Image 0 is a real receipt; image 1 is a temple photo the model still tried to read.
    assembleExpense: async ({ fields }) => (
      fields.merchant === 'Img0'
        ? { expense: { merchant: 'Real Shop', amount: 20, currency: 'MYR', category: 'Food' }, flagged: false, skipped: false }
        : { expense: { merchant: 'Unknown', amount: 0, currency: 'MYR', category: 'Others' }, flagged: false, skipped: true }
    ),
  });
  await handleUpdate(photoUpdate('grpMixed', 'f1'), deps);
  await handleUpdate(photoUpdate('grpMixed', 'f2'), deps);
  await timers.runPending();
  const summaryMsg = sent[sent.length - 1].text;
  assert.match(summaryMsg, /Real Shop/, 'the real receipt is listed');
  assert.ok(!summaryMsg.includes('Unknown'), 'the skipped non-receipt must never appear in the per-item breakdown');
  assert.match(summaryMsg, /1 photo not a clear receipt/);
});

test('formatBatchSummary: given skippedReasons, breaks the skip count down by WHY (blurry vs not a receipt at all)', () => {
  const summary = { images: 3, receipts: 3, saved: 1, skipped: 2, failed: [], flagged: [], truncated_images: [] };
  const text = formatBatchSummary(summary, [], ['blurry', 'not_receipt']);
  assert.match(text, /1 photo too blurry or unclear to read confidently/);
  assert.match(text, /1 photo that didn't look like a receipt at all/);
  assert.match(text, /NOT saved, please re-upload/i);
});

test('formatBatchSummary: skippedReasons missing/incomplete falls back to the safe generic wording', () => {
  const summary = { images: 2, receipts: 2, saved: 0, skipped: 2, failed: [], flagged: [], truncated_images: [] };
  // Only one reason recorded for two skips (e.g. a hostile/short array) — must not
  // mis-render a partial breakdown, falls back to the plain "N skipped" line.
  const text = formatBatchSummary(summary, [], ['blurry']);
  assert.match(text, /didn't look like a clear receipt, so they were NOT saved — please re-upload them/i);
  assert.ok(!text.includes('too blurry or unclear to read confidently'), 'must not render a half-populated breakdown');
});

test('formatBatchSummary: an "unclear" reason in the mix falls back to generic wording rather than mislabeling it', () => {
  const summary = { images: 3, receipts: 3, saved: 0, skipped: 3, failed: [], flagged: [], truncated_images: [] };
  const text = formatBatchSummary(summary, [], ['blurry', 'not_receipt', 'unclear']);
  assert.match(text, /didn't look like a clear receipt, so they were NOT saved — please re-upload them/i);
});

// 2026-07-21: a 'date_unreadable' skip (the photo was CLEAR, only the date was
// implausible — e.g. a misread year) must get its own accurate wording, not the generic
// "didn't look like a clear receipt" line, which would misdescribe a perfectly readable photo.
test('formatBatchSummary: given a date_unreadable reason, breaks it out with its own accurate wording', () => {
  const summary = { images: 2, receipts: 2, saved: 1, skipped: 1, failed: [], flagged: [], truncated_images: [] };
  const text = formatBatchSummary(summary, [], ['date_unreadable']);
  assert.match(text, /1 photo whose date couldn't be read clearly/);
  assert.match(text, /NOT saved, please re-upload/i);
  assert.ok(!text.includes("didn't look like a clear receipt"), 'must not use the generic clear-receipt wording for a date-only issue');
});

test('formatBatchSummary: mixes blurry + date_unreadable reasons with natural "and" joining', () => {
  const summary = { images: 3, receipts: 3, saved: 1, skipped: 2, failed: [], flagged: [], truncated_images: [] };
  const text = formatBatchSummary(summary, [], ['blurry', 'date_unreadable']);
  assert.match(text, /1 photo too blurry or unclear to read confidently and 1 photo whose date couldn't be read clearly/);
});

test('a media group with blurry AND not-a-receipt skips: the summary breaks them down by reason, real receipt untouched', async (t) => {
  const timers = fakeTimers();
  // 2026-07-20: raises the cap (default now 2) so this test can still exercise 3 photos.
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 10,
    runBatch: async (images, fieldSpec, d) => {
      let saved = 0, skipped = 0;
      for (let i = 0; i < images.length; i++) {
        const res = await d.assembleExpense({ ...d.meta, fields: { merchant: 'Img' + i } });
        if (res.skipped) skipped++; else saved++;
      }
      return { images: images.length, receipts: images.length, saved, skipped, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ fields }) => {
      if (fields.merchant === 'Img0') return { expense: { merchant: 'Real Shop', amount: 20, currency: 'MYR', category: 'Food' }, flagged: false, skipped: false };
      if (fields.merchant === 'Img1') return { expense: { merchant: 'Unknown' }, flagged: false, skipped: true, skipReason: 'blurry' };
      return { expense: { merchant: 'Unknown' }, flagged: false, skipped: true, skipReason: 'not_receipt' };
    },
  });
  await handleUpdate(photoUpdate('grpReasons', 'f1'), deps);
  await handleUpdate(photoUpdate('grpReasons', 'f2'), deps);
  await handleUpdate(photoUpdate('grpReasons', 'f3'), deps);
  await timers.runPending();
  const summaryMsg = sent[sent.length - 1].text;
  assert.match(summaryMsg, /Real Shop/);
  assert.match(summaryMsg, /1 photo too blurry or unclear to read confidently/);
  assert.match(summaryMsg, /1 photo that didn't look like a receipt at all/);
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

// --- Category-picker in a batch (Owner's own example, 2026-07-03): "if upload 5
// receipts, there 3 receipts can get category, another 2 is unknown, first saved
// response for 3 receipts once then another 2 receipts send separate response for
// choose category". ---
test('batch of 5: 3 confident + 2 uncertain -> ONE main summary (covers the 3), then TWO separate category-picker messages', async (t) => {
  const timers = fakeTimers();
  // 2026-07-20: raises the cap (default now 2) so this test can still exercise 5 photos —
  // it's testing the confident/uncertain split, not the cap.
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1, maxGroupImages: 10,
    tgSend: async (chatId, text, keyboard) => { sent.push({ chatId, text, keyboard }); return { ok: true }; },
    // A runBatch fake that behaves like the real one: calls the injected assembleExpense
    // once per image, in order, so flushGroup's captureAssemble wrapper sees each result.
    runBatch: async (images, fieldSpec, d) => {
      for (let i = 0; i < images.length; i++) {
        await d.assembleExpense({ ...d.meta, fields: { merchant: 'Shop' + i, amount: 10 + i } });
      }
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    assembleExpense: async ({ fields }) => {
      const i = Number(fields.merchant.replace('Shop', ''));
      const uncertain = i === 3 || i === 4; // the last 2 of 5 are "unknown"
      const expense = { id: 'exp-' + i, merchant: fields.merchant, amount: fields.amount, currency: 'MYR', category: uncertain ? '__pending__' : 'Food' };
      return uncertain
        ? { expense, flagged: false, awaitingCategory: true, categoryOptions: ['Food', 'Petrol', 'Others'] }
        : { expense, flagged: false };
    },
  });
  for (let i = 0; i < 5; i++) await handleUpdate(photoUpdate('grp5', 'f' + i), deps);
  await timers.runPending();

  // 1 album-ack + 1 main summary + 2 separate picker prompts = 4 messages total.
  assert.strictEqual(sent.length, 4, 'ack + summary + one picker message per uncertain receipt');
  assert.match(sent[0].text, /reading them all now/i);
  const summaryMsg = sent[1];
  assert.match(summaryMsg.text, /3 saved/, 'the headline count only counts the 3 confident receipts');
  assert.match(summaryMsg.text, /2 receipts need a category picked/i);
  assert.match(summaryMsg.text, /Shop0/); // the 3 confident ones ARE in the itemized breakdown
  assert.match(summaryMsg.text, /Shop1/);
  assert.match(summaryMsg.text, /Shop2/);
  assert.ok(!summaryMsg.text.includes('Shop3') && !summaryMsg.text.includes('Shop4'), 'the 2 uncertain ones are NOT in the main breakdown');

  const pickerMsgs = sent.slice(2);
  assert.strictEqual(pickerMsgs.length, 2);
  for (const m of pickerMsgs) {
    assert.ok(m.keyboard && Array.isArray(m.keyboard.inline_keyboard), 'each picker message carries an inline keyboard');
    assert.match(m.text, /not sure what category/i);
  }
});
