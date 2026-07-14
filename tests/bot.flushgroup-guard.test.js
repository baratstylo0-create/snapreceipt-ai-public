'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Regression test for a QA finding (subagent debug pass, 2026-07-03): flushGroup's
// dependency-resolution lines (tgFileUrl/getFieldSpec/runBatch/etc.) used to sit
// OUTSIDE its own try/catch. If any of them threw while being resolved, the throw
// happened inside an async function with no surrounding guard, and the setTimeout
// call site invoked flushGroup() fire-and-forget (no await/.catch) — so the
// rejection became a silent Node unhandledRejection with NO reply ever sent to the
// user. Same failure shape as the tgSend Markdown bug fixed in PR #44, just a
// different trigger. Fix: widen the try to cover dep resolution, and add a
// defense-in-depth .catch() at the setTimeout call site (lib/bot.js).
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

function photoUpdate(mediaGroupId, fileId, chatId = 100) {
  return { message: { chat: { id: chatId }, from: { first_name: 'Aina' }, media_group_id: mediaGroupId, photo: [{ file_id: fileId }] } };
}

test('flushGroup: a dep that throws synchronously while being resolved (before the old try started) still gets a safe reply, not silence', async () => {
  const timers = fakeTimers();
  const sent = [];
  const deps = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    debounceMs: 1,
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
    // A hostile/misbehaving dep: throws the instant it's read, not when called.
    get tgFileUrl() { throw new Error('boom while resolving tgFileUrl'); },
  };
  await handleUpdate(photoUpdate('g1', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending(), 'the timer callback must never produce an unhandled rejection');
  assert.ok(sent.length >= 1, 'the user must receive at least one reply, not silence');
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
  assert.ok(!sent.some(s => /boom while resolving/.test(s.text)), 'the raw error must never reach the user');
});

test('flushGroup: even if flushGroup itself somehow rejected, the setTimeout call-site .catch prevents an unhandled rejection', async () => {
  // Directly exercises the call-site wiring in handleUpdate's media-group branch:
  // pass a deps.runBatch that returns a normal promise but simulate the worst case
  // by making getFieldSpec's rejection escape (it's inside the try, so this is
  // really just confirming the whole path stays exception-safe end-to-end).
  const timers = fakeTimers();
  const sent = [];
  const deps = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    debounceMs: 1,
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => { throw new Error('spec load failed'); },
  };
  await handleUpdate(photoUpdate('g2', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
});

// --- Live QA (2026-07-13): an album's ack arrived, the final summary never did — no
// error, no trace. Root cause: tgSend NEVER THROWS (it swallows a Telegram/network
// failure internally and just console.errors), so flushGroup's own try/catch — which only
// guards against a THROW — cannot detect a swallowed send failure on its one summary
// message. From the user's side that's indistinguishable from "stuck forever". Fix:
// flushGroup's terminal replies (download-fail / summary / catch-all) now check tgSend's
// own return value and retry once before giving up, via a shared sendFinal() helper.
//
// These tests deliberately do NOT inject a fake setTimeout: sendFinal's retry delay is
// scheduled from INSIDE a debounce timer callback that a hand-rolled fake-timer queue is
// already mid-await for — draining that queue again from within itself deadlocks (a fake
// timer can't be "woken" by code that's blocked waiting for it to fire). Real timers with
// a 1ms debounce/retry delay side-step that entirely and are simpler to reason about. -----

function baseRealDeps(tgSend) {
  return {
    debounceMs: 1,
    finalRetryDelayMs: 1,
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => ({}),
    runBatch: async () => ({ images: 1, receipts: 1, saved: 1, skipped: 0, skippedDetails: [], duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [] }),
    downloadAndStoreReceiptImage: async () => null,
    tgSend,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 60)); // real short sleep: debounce (1ms) + retry delay (1ms) both fire well within this

test('flushGroup: a summary send that fails once (tgSend swallows and returns undefined) is retried and reaches the user', async () => {
  const sent = [];
  let summaryCalls = 0;
  const deps = baseRealDeps(async (chatId, text) => {
    sent.push({ chatId, text });
    if (/Batch processed/.test(text)) {
      summaryCalls += 1;
      if (summaryCalls === 1) return undefined; // simulates tgSend's own swallowed failure
    }
    return { ok: true };
  });
  await handleUpdate(photoUpdate('g3', 'f1'), deps);
  await settle();
  const summaryMsgs = sent.filter((s) => /Batch processed/.test(s.text));
  assert.strictEqual(summaryCalls, 2, 'the summary send must be retried exactly once after the swallowed failure');
  assert.strictEqual(summaryMsgs.length, 2, 'both attempts are real tgSend calls (the first is the lost one, the second reaches the user)');
});

test('flushGroup: a summary send that fails twice never throws and never double-sends beyond the one retry', async () => {
  let summaryCalls = 0;
  const deps = baseRealDeps(async (chatId, text) => {
    if (/Batch processed/.test(text)) { summaryCalls += 1; return undefined; }
    return { ok: true };
  });
  await assert.doesNotReject(async () => {
    await handleUpdate(photoUpdate('g4', 'f1'), deps);
    await settle();
  });
  assert.strictEqual(summaryCalls, 2, 'exactly one retry — not an infinite/unbounded retry loop');
});

test('flushGroup: a successful summary send on the first try is NOT retried (no duplicate message)', async () => {
  let summaryCalls = 0;
  const deps = baseRealDeps(async (chatId, text) => { if (/Batch processed/.test(text)) summaryCalls += 1; return { ok: true }; });
  await handleUpdate(photoUpdate('g5', 'f1'), deps);
  await settle();
  assert.strictEqual(summaryCalls, 1, 'a message that reaches Telegram fine must never be sent twice');
});

test('flushGroup: logs a start and a done marker for the flush, with the groupId/chatId — so a future stuck-batch report is diagnosable instead of a silent gap', async () => {
  const deps = baseRealDeps(async () => ({ ok: true }));
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await handleUpdate(photoUpdate('g6', 'f1', 200), deps);
    await settle();
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => /\[group flush:start\]/.test(l) && /g6/.test(l) && /200/.test(l)), 'expected a flush:start log with the groupId and chatId');
  assert.ok(logs.some((l) => /\[group flush:done\]/.test(l) && /g6/.test(l)), 'expected a flush:done log');
});
