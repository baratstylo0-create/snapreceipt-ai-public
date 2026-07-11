'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Owner request 2026-07-11: tapping "🗑️ Delete" on the single-receipt dupedit menu (Edit
// staff / Delete) should turn THAT SAME message into the Yes/Cancel confirm, and confirming
// turns it into "Deleted: ..." — one message walking menu -> confirm -> deleted, never a
// fresh bubble per step. dupdel: is deliberately a SEPARATE prefix from delask: (used by the
// Today's Bills LIST) — editing the list message in place would wipe out every OTHER bill's
// own delete button, so delask: still opens a fresh message (see tests/bot.delask.test.js).
// The final confirm->deleted step reuses the already-tested del:<id> flow unchanged (it
// already edits in place via its own `reply`), since dupdel: hands it the SAME message_id.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const edited = [];
  const answered = [];
  const softDeleteCalls = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgEditMessage: async (chatId, messageId, text, replyMarkup) => { edited.push({ chatId, messageId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbSoftDelete: async (table, { id }) => { softDeleteCalls.push({ table, id }); },
    ...over,
  };
  return { deps, sent, edited, answered, softDeleteCalls };
}
const withMessageId = (chatId, messageId) => ({ chat: { id: chatId }, message_id: messageId });

const OWNED_ROW = { id: 'exp-9', merchant: 'Capati Cheng Enterprise', amount: 62.80, currency: 'MYR', rep_chat_id: '100', deleted_at: null };

test('dupdel: with a message_id — EDITS the menu message into the Yes/Cancel confirm, no new message', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb1', data: 'dupdel:exp-9', message: withMessageId(100, 555) }, deps);
  assert.strictEqual(sent.length, 0, 'no new bubble — the menu message is edited in place');
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].chatId, 100);
  assert.strictEqual(edited[0].messageId, 555);
  assert.match(edited[0].text, /Capati Cheng Enterprise/);
  const btns = edited[0].replyMarkup.inline_keyboard[0];
  assert.strictEqual(btns[0].callback_data, 'del:exp-9', 'confirm reuses the existing, already-tested del: flow');
  assert.strictEqual(btns[1].callback_data, 'del:cancel');
});

test('dupdel: end-to-end — menu -> confirm -> deleted stays the SAME message_id throughout', async () => {
  const { deps, edited } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb2', data: 'dupdel:exp-9', message: withMessageId(100, 700) }, deps);
  const confirmData = edited[0].replyMarkup.inline_keyboard[0][0].callback_data; // 'del:exp-9'

  const { deps: d2, edited: edited2, softDeleteCalls } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb3', data: confirmData, message: withMessageId(100, 700) }, d2);
  assert.strictEqual(softDeleteCalls.length, 1);
  assert.strictEqual(softDeleteCalls[0].id, 'exp-9');
  assert.strictEqual(edited2[0].messageId, 700, 'the FINAL "Deleted" state lands on the exact same message');
  assert.match(edited2[0].text, /Deleted.*Capati Cheng Enterprise/s);
});

test('dupdel: SECURITY — a different chat is refused, no confirm keyboard, edited in place with a warning', async () => {
  const { deps, sent, edited, answered } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb4', data: 'dupdel:exp-9', message: withMessageId(999, 555) }, deps);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(edited.length, 1);
  assert.match(edited[0].text, /can't delete/i);
  assert.strictEqual(edited[0].replyMarkup, undefined, 'no confirm keyboard for a bill that is not yours');
  assert.strictEqual(answered[0].opts.text, 'Not yours');
});

test('dupdel: an already-deleted row is refused with "already gone", edited in place', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [{ ...OWNED_ROW, deleted_at: '2026-07-11T00:00:00Z' }] });
  await handleCallbackQuery({ id: 'cb5', data: 'dupdel:exp-9', message: withMessageId(100, 555) }, deps);
  assert.strictEqual(sent.length, 0);
  assert.match(edited[0].text, /already gone/i);
});

test('dupdel: an unknown/vanished row id is refused gracefully, no crash', async () => {
  const { deps, edited } = baseDeps({ sbSelect: async () => [] });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb6', data: 'dupdel:ghost', message: withMessageId(100, 555) }, deps));
  assert.match(edited[0].text, /already gone/i);
});

test('dupdel: a lookup failure never throws, always acks, never leaks internals', async () => {
  const { deps, edited, answered } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 internal'); } });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb7', data: 'dupdel:exp-9', message: withMessageId(100, 555) }, deps));
  assert.strictEqual(answered.length, 1);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(edited[0].text));
});

test('dupdel: with NO message_id (defensive fallback) still sends a normal new message, no crash', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb8', data: 'dupdel:exp-9', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(edited.length, 0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Capati Cheng Enterprise/);
  assert.strictEqual(sent[0].replyMarkup.inline_keyboard[0][0].callback_data, 'del:exp-9');
});
