'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Category-picker button flow (Owner request 2026-07-03): a receipt whose category is
// uncertain is saved with status='awaiting_category' and a keyboard is sent. Tapping a
// real category resolves it immediately; tapping "Others" instead asks for a typed note
// (resolved separately, by handleUpdate's pending-remark check — see
// tests/bot.categorypicker.remark.test.js). Mirrors handleDeleteIntent/handleCallbackQuery's
// re-lookup-at-confirm-time authorization pattern (tests/bot.delete.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery } = require('../lib/bot');
const { CATEGORIES } = require('../lib/categorize');

function baseDeps(over = {}) {
  const sent = [];
  const edited = [];
  const answered = [];
  const updateCalls = [];
  // sbSelectGlobal (2026-08-23): handleCallbackQuery's expense-by-id lookups now go through
  // sbSelectGlobal, not sbSelect (see lib/bot.js's handleCallbackQuery doc comment / lib/
  // supabase.js's sbSelectGlobal doc comment). Mirroring whatever `sbSelect` override a test
  // passes keeps every existing "row found"/"row not found" scenario working without touching
  // each call site individually.
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgEditMessage: async (chatId, messageId, text, replyMarkup) => { edited.push({ chatId, messageId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbSelect: async () => [],
    sbSelectGlobal: async () => [],
    sbUpdate: async (table, { id }, patch) => { updateCalls.push({ table, id, patch }); },
    // Hermetic: the catpick/catedit handlers read the account's category list via
    // getFieldSpec (ADR-021). Inject a no-categories spec so the picker uses the
    // built-in default (CATEGORIES) and no real Supabase call is attempted.
    getFieldSpec: async () => ({ columns: [] }),
    pendingRemarkMessages: new Map(), // fresh per test — the real module-level Map is shared/global
    ...resolvedOver,
  };
  return { deps, sent, edited, answered, updateCalls };
}

const PENDING_ROW = { id: 'exp-9', merchant: 'Bonda KL', amount: 183.65, currency: 'MYR', status: 'awaiting_category', rep_chat_id: '100' };
// Every real Telegram button-tap update carries the ORIGINAL message (message_id) — tests
// that want to exercise the new edit-in-place path use this instead of a bare `{chat:{id}}`.
const withMessageId = (chatId, messageId) => ({ chat: { id: chatId }, message_id: messageId });

test('tapping a real category: row updated to that category + status saved, confirmation sent', async () => {
  const idx = CATEGORIES.indexOf('Groceries');
  const { deps, sent, answered, updateCalls } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cb1', data: 'catpick:exp-9:' + idx, message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].id, 'exp-9');
  assert.deepStrictEqual(updateCalls[0].patch, { category: 'Groceries', status: 'saved' });
  assert.strictEqual(answered.length, 1);
  assert.match(sent[0].text, /Groceries/);
  assert.match(sent[0].text, /Bonda KL/);
});

// Regression test (2026-08-23, live QA report): a migrated personal account's OWN receipt
// (account_id != the deployment's shared cfg.ACCOUNT_ID default) used to come back "already
// gone" the instant its category was tapped — the lookup was sbSelect (scoped to the shared
// default), not sbSelectGlobal, so a receipt captured seconds earlier under the user's own
// unique account_id was invisible to it. Confirmed live against a real production account.
test('REGRESSION: a receipt under a migrated personal account\'s OWN unique account_id is found correctly (not "already gone")', async () => {
  const MIGRATED_ROW = { ...PENDING_ROW, account_id: 'p_11111111-2222-3333-4444-555555555555' };
  const idx = CATEGORIES.indexOf('Groceries');
  const seenGlobalCalls = [];
  const { deps, sent, answered, updateCalls } = baseDeps({
    // sbSelect deliberately returns NOTHING — proves the handler is not relying on it for
    // this lookup (the pre-fix behavior would have found nothing here and shown "already gone").
    sbSelect: async () => [],
    sbSelectGlobal: async (table, opts) => { seenGlobalCalls.push({ table, opts }); return [MIGRATED_ROW]; },
  });
  await handleCallbackQuery({ id: 'cb-regress', data: 'catpick:exp-9:' + idx, message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(seenGlobalCalls.length, 1, 'the id-keyed lookup must go through sbSelectGlobal');
  assert.strictEqual(answered.length, 1);
  assert.ok(!sent.some((s) => /already gone/i.test(s.text)), 'must never say "already gone" for a receipt that genuinely exists');
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].id, 'exp-9');
  assert.deepStrictEqual(updateCalls[0].patch, { category: 'Groceries', status: 'saved' });
  assert.match(sent[0].text, /Groceries/);
});

test('tapping "Others": row moves to awaiting_remark with category=Others, NOT status=saved yet', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cb2', data: 'catpick:exp-9:others', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.deepStrictEqual(updateCalls[0].patch, { category: 'Others', status: 'awaiting_remark' });
  assert.match(sent[0].text, /type a short note/i);
});

test('SECURITY: a catpick callback from a DIFFERENT chat than the row owner is refused, no update', async () => {
  const { deps, updateCalls, sent, answered } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cb3', data: 'catpick:exp-9:0', message: { chat: { id: 999 } } }, deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /can't do that/i);
  assert.strictEqual(answered[0].opts.text, 'Not yours');
});

