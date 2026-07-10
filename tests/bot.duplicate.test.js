'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Issue #162 D13: "uploading a receipt already in the system saves it again." The bot now
// rejects an exact duplicate outright (lib/ocr.js assembleExpense's rejectDuplicates) and
// replies with View/Edit buttons pointing at the EXISTING receipt (dupview:/dupedit:/
// dupstaff:, mirroring the ownership-check pattern used throughout handleCallbackQuery).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery, sendStaffPicker } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const updates = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
    ...over,
  };
  return { deps, sent, answered, updates };
}

const EXISTING = { id: 'exp-existing-1', merchant: 'Kedai Makmur', amount: 12, currency: 'MYR', expense_date: '2026-07-05', category: 'Groceries', rep_chat_id: '100', branch_id: 'br-A' };

// --- dupview: -------------------------------------------------------------------------

test('dupview: an owned existing receipt -> shows its details, read-only', async () => {
  const { deps, sent, answered } = baseDeps({ sbSelect: async () => [EXISTING] });
  await handleCallbackQuery({ id: 'cb1', data: 'dupview:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Kedai Makmur/);
  assert.match(sent[0].text, /Groceries/);
  assert.strictEqual(answered[0].id, 'cb1');
});

test('dupview: a different chat\'s receipt is refused (not yours)', async () => {
  const { deps, sent, answered } = baseDeps({ sbSelect: async () => [EXISTING] });
  await handleCallbackQuery({ id: 'cb2', data: 'dupview:exp-existing-1', message: { chat: { id: 999 } } }, deps);
  assert.match(sent[0].text, /Can't view/);
  assert.strictEqual(answered[0].opts.text, 'Not yours');
});

test('dupview: an already-deleted receipt says so', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [{ ...EXISTING, deleted_at: '2026-07-06T00:00:00Z' }] });
  await handleCallbackQuery({ id: 'cb3', data: 'dupview:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  assert.match(sent[0].text, /already gone/);
});

// --- dupedit: -------------------------------------------------------------------------

test('dupedit: an owned existing receipt -> a menu with Edit staff + Delete (delask: reused)', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [EXISTING] });
  await handleCallbackQuery({ id: 'cb4', data: 'dupedit:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(sent.length, 1);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.callback_data), ['dupstaff:exp-existing-1', 'delask:exp-existing-1']);
});

test('dupedit: not yours is refused', async () => {
  const { deps, sent, answered } = baseDeps({ sbSelect: async () => [EXISTING] });
  await handleCallbackQuery({ id: 'cb5', data: 'dupedit:exp-existing-1', message: { chat: { id: 999 } } }, deps);
  assert.match(sent[0].text, /Can't edit/);
  assert.strictEqual(answered[0].opts.text, 'Not yours');
});

// --- dupstaff: --------------------------------------------------------------------------

test('dupstaff: reopens the SAME staff picker (sendStaffPicker) keyed to the existing receipt\'s own branch', async () => {
  const pickerCalls = [];
  const { deps } = baseDeps({
    sbSelect: async () => [EXISTING],
    sendStaffPicker: async (chatId, expense, branchId) => { pickerCalls.push({ chatId, expense, branchId }); },
  });
  await handleCallbackQuery({ id: 'cb6', data: 'dupstaff:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(pickerCalls.length, 1);
  assert.strictEqual(pickerCalls[0].chatId, 100);
  assert.strictEqual(pickerCalls[0].branchId, 'br-A');
  assert.strictEqual(pickerCalls[0].expense.id, 'exp-existing-1');
});

test('dupstaff: an existing receipt with no branch_id (e.g. old/personal row) declines gracefully, no crash', async () => {
  const pickerCalls = [];
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ ...EXISTING, branch_id: null }],
    sendStaffPicker: async (...a) => { pickerCalls.push(a); },
  });
  await handleCallbackQuery({ id: 'cb7', data: 'dupstaff:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(pickerCalls.length, 0);
  assert.match(sent[0].text, /No branch/i);
});

test('dupstaff: not yours is refused, picker never opened', async () => {
  const pickerCalls = [];
  const { deps } = baseDeps({
    sbSelect: async () => [EXISTING],
    sendStaffPicker: async (...a) => { pickerCalls.push(a); },
  });
  await handleCallbackQuery({ id: 'cb8', data: 'dupstaff:exp-existing-1', message: { chat: { id: 999 } } }, deps);
  assert.strictEqual(pickerCalls.length, 0);
});

// Real sendStaffPicker (not stubbed) still works end-to-end when reached via dupstaff:.
test('dupstaff: real sendStaffPicker actually sends the picker for the existing receipt', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [EXISTING],
    listStaff: async (branchId) => { assert.strictEqual(branchId, 'br-A'); return [{ id: 's-ali', display_name: 'Ali' }]; },
  });
  deps.sendStaffPicker = (chatId, expense, branchId, d) => sendStaffPicker(chatId, expense, branchId, d);
  await handleCallbackQuery({ id: 'cb9', data: 'dupstaff:exp-existing-1', message: { chat: { id: 100 } } }, deps);
  const pickerMsg = sent.find(s => /Who is this receipt for/.test(s.text));
  assert.ok(pickerMsg, 'the real staff picker must have been sent');
});
