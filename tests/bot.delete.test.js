'use strict';
// In-chat delete: "Delete receipt" typed in Telegram used to hit the generic photo-prompt
// reply, which read as if the bot ignored the message. Now: text intent -> confirm/cancel
// inline keyboard (handleDeleteIntent) -> button tap -> callback_query (handleCallbackQuery)
// -> soft delete. Scoped per-chat (rep_chat_id) both when offering the prompt AND at the
// actual delete, since callback_data only carries an id (the confirm-time check IS the auth
// check, not just the prompt-time one).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleUpdate, handleDeleteIntent, handleCallbackQuery } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const softDeleteCalls = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbSoftDelete: async (table, { id }) => { softDeleteCalls.push({ table, id }); },
    ...over,
  };
  return { deps, sent, answered, softDeleteCalls };
}

test('handleDeleteIntent: no receipts for this chat -> friendly "nothing to delete" reply, no keyboard', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleDeleteIntent(1, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /don't have any receipts/i);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('handleDeleteIntent: found -> prompts with a Yes/Cancel keyboard, scoped to THIS chat only', async () => {
  const eqSeen = [];
  const { deps, sent } = baseDeps({
    sbSelect: async (table, opts) => { eqSeen.push(opts); return [{ id: 'exp-1', merchant: 'Starbucks', amount: 12.5, currency: 'MYR', expense_date: '2026-07-03' }]; },
  });
  await handleDeleteIntent(555, deps);
  assert.strictEqual(eqSeen[0].eq.rep_chat_id, '555', 'must scope lookup to the caller\'s own chat');
  assert.match(eqSeen[0].extra, /deleted_at=is\.null/);
  const btns = sent[0].replyMarkup.inline_keyboard[0];
  assert.strictEqual(btns[0].callback_data, 'del:exp-1');
  assert.strictEqual(btns[1].callback_data, 'del:cancel');
  assert.match(sent[0].text, /Starbucks/);
});

test('handleDeleteIntent: a lookup failure never throws and gives a safe reply', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 supabase-internal'); } });
  await assert.doesNotReject(() => handleDeleteIntent(1, deps));
  assert.match(sent[0].text, /could not look up/i);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(sent[0].text), 'raw error must never leak');
});

test('handleCallbackQuery: "del:cancel" acks the button and confirms nothing was changed, no delete call', async () => {
  const { deps, sent, answered, softDeleteCalls } = baseDeps();
  await handleCallbackQuery({ id: 'cb1', data: 'del:cancel', message: { chat: { id: 9 } } }, deps);
  assert.strictEqual(softDeleteCalls.length, 0);
  assert.strictEqual(answered.length, 1);
  assert.match(sent[0].text, /kept it/i);
});

test('handleCallbackQuery: confirm on an owned, un-deleted row -> soft-deletes and confirms', async () => {
  const { deps, sent, answered, softDeleteCalls } = baseDeps({
    sbSelect: async () => [{ id: 'exp-9', rep_chat_id: '9', merchant: 'Tesco', amount: 30, currency: 'MYR', deleted_at: null }],
  });
  await handleCallbackQuery({ id: 'cb2', data: 'del:exp-9', message: { chat: { id: 9 } } }, deps);
  assert.deepStrictEqual(softDeleteCalls, [{ table: 'expenses', id: 'exp-9' }]);
  assert.strictEqual(answered[0].opts.text, 'Deleted');
  assert.match(sent[0].text, /Tesco/);
});

test('handleCallbackQuery: already-deleted row -> says so, does NOT delete again', async () => {
  const { deps, sent, softDeleteCalls } = baseDeps({
    sbSelect: async () => [{ id: 'exp-9', rep_chat_id: '9', deleted_at: '2026-07-03T00:00:00Z' }],
  });
  await handleCallbackQuery({ id: 'cb3', data: 'del:exp-9', message: { chat: { id: 9 } } }, deps);
  assert.strictEqual(softDeleteCalls.length, 0);
  assert.match(sent[0].text, /already deleted/i);
});

test('handleCallbackQuery: SECURITY — a row belonging to a different chat is refused, not deleted', async () => {
  const { deps, sent, softDeleteCalls } = baseDeps({
    sbSelect: async () => [{ id: 'exp-9', rep_chat_id: '999-someone-else', deleted_at: null }],
  });
  await handleCallbackQuery({ id: 'cb4', data: 'del:exp-9', message: { chat: { id: 9 } } }, deps);
  assert.strictEqual(softDeleteCalls.length, 0, 'must never delete a row that is not this chat\'s own');
  assert.match(sent[0].text, /can't delete that one/i);
});

test('handleCallbackQuery: unknown row id -> treated like already-gone, no throw, no delete', async () => {
  const { deps, sent, softDeleteCalls } = baseDeps({ sbSelect: async () => [] });
  await handleCallbackQuery({ id: 'cb5', data: 'del:does-not-exist', message: { chat: { id: 9 } } }, deps);
  assert.strictEqual(softDeleteCalls.length, 0);
  assert.match(sent[0].text, /already deleted/i);
});

test('handleCallbackQuery: a throw during delete never escapes, still acks, no internals leak', async () => {
  const { deps, sent, answered } = baseDeps({
    sbSelect: async () => [{ id: 'exp-9', rep_chat_id: '9', deleted_at: null }],
    sbSoftDelete: async () => { throw new Error('ECONNREFUSED 10.0.0.5 supabase-internal'); },
  });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb6', data: 'del:exp-9', message: { chat: { id: 9 } } }, deps));
  assert.strictEqual(answered.length, 1, 'the button must still be acked even on failure');
  assert.match(sent[0].text, /couldn't delete/i);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(sent[0].text));
});

test('handleCallbackQuery: unrecognised callback_data just clears the spinner, no reply, no delete', async () => {
  const { deps, sent, answered, softDeleteCalls } = baseDeps();
  await handleCallbackQuery({ id: 'cb7', data: 'something:else', message: { chat: { id: 9 } } }, deps);
  assert.strictEqual(answered.length, 1);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(softDeleteCalls.length, 0);
});

test('handleCallbackQuery: missing chat on the update -> acks without throwing', async () => {
  const { deps, answered } = baseDeps();
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb8', data: 'del:cancel' }, deps));
  assert.strictEqual(answered.length, 1);
});

test('handleUpdate: routes a callback_query update to handleCallbackQuery, never touches the message-shaped path', async () => {
  let called = null;
  const deps = { handleCallbackQuery: async (cq) => { called = cq; } };
  await handleUpdate({ callback_query: { id: 'cbX', data: 'del:cancel', message: { chat: { id: 3 } } } }, deps);
  assert.strictEqual(called.id, 'cbX');
});

test('handleUpdate: typing "delete" routes to handleDeleteIntent, not the generic photo prompt', async () => {
  let calledChatId = null;
  const deps = { tgSend: async () => { throw new Error('should not send the generic fallback'); },
    handleDeleteIntent: async (chatId) => { calledChatId = chatId; } };
  await handleUpdate({ message: { chat: { id: 77 }, from: { first_name: 'A' }, text: 'delete receipt' } }, deps);
  assert.strictEqual(calledChatId, 77);
});

test('handleUpdate: "remove"/"undo"/"cancel" wording also routes to the delete flow', async () => {
  for (const text of ['remove that one', 'undo', 'cancel it']) {
    let hit = false;
    const deps = { handleDeleteIntent: async () => { hit = true; } };
    await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text } }, deps);
    assert.strictEqual(hit, true, `"${text}" should route to handleDeleteIntent`);
  }
});