test('a row that is NOT (or no longer) awaiting_category is refused (already resolved / wrong feature state)', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [{ ...PENDING_ROW, status: 'saved' }] });
  await handleCallbackQuery({ id: 'cb4', data: 'catpick:exp-9:0', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /already resolved/i);
});

test('double-tap protection: a SECOND tap on an already-resolved pick does nothing (idempotent, no double-apply)', async () => {
  // Simulates the row already having moved to status:'saved' after the first tap.
  const { deps, updateCalls } = baseDeps({ sbSelect: async () => [{ ...PENDING_ROW, status: 'saved', category: 'Groceries' }] });
  await handleCallbackQuery({ id: 'cb5', data: 'catpick:exp-9:5', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 0, 'a stale/duplicate tap must never re-apply a category change');
});

test('a deleted row is refused with "already gone", no update', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [{ ...PENDING_ROW, deleted_at: '2026-07-03T00:00:00Z' }] });
  await handleCallbackQuery({ id: 'cb6', data: 'catpick:exp-9:0', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /already gone/i);
});

test('an unknown/vanished row id is refused gracefully, no crash', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [] });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb7', data: 'catpick:ghost-id:0', message: { chat: { id: 100 } } }, deps));
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /already gone/i);
});

test('an out-of-range or garbage index is rejected safely, no crash, no update', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cb8', data: 'catpick:exp-9:9999', message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /isn't valid/i);

  const { deps: d2, updateCalls: u2 } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb9', data: 'catpick:exp-9:not-a-number', message: { chat: { id: 100 } } }, d2));
  assert.strictEqual(u2.length, 0);
});

test('a select/update failure never throws, always acks, never leaks internals', async () => {
  const { deps, sent, answered } = baseDeps({
    sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 supabase-internal'); },
  });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cb10', data: 'catpick:exp-9:0', message: { chat: { id: 100 } } }, deps));
  assert.strictEqual(answered.length, 1);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(sent[0].text), 'raw error must never leak');
});

test('a catpick callback never matches the del: branch and vice versa (cross-feature isolation)', async () => {
  const { deps: d1, updateCalls } = baseDeps({ sbSelect: async () => [PENDING_ROW], sbSoftDelete: async () => { throw new Error('should not be called'); } });
  await handleCallbackQuery({ id: 'x1', data: 'catpick:exp-9:0', message: { chat: { id: 100 } } }, d1);
  assert.strictEqual(updateCalls.length, 1, 'catpick: was handled by the catpick branch');

  const { deps: d2, sent } = baseDeps({ sbSelect: async () => [{ id: 'exp-1', rep_chat_id: '100' }] });
  await handleCallbackQuery({ id: 'x2', data: 'del:exp-1', message: { chat: { id: 100 } } }, d2);
  assert.ok(!sent[0].text.includes('category'), 'del: was handled by the delete branch, not catpick');
});

