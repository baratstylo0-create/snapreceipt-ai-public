'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// "❌ #N" tap from the "📋 Today Bills" list (Owner request 2026-07-04): shows the SAME
// Yes/Cancel confirm keyboard as handleDeleteIntent (reusing the already-tested `del:<id>`
// flow for the actual delete), but ownership is checked HERE too — the Today Bills list is
// account-wide, but deletion stays scoped to the ORIGINAL submitter only (Owner's choice).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const softDeleteCalls = [];
  // sbSelectGlobal (2026-08-23): see lib/bot.js's handleCallbackQuery doc comment.
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbSelectGlobal: async () => [],
    sbSoftDelete: async (table, { id }) => { softDeleteCalls.push({ table, id }); },
    ...resolvedOver,
  };
  return { deps, sent, answered, softDeleteCalls };
}

const OWNED_ROW = { id: 'e5', merchant: 'Starbucks', amount: 12, currency: 'MYR', rep_chat_id: '100' };

test('delask: an owned row -> shows a Yes/Cancel confirm keyboard reusing del:<id>/del:cancel', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb1', data: 'delask:e5', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(sent.length, 1);
  const btns = sent[0].replyMarkup.inline_keyboard[0];
  assert.strictEqual(btns[0].callback_data, 'del:e5');
  assert.strictEqual(btns[1].callback_data, 'del:cancel');
  assert.match(sent[0].text, /Starbucks/);
});

test('delask: SECURITY — a DIFFERENT chat (Today Bills is account-wide, but delete is not) gets refused immediately, no confirm keyboard shown', async () => {
  const { deps, sent, answered } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb2', data: 'delask:e5', message: { chat: { id: 999 } } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /only the person who submitted/i);
  assert.strictEqual(sent[0].replyMarkup, undefined, 'no confirm keyboard for a bill that is not yours');
  assert.strictEqual(answered[0].opts.text, 'Not yours');
});

test('delask: an already-deleted row is refused with "already gone", no confirm keyboard', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [{ ...OWNED_ROW, deleted_at: '2026-07-04T00:00:00Z' }] });
  await handleCallbackQuery({ id: 'cb3', data: 'delask:e5', message: { chat: { id: 100 } } }, deps);
  assert.match(sent[0].text, /already gone/i);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('delask: an unknown/vanished row id is refused gracefully, no crash', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb4', data: 'delask:ghost', message: { chat: { id: 100 } } }, deps));
  assert.match(sent[0].text, /already gone/i);
});

test('delask: a lookup failure never throws, always acks, never leaks internals', async () => {
  const { deps, sent, answered } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 internal'); } });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb5', data: 'delask:e5', message: { chat: { id: 100 } } }, deps));
  assert.strictEqual(answered.length, 1);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(sent[0].text));
});

test('delask -> del round trip: confirming actually deletes (reuses the existing, already-tested del: flow)', async () => {
  const { deps: d1, sent } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb6', data: 'delask:e5', message: { chat: { id: 100 } } }, d1);
  const confirmData = sent[0].replyMarkup.inline_keyboard[0][0].callback_data; // 'del:e5'

  const { deps: d2, softDeleteCalls } = baseDeps({ sbSelect: async () => [OWNED_ROW] });
  await handleCallbackQuery({ id: 'cb7', data: confirmData, message: { chat: { id: 100 } } }, d2);
  assert.strictEqual(softDeleteCalls.length, 1);
  assert.strictEqual(softDeleteCalls[0].id, 'e5');
});
