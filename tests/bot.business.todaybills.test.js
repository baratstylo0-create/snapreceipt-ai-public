'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Business "Today's Bills" upgrades (M2 #107, business mode ONLY):
//   (1) each bill line shows the STAFF member (staff_user_id -> display_name) instead of
//       the category;
//   (2) the per-bill ❌ buttons are replaced by ONE "🗑️ Delete a bill" button that asks
//       the user to type the bill number; typing it deletes that receipt.
// Personal mode (binding null) must stay byte-for-byte unchanged: category per line +
// per-bill ❌ (delask:) buttons. Deletion stays scoped to the ORIGINAL submitter.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleTodayBills, handleCallbackQuery, tryResolveBillDelete,
} = require('../lib/bot');

// sbSelect dispatches on table: 'expenses' -> the bills, 'users' -> the staff directory,
// and an { eq: { id } } lookup -> the single row (used by the delete resolver).
function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const deleted = [];
  // sbSelectGlobal (2026-08-23): tryResolveBillDelete's { eq: { id } } lookup now goes
  // through sbSelectGlobal, not sbSelect (see lib/bot.js's doc comment); handleTodayBills'
  // own account-wide query still uses sbSelect via branchEq(binding), unaffected. Mirroring
  // whatever `sbSelect` override a test passes keeps every existing dispatch scenario working.
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  return {
    deps: {
      tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
      tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
      sbSoftDelete: async (table, where) => { deleted.push({ table, where }); },
      sbSelect: async () => [],
      sbSelectGlobal: async () => [],
      pendingBillDelete: new Map(),
      // fixed clock so the header date is deterministic
      todayISO: () => '2026-07-08',
      dayBounds: () => ({ startUTC: '2026-07-07T16:00:00.000Z', endUTC: '2026-07-08T16:00:00.000Z' }),
      ...resolvedOver,
    },
    sent, answered, deleted,
  };
}

const CLERK = { role: 'clerk', branch_id: 'br-1', account_id: 'default' };

const BILLS = [
  { id: 'e1', merchant: 'Taco Bell', amount: 291.58, currency: 'MYR', category: 'Food',      staff_user_id: 's-ali', rep_chat_id: '900' },
  { id: 'e2', merchant: 'Shell',     amount: 80.00,  currency: 'MYR', category: 'Transport', staff_user_id: 's-mei', rep_chat_id: '900' },
  { id: 'e3', merchant: 'Grab',      amount: 15.50,  currency: 'MYR', category: 'Transport', staff_user_id: null,    rep_chat_id: '901' },
];
const USERS = [
  { id: 's-ali', display_name: 'Ali' },
  { id: 's-mei', display_name: 'Mei' },
];

function billsDispatch(bills = BILLS, users = USERS) {
  return async (table) => (table === 'users' ? users : bills);
}

// --- rendering: staff name + single Delete button (business mode) ------------------

test('business Today Bills: each line shows the STAFF name, not the category', async () => {
  const { deps, sent } = baseDeps({ sbSelect: billsDispatch() });
  await handleTodayBills('900', deps, CLERK);
  const body = sent[0].text;
  assert.match(body, /1\. \*Taco Bell\* .*\(Ali\)/);
  assert.match(body, /2\. \*Shell\* .*\(Mei\)/);
  assert.doesNotMatch(body, /Food|Transport/); // category must NOT appear on business lines
});

test('business Today Bills: a bill with no staff tag shows (Unassigned)', async () => {
  const { deps, sent } = baseDeps({ sbSelect: billsDispatch() });
  await handleTodayBills('900', deps, CLERK);
  assert.match(sent[0].text, /3\. \*Grab\* .*\(Unassigned\)/);
});

test('business Today Bills: renders ONE 🗑️ Delete a bill button (delnum:ask), not per-bill ❌', async () => {
  const { deps, sent } = baseDeps({ sbSelect: billsDispatch() });
  await handleTodayBills('900', deps, CLERK);
  const kb = sent[0].replyMarkup.inline_keyboard;
  assert.strictEqual(kb.length, 1);
  assert.strictEqual(kb[0].length, 1);
  assert.strictEqual(kb[0][0].callback_data, 'delnum:ask');
  assert.match(kb[0][0].text, /Delete a bill/);
});

test('business Today Bills: pins the ordered bill ids for this chat (display order)', async () => {
  const pendingBillDelete = new Map();
  const { deps } = baseDeps({ sbSelect: billsDispatch(), pendingBillDelete });
  await handleTodayBills('900', deps, CLERK);
  assert.deepStrictEqual(pendingBillDelete.get('900').ids, ['e1', 'e2', 'e3']);
  assert.strictEqual(pendingBillDelete.get('900').armed, false); // not armed until Delete is tapped
});

// --- personal mode is unchanged (regression guard) --------------------------------