// --- Edit-in-place (Owner request 2026-07-04): when the tapped update carries the
// original message_id (as every real Telegram button tap does), the prompt is EDITED
// into its final state — buttons cleared, text becomes the confirmation — instead of
// sending a brand-new message, so the chat doesn't accumulate stale button messages. ---

test('tapping a real category WITH a message_id: the ORIGINAL message is edited, no new message sent', async () => {
  const idx = CATEGORIES.indexOf('Groceries');
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cbE1', data: 'catpick:exp-9:' + idx, message: withMessageId(100, 555) }, deps);
  assert.strictEqual(sent.length, 0, 'no new message — the original is edited instead');
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].chatId, 100);
  assert.strictEqual(edited[0].messageId, 555);
  assert.match(edited[0].text, /Groceries/);
});

test('tapping "Others" WITH a message_id: the prompt is edited in place AND remembered for later', async () => {
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cbE2', data: 'catpick:exp-9:others', message: withMessageId(100, 556) }, deps);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].messageId, 556);
  assert.match(edited[0].text, /type a short note/i);
  assert.deepStrictEqual(deps.pendingRemarkMessages.get('exp-9'), { chatId: 100, messageId: 556 });
});

test('a catpick callback with NO message_id (defensive fallback) still sends a normal new message, no crash', async () => {
  const idx = CATEGORIES.indexOf('Groceries');
  const { deps, sent, edited } = baseDeps({ sbSelect: async () => [PENDING_ROW] });
  await handleCallbackQuery({ id: 'cbE3', data: 'catpick:exp-9:' + idx, message: { chat: { id: 100 } } }, deps);
  assert.strictEqual(edited.length, 0);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Groceries/);
});

// --- "✏️ Edit category" on an already-saved receipt (Owner request 2026-07-04) ---
const SAVED_ROW = { id: 'exp-20', merchant: 'Segamat', amount: 18, currency: 'MYR', status: 'saved', category: 'Fuel & Auto', rep_chat_id: '100' };

test('catedit: tapping Edit on an already-saved row resets it to awaiting_category and edits the message to show the picker (with buttons, not cleared)', async () => {
  const { deps, edited, sent, updateCalls } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cbEdit1', data: 'catedit:exp-20', message: withMessageId(100, 900) }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.deepStrictEqual(updateCalls[0].patch, { status: 'awaiting_category' });
  assert.strictEqual(sent.length, 0, 'edited in place, no new message');
  assert.strictEqual(edited.length, 1);
  assert.strictEqual(edited[0].messageId, 900);
  assert.match(edited[0].text, /Segamat/);
});

