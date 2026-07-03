'use strict';
// Access allowlist (ALLOWED_CHAT_IDS): when set, only listed Telegram chat IDs may use
// the bot; everyone else gets a polite "private bot" reply and NOTHING runs. Unset = open
// (back-compat). The list is injected via deps.allowedChatIds for hermetic tests.
const test = require('node:test');
const assert = require('node:assert');
const { handleUpdate } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const ran = [];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    expenseFromPhoto: async (chatId) => { ran.push('photo:' + chatId); },
    ...over,
  };
  return { deps, sent, ran };
}
const photo = (chatId) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' }, photo: [{ file_id: 'f' }] } });
const textMsg = (chatId, text) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' }, text } });

test('allowlist set: an ALLOWED chat id is served normally', async () => {
  const { deps, ran } = baseDeps({ allowedChatIds: ['1376793145', '1979799104'] });
  await handleUpdate(photo(1979799104), deps); // Jeevan
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
  const { deps, ran, sent } = baseDeps({ allowedChatIds: [] });
  await handleUpdate(photo(12345), deps);
  assert.deepStrictEqual(ran, ['photo:12345'], 'with no allowlist configured, any user is served');
  assert.ok(!sent.some(s => /private bot/i.test(s.text)));
});

test('chat id type-agnostic: numeric chat id matches its string form in the allowlist', async () => {
  const { deps, ran } = baseDeps({ allowedChatIds: ['1979799104'] });
  await handleUpdate(photo(1979799104), deps); // numeric id, string allowlist entry
  assert.deepStrictEqual(ran, ['photo:1979799104']);
});
