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
  // An immediate reassurance ack on the FIRST photo of the album, then ONE summary reply.
  assert.strictEqual(sent.length, 2, 'a reassuring "reading…" ack + the final summary');
  assert.match(sent[0].text, /reading them all now/i, 'the album gets an immediate ack so the chat is not silent');
  assert.match(sent[1].text, /Batch processed/);
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
  assert.match(text, /skipped rather than guessed/i);
});

test('formatBatchSummary: skipped=1 uses singular wording ("it was skipped")', () => {
  const text = formatBatchSummary({ images: 1, receipts: 1, saved: 0, skipped: 1, failed: [], flagged: [], truncated_images: [] });
  assert.match(text, /1 photo not a clear receipt/);
  assert.match(text, /it was skipped/i);
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
  assert.match(text, /1 photo too blurry to read/);
  assert.match(text, /1 photo that didn't look like a receipt at all/);
  assert.match(text, /nothing was guessed/i);
});

test('formatBatchSummary: skippedReasons missing/incomplete falls back to the safe generic wording', () => {
  const summary = { images: 2, receipts: 2, saved: 0, skipped: 2, failed: [], flagged: [], truncated_images: [] };
  // Only one reason recorded for two skips (e.g. a hostile/short array) — must not
  // mis-render a partial breakdown, falls back to the plain "N skipped" line.
  const text = formatBatchSummary(summary, [], ['blurry']);
  assert.match(text, /didn't look like a clear receipt, so they were skipped rather than guessed/i);
  assert.ok(!text.includes('too blurry to read'), 'must not render a half-populated breakdown');
});

test('formatBatchSummary: an "unclear" reason in the mix falls back to generic wording rather than mislabeling it', () => {
  const summary = { images: 3, receipts: 3, saved: 0, skipped: 3, failed: [], flagged: [], truncated_images: [] };
  const text = formatBatchSummary(summary, [], ['blurry', 'not_receipt', 'unclear']);
  assert.match(text, /didn't look like a clear receipt, so they were skipped rather than guessed/i);
});

test('a media group with blurry AND not-a-receipt skips: the summary breaks them down by reason, real receipt untouched', async (t) => {
  const timers = fakeTimers();
  const { deps, sent } = baseDeps(t, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
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
  assert.match(summaryMsg, /1 photo too blurry to read/);
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
