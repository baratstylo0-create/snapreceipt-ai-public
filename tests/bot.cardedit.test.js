'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// "✏️ Edit" / "📝 Add Remark" on the "Expense Captured" card (2026-08-23, Barat reference
// mockup): tap Edit -> pick Merchant/Date/Amount/Category (Category reuses the existing,
// already-tested catedit:/catpick: flow) -> type the new value -> the SAME card re-renders
// in place with the update, never a new message. Deliberately a SEPARATE, in-memory-only
// pending-state mechanism (pendingCardEdit) from the DB-status-column-based awaiting_date/
// awaiting_category/awaiting_remark flows (tests/bot.categorypicker.test.js,
// tests/bot.categorypicker.remark.test.js) — those stay untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery, handleUpdate } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const edited = [];
  const answered = [];
  const updateCalls = [];
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgEditMessage: async (chatId, messageId, text, replyMarkup) => { edited.push({ chatId, messageId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbSelectGlobal: async () => [],
    sbUpdate: async (table, where, patch) => { updateCalls.push({ table, where, patch }); },
    getCapabilities: () => ({ multiUser: false }), // personal-mode capture flow
    pendingCardEdit: new Map(), // fresh per test — the real module-level Map is shared/global
    ...resolvedOver,
  };
  return { deps, sent, edited, answered, updateCalls };
}

const SAVED_ROW = { id: 'exp-30', merchant: 'Shell', amount: 50, currency: 'MYR', expense_date: '2026-08-20', category: 'Fuel & Auto', status: 'saved', rep_chat_id: '100', account_id: 'p_migrated-account' };
const withMessageId = (chatId, messageId) => ({ chat: { id: chatId }, message_id: messageId });

// --- editmenu: -------------------------------------------------------------------------

test('editmenu: tapping Edit shows the field-picker submenu, edited in place', async () => {
  const { deps, edited, answered } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cb1', data: 'editmenu:exp-30', message: withMessageId(100, 900) }, deps);
  assert.strictEqual(answered.length, 1);
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].messageId, 900);
  const flat = edited[0].replyMarkup.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'editfield:merchant:exp-30'));
  assert.ok(flat.some((b) => b.callback_data === 'editfield:date:exp-30'));
  assert.ok(flat.some((b) => b.callback_data === 'editfield:amount:exp-30'));
  assert.ok(flat.some((b) => b.callback_data === 'catedit:exp-30'));
  assert.ok(flat.some((b) => b.callback_data === 'editback:exp-30'));
});

test('editmenu: an unknown/deleted row is refused with "already gone"', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleCallbackQuery({ id: 'cb2', data: 'editmenu:nope', message: withMessageId(100, 900) }, deps);
  assert.match(sent[0].text, /already gone/i);
});

test('editmenu: SECURITY — a different chat cannot open the edit menu for someone else\'s receipt', async () => {
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cb3', data: 'editmenu:exp-30', message: withMessageId(999, 900) }, deps);
  assert.match(sent[0].text, /can.?t do that/i);
  assert.strictEqual(updateCalls.length, 0);
});

// --- editback: ---------------------------------------------------------------------------

test('editback: re-renders the untouched card and clears any pending edit state', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'merchant', messageId: 900 }]]);
  const { deps, edited } = baseDeps({ sbSelect: async () => [SAVED_ROW], pendingCardEdit });
  await handleCallbackQuery({ id: 'cb4', data: 'editback:exp-30', message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /Expense Captured/);
  assert.match(edited[0].text, /Shell/);
  assert.strictEqual(pendingCardEdit.has('100'), false, 'a stale pending edit must not survive a Back tap');
});

// --- editfield: ----------------------------------------------------------------------------

