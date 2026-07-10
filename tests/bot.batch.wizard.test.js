'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Issue #152 part 1: batch/album staff attribution wizard. One self-editing message walks
// each saved receipt — "who's this for?" with last-picked-floats-to-top, "Same for all
// remaining", and "Skip". Mirrors the single-photo sendStaffPicker's graceful-degrade
// contract (no staff directory -> silent no-op; never blocks the batch).
const { test } = require('node:test');
const assert = require('node:assert');
const { handleCallbackQuery, startBatchStaffWizard } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const edited = [];
  const answered = [];
  const updates = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); return { result: { message_id: 999 } }; },
    tgEditMessage: async (chatId, messageId, text, replyMarkup) => { edited.push({ chatId, messageId, text, replyMarkup }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
    ...over,
  };
  return { deps, sent, edited, answered, updates };
}

const STAFF = [{ id: 's-ali', display_name: 'Ali' }, { id: 's-mei', display_name: 'Mei' }, { id: 's-raj', display_name: 'Raj' }];
const SAVED = [
  { id: 'e1', merchant: 'Kedai A', amount: 5, currency: 'MYR', status: 'saved' },
  { id: 'e2', merchant: 'Kedai B', amount: 8, currency: 'MYR', status: 'needs_review' },
  { id: 'e3', merchant: 'Kedai C', amount: 3, currency: 'MYR', status: 'saved' },
];

const bwTap = (chatId, data) => ({ id: 'cq1', data, message: { chat: { id: chatId }, message_id: 999 } });

test('startBatchStaffWizard: marks every item awaiting_staff up front and sends step 1 of N', async () => {
  const { deps, sent, updates } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(50, SAVED, 'br-A', deps);
  assert.strictEqual(updates.length, 3);
  assert.ok(updates.every(u => u.patch.status === 'awaiting_staff'));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Receipt 1 of 3/);
  assert.match(sent[0].text, /Kedai A/);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.text), ['Ali', 'Mei', 'Raj', '👥 Same for all remaining', '⏭ Skip — assign on dashboard']);
});

test('startBatchStaffWizard: no staff directory -> silent no-op, never blocks the batch', async () => {
  const { deps, sent, updates } = baseDeps({ listStaff: async () => [] });
  await startBatchStaffWizard(51, SAVED, 'br-A', deps);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(updates.length, 0);
});

test('startBatchStaffWizard: no items with an id -> silent no-op', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(52, [{ merchant: 'no id' }], 'br-A', deps);
  assert.strictEqual(sent.length, 0);
});

test('bwpick: tapping a name stamps staff + advances to "Receipt 2 of 3" via editing the SAME message', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(60, SAVED, 'br-A', startDeps);

  const { deps, edited, updates } = baseDeps();
  await handleCallbackQuery(bwTap(60, 'bwpick:1'), deps); // idx 1 = Mei
  assert.strictEqual(updates[0].patch.staff_user_id, 's-mei');
  assert.strictEqual(updates[0].patch.status, 'saved', 'restores e1\'s prior status');
  assert.match(edited[0].text, /Receipt 2 of 3/);
  assert.match(edited[0].text, /Kedai B/);
});

test('bwpick: restores the PRIOR status (e.g. needs_review), same principle as #162 D11', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(61, SAVED, 'br-A', startDeps);
  const { deps: d1 } = baseDeps();
  await handleCallbackQuery(bwTap(61, 'bwpick:0'), d1); // resolves e1 (idx 0)

  const { deps: d2, updates } = baseDeps();
  await handleCallbackQuery(bwTap(61, 'bwpick:0'), d2); // now resolves e2, which was 'needs_review'
  assert.strictEqual(updates[0].patch.status, 'needs_review');
});

test('bwpick: last-picked person floats to the top (⭐) for the NEXT step', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(62, SAVED, 'br-A', startDeps);
  const { deps, edited } = baseDeps();
  await handleCallbackQuery(bwTap(62, 'bwpick:2'), deps); // idx 2 = Raj
  const buttons = edited[0].replyMarkup.inline_keyboard.flat();
  assert.match(buttons[0].text, /⭐ Raj/);
});

test('bwpick: after the LAST item, the message finishes with a done note and the wizard is cleared', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(63, [SAVED[0]], 'br-A', startDeps); // only ONE item
  const { deps, edited } = baseDeps();
  await handleCallbackQuery(bwTap(63, 'bwpick:0'), deps);
  assert.match(edited[0].text, /Staff assigned/i);
  assert.ok(!edited[0].replyMarkup, 'no keyboard on the finished note');

  // Wizard is gone — a further tap degrades to "expired", never a crash.
  const { deps: d2, edited: e2, answered } = baseDeps();
  await handleCallbackQuery(bwTap(63, 'bwpick:0'), d2);
  assert.strictEqual(answered[0].opts.text, 'Expired');
  assert.match(e2[0].text, /expired/i);
});

test('bwall: with nobody picked yet -> no-op, asks to pick one first', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(64, SAVED, 'br-A', startDeps);
  const { deps, updates, answered } = baseDeps();
  await handleCallbackQuery(bwTap(64, 'bwall'), deps);
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(answered[0].opts.text, 'Pick someone first');
});

test('bwall: after one pick, stamps that SAME person to every remaining item and finishes', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(65, SAVED, 'br-A', startDeps);
  const { deps: d1 } = baseDeps();
  await handleCallbackQuery(bwTap(65, 'bwpick:1'), d1); // e1 -> Mei; now on e2

  const { deps: d2, updates, edited } = baseDeps();
  await handleCallbackQuery(bwTap(65, 'bwall'), d2);
  assert.strictEqual(updates.length, 2, 'stamps e2 and e3 (the remaining two)');
  assert.ok(updates.every(u => u.patch.staff_user_id === 's-mei'));
  assert.strictEqual(updates[0].patch.status, 'needs_review'); // e2's prior status
  assert.strictEqual(updates[1].patch.status, 'saved'); // e3's prior status
  assert.match(edited[0].text, /Staff assigned/i);
});

test('bwskip: leaves the current item unassigned (still awaiting_staff) and moves to the next', async () => {
  const { deps: startDeps } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(66, SAVED, 'br-A', startDeps);
  const { deps, updates, edited, answered } = baseDeps();
  await handleCallbackQuery(bwTap(66, 'bwskip'), deps);
  assert.strictEqual(updates.length, 0, 'no DB write on skip -- stays awaiting_staff from the up-front mark');
  assert.strictEqual(answered[0].opts.text, 'Skipped');
  assert.match(edited[0].text, /Receipt 2 of 3/);
});

test('two different chats get independent wizards (no cross-talk)', async () => {
  const { deps: d1 } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(70, SAVED.slice(0, 1), 'br-A', d1);
  const { deps: d2 } = baseDeps({ listStaff: async () => STAFF });
  await startBatchStaffWizard(71, SAVED.slice(1, 2), 'br-B', d2);

  const { deps: tap1, updates: u1 } = baseDeps();
  await handleCallbackQuery(bwTap(70, 'bwpick:0'), tap1);
  assert.strictEqual(u1[0].where.id, 'e1');

  const { deps: tap2, updates: u2 } = baseDeps();
  await handleCallbackQuery(bwTap(71, 'bwpick:0'), tap2);
  assert.strictEqual(u2[0].where.id, 'e2');
});
