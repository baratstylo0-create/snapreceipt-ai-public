'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Completes the "I couldn't read the date clearly" flow (issue #149 part 2, Owner
// directive: "if the bot can't see something clearly it should say so, not guess").
// After lib/ocr.js's expenseFromPhoto detects an unparseable date, the row is
// status='awaiting_date'. The NEXT plain-text message from that chat is treated as the
// date reply. Same critical regression requirement as the remark flow (per the Owner):
// a chat with NO pending date-ask must be completely unaffected.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleUpdate, tryResolveDate } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const updateCalls = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    sbSelect: async () => [],
    sbUpdate: async (table, { id }, patch) => { updateCalls.push({ table, id, patch }); },
    ...over,
  };
  return { deps, sent, updateCalls };
}

const AWAITING_ROW = { id: 'exp-9', merchant: "Baker's Cottage", amount: 18.90, currency: 'MYR', status: 'awaiting_date', rep_chat_id: '100', created_at: '2026-07-08T00:00:00Z' };

test('tryResolveDate: a pending row + a parseable reply -> expense_date updated, status saved, returns true', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  const handled = await tryResolveDate(100, '30/06/2026', deps);
  assert.strictEqual(handled, true);
  assert.strictEqual(updateCalls.length, 1);
  assert.deepStrictEqual(updateCalls[0].patch, { expense_date: '2026-06-30', status: 'saved' });
  assert.match(sent[0].text, /2026-06-30/);
  assert.match(sent[0].text, /Baker's Cottage/);
});

test('tryResolveDate: tolerates a trailing time in the reply too (same parseDateLoose as OCR)', async () => {
  const { deps, updateCalls } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  await tryResolveDate(100, '30/06/2026 12:46:53', deps);
  assert.strictEqual(updateCalls[0].patch.expense_date, '2026-06-30');
});

test('tryResolveDate: an unparseable reply re-asks (still consumed=true, no DB update)', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  const handled = await tryResolveDate(100, 'idk sometime last week', deps);
  assert.strictEqual(handled, true, 'still consumed — must not fall through to generic routing');
  assert.strictEqual(updateCalls.length, 0, 'no DB write on an unparseable reply');
  assert.match(sent[0].text, /DD\/MM\/YYYY/);
});

test('tryResolveDate: no pending row for this chat -> returns false, nothing updated, nothing sent', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [] });
  const handled = await tryResolveDate(100, '30/06/2026', deps);
  assert.strictEqual(handled, false);
  assert.strictEqual(updateCalls.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('tryResolveDate: a lookup/update failure never throws, returns false so the caller falls through', async () => {
  const { deps } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 internal'); } });
  const handled = await tryResolveDate(100, '30/06/2026', deps);
  assert.strictEqual(handled, false);
});

test('tryResolveDate: two pending rows for one chat -> resolves the OLDEST first (same simplification as tryResolveRemark)', async () => {
  const older = { ...AWAITING_ROW, id: 'exp-old', created_at: '2026-07-01T00:00:00Z' };
  let seenOrder = null;
  const { deps, updateCalls } = baseDeps({
    sbSelect: async (table, opts) => { seenOrder = opts.order; return [older]; },
  });
  await tryResolveDate(100, '01/07/2026', deps);
  assert.match(seenOrder, /created_at\.asc/);
  assert.strictEqual(updateCalls[0].id, 'exp-old');
});

// --- Full handleUpdate integration ---

test('handleUpdate: plain text resolves a pending date-ask and does NOT fall through to the generic fallback reply', async () => {
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [AWAITING_ROW] });
  await handleUpdate({ message: { chat: { id: 100 }, from: { first_name: 'A' }, text: '30/06/2026' } }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(sent.length, 1, 'only the date-updated confirmation is sent, not also the generic fallback');
  assert.match(sent[0].text, /2026-06-30/);
});

// CRITICAL regression requirement: a chat with nothing pending must be totally unaffected.
test('handleUpdate: CRITICAL — with NO pending date-ask, /start still works exactly as before', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '/start' } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Receipt Analyser/);
});

test('handleUpdate: CRITICAL — with NO pending date-ask, an unrecognised message still gets the normal generic fallback', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: 'hello there' } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /great with receipts/i);
});