test('personal Today Bills (no binding): category per line + per-bill ❌ delask buttons, no pin', async () => {
  const pendingBillDelete = new Map();
  const { deps, sent } = baseDeps({ sbSelect: billsDispatch(), pendingBillDelete });
  await handleTodayBills('900', deps, null);
  assert.match(sent[0].text, /1\. \*Taco Bell\* .*\(Food\)/);        // category, not staff
  const kb = sent[0].replyMarkup.inline_keyboard;
  assert.strictEqual(kb.flat().length, 3);                           // one button per bill
  assert.strictEqual(kb.flat()[0].callback_data, 'delask:e1');
  assert.strictEqual(pendingBillDelete.size, 0);                     // personal mode never pins
});

// --- the "🗑️ Delete a bill" tap arms the chat ------------------------------------

test('delnum:ask tap arms the chat and asks for a number', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: false }]]);
  const { deps, sent, answered } = baseDeps({ pendingBillDelete });
  await handleCallbackQuery({ id: 'cq1', data: 'delnum:ask', message: { chat: { id: '900' }, message_id: 5 } }, deps);
  assert.strictEqual(pendingBillDelete.get('900').armed, true);
  assert.match(sent[0].text, /Reply with its \*number\* \(1–3\)/);
  assert.strictEqual(answered.length, 1);
});

test('delnum:ask tap with no pinned list tells the user the list expired', async () => {
  const { deps, sent } = baseDeps({ pendingBillDelete: new Map() });
  await handleCallbackQuery({ id: 'cq1', data: 'delnum:ask', message: { chat: { id: '900' }, message_id: 5 } }, deps);
  assert.match(sent[0].text, /expired/i);
});

// --- typing the number: tryResolveBillDelete --------------------------------------

test('typing a valid number deletes the RIGHT bill (own submission) and confirms', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, sent, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  const handled = await tryResolveBillDelete('900', '2', deps);
  assert.strictEqual(handled, true);
  // scope: { account_id: row.account_id } (2026-08-23) — see lib/bot.js's doc comment on
  // handleCallbackQuery's selectGlobal fix; BILLS fixtures here carry no account_id, so it's
  // undefined, which is the correct/expected shape for this test's fixture data.
  assert.deepStrictEqual(deleted, [{ table: 'expenses', where: { id: 'e2', scope: { account_id: undefined } } }]);
  assert.match(sent[0].text, /Bill deleted/);
  assert.match(sent[0].text, /Shell/);
  assert.strictEqual(pendingBillDelete.get('900').armed, false); // disarmed after a delete
});

test('typing a number when NOT armed is ignored (returns false, deletes nothing)', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1'], armed: false }]]);
  const { deps, sent, deleted } = baseDeps({ pendingBillDelete });
  const handled = await tryResolveBillDelete('900', '1', deps);
  assert.strictEqual(handled, false);
  assert.strictEqual(deleted.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('typing an out-of-range number asks again, deletes nothing, and DISARMS (single-use)', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2'], armed: true }]]);
  const { deps, sent, deleted } = baseDeps({ pendingBillDelete });
  const handled = await tryResolveBillDelete('900', '9', deps);
  assert.strictEqual(handled, true);
  assert.strictEqual(deleted.length, 0);
  assert.match(sent[0].text, /between 1 and 2/);
  assert.strictEqual(pendingBillDelete.get('900').armed, false); // consumed — must re-tap Delete
});

test("typing the number of someone ELSE's bill is refused (submitter-only) and DISARMS", async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, sent, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  const handled = await tryResolveBillDelete('900', '3', deps); // e3 was submitted by chat 901
  assert.strictEqual(handled, true);
  assert.strictEqual(deleted.length, 0);
  assert.match(sent[0].text, /Only the person who submitted/);
  assert.strictEqual(pendingBillDelete.get('900').armed, false);
});

test('typing non-numeric text while armed falls through (returns false), leaves arm intact', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1'], armed: true }]]);
  const { deps, deleted } = baseDeps({ pendingBillDelete });
  const handled = await tryResolveBillDelete('900', 'hello', deps);
  assert.strictEqual(handled, false);
  assert.strictEqual(deleted.length, 0);
  assert.strictEqual(pendingBillDelete.get('900').armed, true); // a non-number isn't the "one shot"
});

// Jeevan's #139 safety note: after a failed attempt the arm is consumed, so a stray number
// typed later can never soft-delete a bill without a fresh Delete tap.
test('SAFETY: a stray number after a failed attempt does nothing (single-use armed state)', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2'], armed: true }]]);
  const { deps, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  await tryResolveBillDelete('900', '9', deps);          // out-of-range → disarms
  const handled = await tryResolveBillDelete('900', '1', deps); // stray valid number later
  assert.strictEqual(handled, false);                    // ignored — not armed anymore
  assert.strictEqual(deleted.length, 0);                 // e1 was NOT deleted
});

