'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Completes the "Others -> type a remark" flow (Owner request 2026-07-03): after tapping
// Others (tests/bot.categorypicker.test.js), the row is status='awaiting_remark'. The NEXT
// plain-text message from that chat is treated as the remark. Critical regression
// requirement (per the Owner): a chat with NO pending remark must be completely unaffected
// — /start, "show expenses", and delete-intent keywords must keep working exactly as before.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleUpdate, tryResolveRemark } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const edited = [];
  const updateCalls = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgEditMessage: async (chatId, messageId, text) => { edited.push({ chatId, messageId, text }); },
    sbSelect: async () => [],
    sbUpdate: async (table, { id }, patch) => { updateCalls.push({ table, id, patch }); },
    pendingRemarkMessages: new Map(), // fresh per test — isolates from the real module-level Map
    ...over,
  };
  return { deps, sent, edited, updateCalls };
}

const AWAITING_ROW = { id: 'exp-9', merchant: 'Bonda KL', amount: 183.65, currency: 'MYR', status: 'awaiting_remark', rep_chat_id: '100', created_at: '2026-07-03T00:00:00Z' };

test('tryResolveRemark: a pending row -> updated with the typed text as remark, status saved, returns true', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  const handled = await tryResolveRemark(100, 'lunch with a supplier', deps);
  assert.strictEqual(handled, true);
  assert.strictEqual(updateCalls.length, 1);
  assert.deepStrictEqual(updateCalls[0].patch, { remark: 'lunch with a supplier', status: 'saved' });
  assert.match(sent[0].text, /lunch with a supplier/);
  assert.match(sent[0].text, /Bonda KL/);
});

test('tryResolveRemark: no pending row for this chat -> returns false, nothing updated, nothing sent', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [] });
  const handled = await tryResolveRemark(100, 'random text', deps);
  assert.strictEqual(handled, false);
  assert.strictEqual(updateCalls.length, 0);
  assert.strictEqual(sent.length, 0);
});

// --- Edit-in-place (Owner request 2026-07-04): if the "Others" tap remembered a
// message_id (set in handleCallbackQuery when the tap happened), resolving the remark
// EDITS that same message into its final state instead of sending yet another new one. ---

test('tryResolveRemark: a remembered message_id -> the ORIGINAL message is edited, no new message, mapping cleared after', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  deps.pendingRemarkMessages.set('exp-9', { chatId: 100, messageId: 777 });
  const handled = await tryResolveRemark(100, 'client dinner', deps);
  assert.strictEqual(handled, true);
  assert.strictEqual(sent.length, 0, 'no new message — the original picker message is edited instead');
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].chatId, 100);
  assert.strictEqual(edited[0].messageId, 777);
  assert.match(edited[0].text, /client dinner/);
  assert.strictEqual(deps.pendingRemarkMessages.has('exp-9'), false, 'the mapping is cleared once resolved');
});

test('tryResolveRemark: NO remembered message_id (e.g. a bot restart in between) -> falls back to a fresh message, no crash', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [AWAITING_ROW] }); // pendingRemarkMessages starts empty
  const handled = await tryResolveRemark(100, 'client dinner', deps);
  assert.strictEqual(handled, true);
  assert.strictEqual(edited.length, 0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /client dinner/);
});

test('tryResolveRemark: a lookup/update failure never throws, returns false so the caller falls through', async () => {
  const { deps } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 internal'); } });
  const handled = await tryResolveRemark(100, 'text', deps);
  assert.strictEqual(handled, false);
});

test('tryResolveRemark: two pending rows for one chat -> resolves the OLDEST first (oldest-first, documented simplification)', async () => {
  const older = { ...AWAITING_ROW, id: 'exp-old', created_at: '2026-07-01T00:00:00Z' };
  let seenOrder = null;
  const { deps, updateCalls } = baseDeps({
    sbSelect: async (table, opts) => { seenOrder = opts.order; return [older]; }, // fake DB already returns oldest-first per the order clause
  });
  await tryResolveRemark(100, 'note', deps);
  assert.match(seenOrder, /created_at\.asc/);
  assert.strictEqual(updateCalls[0].id, 'exp-old');
});

// --- Full handleUpdate integration ---

test('handleUpdate: plain text resolves a pending remark and does NOT fall through to the generic fallback reply', async () => {
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  await handleUpdate({ message: { chat: { id: 100 }, from: { first_name: 'A' }, text: 'client dinner' } }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(sent.length, 1, 'only the remark confirmation is sent, not also the generic fallback');
  assert.match(sent[0].text, /client dinner/);
});

// CRITICAL regression requirement: a chat with nothing pending must be totally unaffected.
test('handleUpdate: CRITICAL — with NO pending remark, /start still works exactly as before', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '/start' } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Receipt Analyser/);
});

test('handleUpdate: CRITICAL — with NO pending remark, "show expenses" still routes to sendExpenseSummary (not the generic fallback, not treated as a remark)', async () => {
  // sendExpenseSummary is not deps-injectable (pre-existing, unrelated to this change) — it
  // calls the REAL sbSelect/tgSend directly, so nothing lands in the deps.tgSend fake here
  // either way. What this test actually proves: the pending-remark check (which IS
  // deps-injected) does not intercept/consume this message — no sbUpdate call, and the
  // deps.tgSend fake sees NOTHING (confirming handleUpdate did not also send its own
  // generic fallback reply on top of routing to sendExpenseSummary).
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: 'show expenses' } }, deps);
  assert.strictEqual(updateCalls.length, 0, 'must not be mistaken for a remark and written to the DB');
  assert.strictEqual(sent.length, 0, 'must not ALSO send the generic fallback via deps.tgSend on top of routing to sendExpenseSummary');
});

test('handleUpdate: CRITICAL — with NO pending remark, delete-intent keywords still route correctly', async () => {
  let hit = false;
  const { deps } = baseDeps({ sbSelect: async () => [], handleDeleteIntent: async () => { hit = true; } });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: 'delete my last one' } }, deps);
  assert.strictEqual(hit, true);
});

test('handleUpdate: CRITICAL — with NO pending remark, an unrecognised message still gets the normal generic fallback', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: 'hello there' } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /great with receipts/i);
});