test('editfield: Merchant tap prompts for a typed reply and remembers the pending state', async () => {
  const pendingCardEdit = new Map();
  const { deps, edited } = baseDeps({ sbSelect: async () => [SAVED_ROW], pendingCardEdit });
  await handleCallbackQuery({ id: 'cb5', data: 'editfield:merchant:exp-30', message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /merchant name/i);
  assert.deepStrictEqual(pendingCardEdit.get('100'), { expenseId: 'exp-30', field: 'merchant', messageId: 900 });
});

test('editfield: Date tap prompts in DD/MM/YYYY format', async () => {
  const { deps, edited } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cb6', data: 'editfield:date:exp-30', message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /DD\/MM\/YYYY/);
});

test('editfield: Amount tap prompts for numbers only', async () => {
  const { deps, edited } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cb7', data: 'editfield:amount:exp-30', message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /amount/i);
});

test('editfield: SECURITY — a different chat cannot edit someone else\'s receipt, no pending state set', async () => {
  const pendingCardEdit = new Map();
  const { deps, sent } = baseDeps({ sbSelect: async () => [SAVED_ROW], pendingCardEdit });
  await handleCallbackQuery({ id: 'cb8', data: 'editfield:merchant:exp-30', message: withMessageId(999, 900) }, deps);
  assert.match(sent[0].text, /can.?t do that/i);
  assert.strictEqual(pendingCardEdit.size, 0);
});

// --- addremark: ----------------------------------------------------------------------------

test('addremark: prompts for a typed remark on ANY receipt, not just category=Others', async () => {
  const pendingCardEdit = new Map();
  const { deps, edited } = baseDeps({ sbSelect: async () => [SAVED_ROW], pendingCardEdit });
  await handleCallbackQuery({ id: 'cb9', data: 'addremark:exp-30', message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /remark/i);
  assert.deepStrictEqual(pendingCardEdit.get('100'), { expenseId: 'exp-30', field: 'remark', messageId: 900 });
});

// --- tryResolveCardEdit (via handleUpdate's text routing) ----------------------------------

function msgUpdate(chatId, text) {
  return { message: { chat: { id: chatId }, from: { first_name: 'A' }, text } };
}

test('tryResolveCardEdit: nothing pending -> falls through, normal routing continues', async () => {
  const pendingCardEdit = new Map();
  const { deps, sent } = baseDeps({ pendingCardEdit });
  await handleUpdate(msgUpdate(100, 'Starbucks'), deps);
  // No pending edit -> fell through to the generic "didn't understand" / photo-prompt path,
  // NOT treated as a card-edit reply. We only assert it didn't crash and didn't touch DB.
  assert.strictEqual(deps.pendingCardEdit.size, 0);
});

// NOTE: sbSelect stays [] and sbSelectGlobal carries SAVED_ROW in every test below — the
// OLD DB-status-based resolvers (tryResolveDate/tryResolveRemark), checked EARLIER in
// handleUpdate's routing chain, still read via plain sbSelect; if it returned a matching
// row too, THEY would consume the message first (their own update call sets status:'saved'
// on every write, which is exactly the kind of cross-talk that would silently make these
// tests exercise the wrong resolver). Keeping sbSelect empty forces those to correctly find
// nothing and fall through, so tryResolveCardEdit (sbSelectGlobal-based) is what actually runs.

test('tryResolveCardEdit: a valid merchant reply updates the row and re-renders the card in place', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'merchant', messageId: 900 }]]);
  const { deps, edited, updateCalls } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, 'Shell Segamat'), deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].where.id, 'exp-30');
  assert.deepStrictEqual(updateCalls[0].where.scope, { account_id: 'p_migrated-account' });
  assert.deepStrictEqual(updateCalls[0].patch, { merchant: 'Shell Segamat' });
  assert.strictEqual(edited[0].messageId, 900);
  assert.match(edited[0].text, /Shell Segamat/);
  assert.strictEqual(pendingCardEdit.has('100'), false, 'consumed');
});

test('tryResolveCardEdit: a valid date reply (DD/MM/YYYY) updates expense_date', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'date', messageId: 900 }]]);
  const { deps, updateCalls, edited } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, '15/07/2026'), deps);
  assert.deepStrictEqual(updateCalls[0].patch, { expense_date: '2026-07-15' });
  assert.match(edited[0].text, /2026-07-15/);
});

test('tryResolveCardEdit: an unparseable date is refused, pending state kept', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'date', messageId: 900 }]]);
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, 'not a date'), deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /doesn.?t look like a date/i);
  assert.strictEqual(pendingCardEdit.has('100'), true);
});

test('tryResolveCardEdit: a valid amount reply updates amount, rounded to 2dp', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'amount', messageId: 900 }]]);
  const { deps, updateCalls, edited } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, '12.5'), deps);
  assert.deepStrictEqual(updateCalls[0].patch, { amount: 12.5 });
  assert.match(edited[0].text, /RM12\.50/);
});

test('tryResolveCardEdit: a comma-formatted amount ("1,234.50") is accepted', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'amount', messageId: 900 }]]);
  const { deps, updateCalls } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, '1,234.50'), deps);
  assert.deepStrictEqual(updateCalls[0].patch, { amount: 1234.5 });
});

test('tryResolveCardEdit: a non-numeric or non-positive amount is refused, pending state kept', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'amount', messageId: 900 }]]);
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, '-5'), deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /doesn.?t look like an amount/i);
  assert.strictEqual(pendingCardEdit.has('100'), true);
});

test('tryResolveCardEdit: a valid remark reply sets the remark and it appears on the re-rendered card', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'remark', messageId: 900 }]]);
  const { deps, updateCalls, edited } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [SAVED_ROW], pendingCardEdit });
  await handleUpdate(msgUpdate(100, 'client lunch'), deps);
  assert.deepStrictEqual(updateCalls[0].patch, { remark: 'client lunch' });
  assert.match(edited[0].text, /Remark:\* client lunch/);
});

test('tryResolveCardEdit: the row vanishing mid-flow (deleted) is handled gracefully, pending cleared', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'merchant', messageId: 900 }]]);
  const { deps, sent, updateCalls } = baseDeps({ sbSelect: async () => [], sbSelectGlobal: async () => [], pendingCardEdit }); // row gone
  await handleUpdate(msgUpdate(100, 'Shell Segamat'), deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /already gone/i);
  assert.strictEqual(pendingCardEdit.has('100'), false);
});

test('tryResolveCardEdit: a lookup error never throws, falls through gracefully', async () => {
  const pendingCardEdit = new Map([['100', { expenseId: 'exp-30', field: 'merchant', messageId: 900 }]]);
  const { deps } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED'); }, pendingCardEdit });
  await assert.doesNotReject(handleUpdate(msgUpdate(100, 'Shell Segamat'), deps));
});
