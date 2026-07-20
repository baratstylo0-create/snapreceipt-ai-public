'use strict';
// Access allowlist (ALLOWED_CHAT_IDS): when set, only listed Telegram chat IDs may use
// the bot; everyone else gets a polite "private bot" reply and NOTHING runs. Unset = open
// (back-compat). The list is injected via deps.allowedChatIds for hermetic tests.
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

// 2026-07-20: a single photo now buffers through the same debounce as an album (bulk-spam
// fix), so these tests need a fake timer to deterministically flush it instead of relying on
// a real setTimeout — same pattern already used throughout tests/bot.batch*.test.js.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    runPending: async () => { for (const fn of [...pending.values()]) { pending.clear(); await fn(); } },
  };
}

function baseDeps(over = {}) {
  const sent = [];
  const ran = [];
  const timers = fakeTimers();
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    expenseFromPhoto: async (chatId) => { ran.push('photo:' + chatId); },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    ...over,
  };
  return { deps, sent, ran, runPending: timers.runPending };
}
const photo = (chatId) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' }, photo: [{ file_id: 'f' }] } });
const textMsg = (chatId, text) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' }, text } });

test('allowlist set: an ALLOWED chat id is served normally', async () => {
  const { deps, ran, runPending } = baseDeps({ allowedChatIds: ['1376793145', '1979799104'] });
  await handleUpdate(photo(1979799104), deps); // Jeevan
  await runPending();
  assert.deepStrictEqual(ran, ['photo:1979799104'], 'allowed user reaches the normal photo flow');
});

test('allowlist set: a NON-allowed chat id is blocked with a private-bot reply, nothing runs', async () => {
  const { deps, sent, ran } = baseDeps({ allowedChatIds: ['1376793145', '1979799104'] });
  await handleUpdate(photo(999999), deps); // stranger
  assert.strictEqual(ran.length, 0, 'the receipt flow never runs for a stranger');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /private bot/i);
});

test('allowlist set: even /start and text commands are blocked for a stranger', async () => {
  const { deps, sent } = baseDeps({ allowedChatIds: ['1376793145'] });
  await handleUpdate(textMsg(555, '/start'), deps);
  await handleUpdate(textMsg(555, 'show expenses'), deps);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every(s => /private bot/i.test(s.text)), 'no command works for a non-allowed user');
});

test('allowlist EMPTY (unset): open to anyone — back-compat, unchanged behavior', async () => {
  const { deps, ran, sent, runPending } = baseDeps({ allowedChatIds: [] });
  await handleUpdate(photo(12345), deps);
  await runPending();
  assert.deepStrictEqual(ran, ['photo:12345'], 'with no allowlist configured, any user is served');
  assert.ok(!sent.some(s => /private bot/i.test(s.text)));
});

test('chat id type-agnostic: numeric chat id matches its string form in the allowlist', async () => {
  const { deps, ran, runPending } = baseDeps({ allowedChatIds: ['1979799104'] });
  await handleUpdate(photo(1979799104), deps); // numeric id, string allowlist entry
  await runPending();
  assert.deepStrictEqual(ran, ['photo:1979799104']);
});

// SECURITY: the allowlist gate must cover callback_query updates (inline-keyboard button
// taps, e.g. the delete confirm/cancel buttons) exactly like message updates — a stranger
// must not be able to act on the bot just because they got a button in front of them.
test('allowlist set: a callback_query from a NON-allowed chat is blocked, handleCallbackQuery never runs', async () => {
  let callbackRan = false;
  const acked = [];
  const deps = {
    allowedChatIds: ['1376793145'],
    tgSend: async () => { throw new Error('must not reply to a stranger callback'); },
    tgAnswerCallback: async (id) => { acked.push(id); },
    handleCallbackQuery: async () => { callbackRan = true; },
  };
  await handleUpdate({ callback_query: { id: 'cbS', data: 'del:x', message: { chat: { id: 999999 } } } }, deps);
  assert.strictEqual(callbackRan, false, 'a stranger\'s button tap must never reach handleCallbackQuery');
  assert.deepStrictEqual(acked, ['cbS'], 'the button must still be acked so it does not spin forever');
});

test('allowlist set: a callback_query from an ALLOWED chat reaches handleCallbackQuery normally', async () => {
  let seen = null;
  const deps = { allowedChatIds: ['1979799104'], handleCallbackQuery: async (cq) => { seen = cq; } };
  await handleUpdate({ callback_query: { id: 'cbA', data: 'del:x', message: { chat: { id: 1979799104 } } } }, deps);
  assert.strictEqual(seen && seen.id, 'cbA');
});