// --- QA-reported: a LIST of bill numbers (e.g. "1, 2, 4") must delete every one, not
// fall through to the main menu — and any successful delete offers Next/Done. -----------

test('typing a single number that deletes also offers Next/Done buttons', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, sent } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  await tryResolveBillDelete('900', '2', deps);
  const kb = sent[0].replyMarkup.inline_keyboard[0];
  assert.strictEqual(kb[0].callback_data, 'delnum:next');
  assert.strictEqual(kb[1].callback_data, 'delnum:done');
});

test('typing a LIST "1, 2" deletes both listed bills in one go and summarizes each', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, sent, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  const handled = await tryResolveBillDelete('900', '1, 2', deps);
  assert.strictEqual(handled, true);
  assert.deepStrictEqual(deleted, [
    { table: 'expenses', where: { id: 'e1', scope: { account_id: undefined } } },
    { table: 'expenses', where: { id: 'e2', scope: { account_id: undefined } } },
  ]);
  assert.match(sent[0].text, /Taco Bell/);
  assert.match(sent[0].text, /Shell/);
  assert.strictEqual(pendingBillDelete.get('900').deleted.length, 2);
  assert.strictEqual(pendingBillDelete.get('900').armed, false);
  const kb = sent[0].replyMarkup.inline_keyboard[0];
  assert.strictEqual(kb[0].callback_data, 'delnum:next');
  assert.strictEqual(kb[1].callback_data, 'delnum:done');
});

test('a list with a mix of valid/invalid/not-owned numbers reports each outcome and only deletes the valid ones', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, sent, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  // 1 = own bill (deletes), 3 = someone else's (refused), 9 = out of range
  const handled = await tryResolveBillDelete('900', '1, 3, 9', deps);
  assert.strictEqual(handled, true);
  assert.deepStrictEqual(deleted, [{ table: 'expenses', where: { id: 'e1', scope: { account_id: undefined } } }]);
  assert.match(sent[0].text, /Taco Bell/);
  assert.match(sent[0].text, /only the submitter/i);
  assert.match(sent[0].text, /no such bill/i);
});

test('typing a space-separated list ("1 2") is also accepted as a list', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  await tryResolveBillDelete('900', '1 2', deps);
  assert.strictEqual(deleted.length, 2);
});

test('a duplicated number in the list ("1, 1, 2") is only processed once', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: true }]]);
  const { deps, deleted } = baseDeps({
    pendingBillDelete,
    sbSelect: async (_t, opts) => BILLS.filter((b) => b.id === (opts.eq && opts.eq.id)),
  });
  await tryResolveBillDelete('900', '1, 1, 2', deps);
  assert.strictEqual(deleted.length, 2); // e1 once, e2 once — not e1 twice
});

// --- delnum:next / delnum:done: the continue-or-finish loop (QA issue: "no efficient
// workflow for removing multiple items") ------------------------------------------------

test('delnum:next re-arms the chat (same as delnum:ask) without losing the running session', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1', 'e2', 'e3'], armed: false, deleted: [{ merchant: 'Taco Bell', amount: 291.58, currency: 'MYR' }] }]]);
  const { deps, sent } = baseDeps({ pendingBillDelete });
  await handleCallbackQuery({ id: 'cq1', data: 'delnum:next', message: { chat: { id: '900' }, message_id: 5 } }, deps);
  assert.strictEqual(pendingBillDelete.get('900').armed, true);
  assert.strictEqual(pendingBillDelete.get('900').deleted.length, 1); // session total preserved
  assert.match(sent[0].text, /number/i);
});

test('delnum:done with deletions shows a summary and clears the pending entry', async () => {
  const pendingBillDelete = new Map([['900', {
    ids: ['e1', 'e2', 'e3'],
    armed: false,
    deleted: [
      { merchant: 'Taco Bell', amount: 291.58, currency: 'MYR' },
      { merchant: 'Shell', amount: 80.00, currency: 'MYR' },
    ],
  }]]);
  const { deps, sent } = baseDeps({ pendingBillDelete });
  await handleCallbackQuery({ id: 'cq1', data: 'delnum:done', message: { chat: { id: '900' }, message_id: 5 } }, deps);
  assert.match(sent[0].text, /Taco Bell/);
  assert.match(sent[0].text, /Shell/);
  assert.match(sent[0].text, /2 bills/i);
  assert.strictEqual(pendingBillDelete.has('900'), false); // session cleared
});

test('delnum:done with NO deletions this session says so and still clears the pending entry', async () => {
  const pendingBillDelete = new Map([['900', { ids: ['e1'], armed: false, deleted: [] }]]);
  const { deps, sent } = baseDeps({ pendingBillDelete });
  await handleCallbackQuery({ id: 'cq1', data: 'delnum:done', message: { chat: { id: '900' }, message_id: 5 } }, deps);
  assert.match(sent[0].text, /no bills were deleted/i);
  assert.strictEqual(pendingBillDelete.has('900'), false);
});
