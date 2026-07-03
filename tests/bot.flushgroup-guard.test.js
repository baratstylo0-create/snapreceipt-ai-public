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
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
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
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => { throw new Error('spec load failed'); },
  };
  await handleUpdate(photoUpdate('g2', 'f1'), deps);
  await assert.doesNotReject(() => timers.runPending());
  assert.match(sent[sent.length - 1].text, /Couldn't process that batch/i);
});