test('catedit: SECURITY — a different chat cannot edit someone else\'s receipt', async () => {
  const { deps, updateCalls, sent } = baseDeps({ sbSelect: async () => [SAVED_ROW] });
  await handleCallbackQuery({ id: 'cbEdit2', data: 'catedit:exp-20', message: withMessageId(999, 901) }, deps);
  assert.strictEqual(updateCalls.length, 0);
  assert.match(sent[0].text, /can't do that/i);
});

test('catedit: a deleted row is refused gracefully, no crash', async () => {
  const { deps, updateCalls } = baseDeps({ sbSelect: async () => [{ ...SAVED_ROW, deleted_at: '2026-07-04T00:00:00Z' }] });
  await handleCallbackQuery({ id: 'cbEdit3', data: 'catedit:exp-20', message: withMessageId(100, 902) }, deps);
  assert.strictEqual(updateCalls.length, 0);
});

// 2026-08-23 (Barat reference mockup): a category pick — re-pick via "✏️ Edit" -> Category,
// or a fresh uncertain-receipt resolution — now re-renders the FULL "Expense Captured" card
// (captureCardText/captureCardKeyboard) instead of a terse "Saved as X (updated)" line, so
// there's no separate "(updated)" wording to distinguish anymore — both paths look the same,
// matching every other card-edit path's "the card re-renders in place" behavior.
test('catedit -> catpick round trip: re-picking a category renders the full card with the NEW category', async () => {
  // Simulates the two-step flow: catedit resets status, THEN a category tap resolves it.
  const idx = CATEGORIES.indexOf('Groceries');
  const rowAfterEdit = { ...SAVED_ROW, status: 'awaiting_category' }; // category still 'Fuel & Auto'
  const { deps, edited } = baseDeps({ sbSelect: async () => [rowAfterEdit] });
  await handleCallbackQuery({ id: 'cbEdit4', data: 'catpick:exp-20:' + idx, message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /Expense Captured/);
  assert.match(edited[0].text, /Groceries/);
  assert.deepStrictEqual(edited[0].replyMarkup, { inline_keyboard: [[
    { text: '✏️ Edit', callback_data: 'editmenu:exp-20' },
    { text: '📝 Add Remark', callback_data: 'addremark:exp-20' },
  ]] });
});

test('a fresh (never-before-categorized) receipt also renders the full card on its first pick', async () => {
  const idx = CATEGORIES.indexOf('Groceries');
  const { deps, edited } = baseDeps({ sbSelect: async () => [PENDING_ROW] }); // category is PENDING_CATEGORY, not a real one
  await handleCallbackQuery({ id: 'cbEdit5', data: 'catpick:exp-9:' + idx, message: withMessageId(100, 900) }, deps);
  assert.match(edited[0].text, /Expense Captured/);
  assert.match(edited[0].text, /Groceries/);
});

// --- business category set drives the picker (ADR-021 Phase 5) --------------------------

// A company's own chart of accounts, e.g. a construction firm.
const BIZ_SPEC = { columns: [], categories: ['Petrol/Diesel', 'Touch-n-Go', 'Entertainment', 'Others'] };

test('catpick: the tapped index resolves against the BUSINESS category list, not the built-in default', async () => {
  // idx 1 in the business list is 'Touch-n-Go' — a category that does NOT exist in the
  // built-in CATEGORIES, proving the resolver read FieldSpec.categories.
  const { deps, updateCalls } = baseDeps({
    sbSelect: async () => [PENDING_ROW],
    getFieldSpec: async () => BIZ_SPEC,
  });
  await handleCallbackQuery({ id: 'cbBiz1', data: 'catpick:exp-9:1', message: withMessageId(100, 700) }, deps);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].patch.category, 'Touch-n-Go');
});

test('catedit: the rebuilt picker offers the BUSINESS categories, not the default 18', async () => {
  const rowAfterEdit = { ...PENDING_ROW, category: 'Petrol/Diesel', status: 'saved' };
  const { deps, edited } = baseDeps({
    sbSelect: async () => [rowAfterEdit],
    getFieldSpec: async () => BIZ_SPEC,
  });
  await handleCallbackQuery({ id: 'cbBiz2', data: 'catedit:exp-9', message: withMessageId(100, 701) }, deps);
  const buttons = edited[0].replyMarkup.inline_keyboard.flat().map(b => b.text);
  assert.ok(buttons.includes('Touch-n-Go'), 'business category present: ' + buttons.join(','));
  assert.ok(!buttons.includes('Software & Subscriptions'), 'a default-only category must be absent');
});

test('catpick: a getFieldSpec failure degrades to the built-in default list (never a crash)', async () => {
  const idx = CATEGORIES.indexOf('Groceries');
  const { deps, updateCalls } = baseDeps({
    sbSelect: async () => [PENDING_ROW],
    getFieldSpec: async () => { throw new Error('db down'); },
  });
  await assert.doesNotReject(() => handleCallbackQuery({ id: 'cbBiz3', data: 'catpick:exp-9:' + idx, message: withMessageId(100, 702) }, deps));
  assert.strictEqual(updateCalls[0].patch.category, 'Groceries');
});
