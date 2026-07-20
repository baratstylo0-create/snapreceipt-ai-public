'use strict';
process.env.ALLOWED_CHAT_IDS = '';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleUpdate, handleCallbackQuery, handleStaffLockStart,
  staffLockByChat, pendingStaffLockPicks, businessMenuKeyboard,
  sendLockedReceipt, sendLockedBatchSummary, flushGroup,
} = require('../lib/bot');

const STAFF = [
  { id: 's-ali', display_name: 'Ali' },
  { id: 's-mei', display_name: 'Mei' },
  { id: 's-raj', display_name: 'Raj' },
];

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
    sbSelect: async () => [],
    listStaff: async () => STAFF,
    ...over,
  };
  return { deps, sent, edited, answered, updates };
}

const cqTap = (chatId, data) => ({ id: 'cq1', data, message: { chat: { id: chatId }, message_id: 888 } });

function cleanup(chatId) {
  staffLockByChat.delete(chatId);
  pendingStaffLockPicks.delete(chatId);
}

// ---- businessMenuKeyboard -------------------------------------------------

test('businessMenuKeyboard: unlocked shows Staff Lock button', () => {
  const kb = businessMenuKeyboard(null);
  assert.strictEqual(kb.keyboard.length, 3);
  assert.deepStrictEqual(kb.keyboard[2], ['👤 Staff Lock']);
  assert.strictEqual(kb.resize_keyboard, true);
  assert.strictEqual(kb.is_persistent, true);
});

test('businessMenuKeyboard: locked shows locked name + Done', () => {
  const kb = businessMenuKeyboard({ staffName: 'Ali' });
  assert.strictEqual(kb.keyboard.length, 3);
  assert.deepStrictEqual(kb.keyboard[2], ['🔓 Locked: Ali', '✅ Done']);
});

// ---- handleStaffLockStart -------------------------------------------------

test('handleStaffLockStart: shows staff directory as inline keyboard with slock: prefix', async () => {
  const chatId = 100;
  cleanup(chatId);
  const { deps, sent } = baseDeps();
  await handleStaffLockStart(chatId, 'br-A', deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Staff Lock Mode/);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.text), ['Ali', 'Mei', 'Raj']);
  assert.deepStrictEqual(buttons.map(b => b.callback_data), ['slock:0', 'slock:1', 'slock:2']);
  assert.ok(pendingStaffLockPicks.has(chatId));
  cleanup(chatId);
});

test('handleStaffLockStart: no staff directory -> polite refusal, no crash', async () => {
  const chatId = 101;
  cleanup(chatId);
  const { deps, sent } = baseDeps({ listStaff: async () => [] });
  await handleStaffLockStart(chatId, 'br-A', deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /No staff members found/);
  assert.ok(!pendingStaffLockPicks.has(chatId));
  cleanup(chatId);
});

test('handleStaffLockStart: no branchId -> polite refusal', async () => {
  const chatId = 102;
  cleanup(chatId);
  const { deps, sent } = baseDeps();
  await handleStaffLockStart(chatId, null, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /No branch assigned/);
  cleanup(chatId);
});

// ---- slock: callback (picking a staff to lock) ----------------------------

test('slock: picking a staff member sets the lock and confirms', async () => {
  const chatId = 200;
  cleanup(chatId);
  // First, trigger the picker so pendingStaffLockPicks is populated
  const { deps: startDeps } = baseDeps();
  await handleStaffLockStart(chatId, 'br-A', startDeps);

  // Now tap slock:1 (Mei)
  const { deps, sent, answered } = baseDeps();
  await handleCallbackQuery(cqTap(chatId, 'slock:1'), deps);

  assert.ok(staffLockByChat.has(chatId));
  const lock = staffLockByChat.get(chatId);
  assert.strictEqual(lock.staffId, 's-mei');
  assert.strictEqual(lock.staffName, 'Mei');
  assert.strictEqual(lock.branchId, 'br-A');
  assert.strictEqual(answered[0].opts.text, 'Locked');
  // Should have sent a confirmation edit + a keyboard refresh
  assert.ok(sent.length >= 1);
  cleanup(chatId);
});

test('slock: expired picker -> polite expired message', async () => {
  const chatId = 201;
  cleanup(chatId);
  // Don't set up pendingStaffLockPicks — simulate expired
  const { deps, answered } = baseDeps();
  await handleCallbackQuery(cqTap(chatId, 'slock:0'), deps);
  assert.strictEqual(answered[0].opts.text, 'Expired');
  cleanup(chatId);
});

test('slock: invalid index -> Invalid', async () => {
  const chatId = 202;
  cleanup(chatId);
  const { deps: startDeps } = baseDeps();
  await handleStaffLockStart(chatId, 'br-A', startDeps);

  const { deps, answered } = baseDeps();
  await handleCallbackQuery(cqTap(chatId, 'slock:99'), deps);
  assert.strictEqual(answered[0].opts.text, 'Invalid');
  cleanup(chatId);
});

// ---- slockdone callback (unlocking) ---------------------------------------

test('slockdone: clears the lock and confirms', async () => {
  const chatId = 300;
  staffLockByChat.set(chatId, { staffId: 's-ali', staffName: 'Ali', branchId: 'br-A' });

  const { deps, answered, sent } = baseDeps();
  await handleCallbackQuery(cqTap(chatId, 'slockdone'), deps);

  assert.ok(!staffLockByChat.has(chatId));
  assert.strictEqual(answered[0].opts.text, 'Unlocked');
  cleanup(chatId);
});

// ---- Single photo while locked --------------------------------------------

test('single photo while locked: staff_user_id injected into meta, sendStaffPicker NOT called', async () => {
  const chatId = 400;
  cleanup(chatId);
  staffLockByChat.set(chatId, { staffId: 's-ali', staffName: 'Ali', branchId: 'br-A' });

  let capturedMeta = null;
  let staffPickerCalled = false;
  let lockedReceiptCalled = false;

  // 2026-07-20: a single photo now buffers through the same debounce as an album (bulk-spam
  // fix) — a fake timer deterministically flushes it instead of relying on a real setTimeout.
  const pending = [];
  const { deps } = baseDeps({
    getCapabilities: () => ({ multiUser: true }),
    resolveBinding: async () => ({ branch_id: 'br-A', company_id: 'co-1', account_id: 'acc-1' }),
    setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => {}, debounceMs: 1,
    expenseFromPhoto: async (cid, name, fid, meta) => {
      capturedMeta = meta;
      return { ok: true, expense: { id: 'exp-1', merchant: 'Test', amount: 10, currency: 'MYR', status: 'saved' } };
    },
    sendStaffPicker: async () => { staffPickerCalled = true; },
    sendLockedReceipt: async () => { lockedReceiptCalled = true; },
  });

  await handleUpdate({
    message: {
      chat: { id: chatId },
      from: { first_name: 'Clerk' },
      photo: [{ file_id: 'photo-1', file_unique_id: 'u1' }],
    },
  }, deps);
  for (const fn of pending.splice(0)) await fn();

  assert.strictEqual(capturedMeta.staff_user_id, 's-ali');
  assert.strictEqual(capturedMeta.silent, true, '2026-07-20: expenseFromPhoto must stay quiet — sendLockedReceipt is the ONLY confirmation, no double message');
  assert.strictEqual(staffPickerCalled, false, 'staff picker must NOT be called when locked');
  assert.strictEqual(lockedReceiptCalled, true, 'locked receipt summary must be shown');
  cleanup(chatId);
});

test('single photo NOT locked: sendStaffPicker called normally', async () => {
  const chatId = 401;
  cleanup(chatId);

  let staffPickerCalled = false;
  let lockedReceiptCalled = false;

  const pending = [];
  const { deps } = baseDeps({
    getCapabilities: () => ({ multiUser: true }),
    resolveBinding: async () => ({ branch_id: 'br-A', company_id: 'co-1', account_id: 'acc-1' }),
    setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => {}, debounceMs: 1,
    expenseFromPhoto: async () => ({ ok: true, expense: { id: 'exp-2', merchant: 'Test', amount: 5, currency: 'MYR', status: 'saved' } }),
    sendStaffPicker: async () => { staffPickerCalled = true; },
    sendLockedReceipt: async () => { lockedReceiptCalled = true; },
  });

  await handleUpdate({
    message: {
      chat: { id: chatId },
      from: { first_name: 'Clerk' },
      photo: [{ file_id: 'photo-2', file_unique_id: 'u2' }],
    },
  }, deps);
  for (const fn of pending.splice(0)) await fn();

  assert.strictEqual(staffPickerCalled, true, 'staff picker must be called when NOT locked');
  assert.strictEqual(lockedReceiptCalled, false);
  cleanup(chatId);
});

// ---- sendLockedReceipt output ---------------------------------------------

test('sendLockedReceipt: shows receipt details with Edit + Done buttons', async () => {
  const { deps, sent } = baseDeps();
  await sendLockedReceipt(99, { id: 'e1', merchant: 'Mamak', amount: 12.5, currency: 'MYR', expense_date: '2026-07-17', category: 'Food', voucher_no: 'RC-001' }, { staffName: 'Ali' }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Ali/);
  assert.match(sent[0].text, /Mamak/);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.strictEqual(buttons[0].callback_data, 'catedit:e1');
  assert.strictEqual(buttons[1].callback_data, 'slockdone');
});

// ---- sendLockedBatchSummary output ----------------------------------------

test('sendLockedBatchSummary: shows batch count + merchant list + Done button', async () => {
  const saved = [
    { merchant: 'Kedai A', amount: 5, currency: 'MYR' },
    { merchant: 'Kedai B', amount: 8, currency: 'MYR' },
  ];
  const { deps, sent } = baseDeps();
  await sendLockedBatchSummary(99, saved, { staffName: 'Raj' }, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /2 receipts saved/);
  assert.match(sent[0].text, /Raj/);
  assert.match(sent[0].text, /Kedai A/);
  assert.match(sent[0].text, /Kedai B/);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.strictEqual(buttons[0].callback_data, 'slockdone');
});

// ---- Done via menu button text match --------------------------------------

test('Done menu button: clears lock via handleUpdate text match', async () => {
  const chatId = 500;
  cleanup(chatId);
  staffLockByChat.set(chatId, { staffId: 's-ali', staffName: 'Ali', branchId: 'br-A' });

  const { deps, sent } = baseDeps({
    getCapabilities: () => ({ multiUser: true }),
    resolveBinding: async () => ({ branch_id: 'br-A', company_id: 'co-1', account_id: 'acc-1' }),
  });

  await handleUpdate({
    message: {
      chat: { id: chatId },
      from: { first_name: 'Clerk' },
      text: '✅ Done',
    },
  }, deps);

  assert.ok(!staffLockByChat.has(chatId), 'lock must be cleared');
  assert.ok(sent.some(s => /Staff Lock OFF/.test(s.text)));
  cleanup(chatId);
});

// ---- Business-only: personal mode ignores Staff Lock ----------------------

test('personal mode: Staff Lock text is ignored (falls through to fallback)', async () => {
  const chatId = 600;
  cleanup(chatId);

  const { deps, sent } = baseDeps({
    getCapabilities: () => ({ multiUser: false }),
  });

  await handleUpdate({
    message: {
      chat: { id: chatId },
      from: { first_name: 'Personal' },
      text: '👤 Staff Lock',
    },
  }, deps);

  // Should hit the fallback "I didn't catch that" — not the staff lock handler
  assert.ok(sent.some(s => /didn't quite catch that/.test(s.text)));
  cleanup(chatId);
});

// ---- Lock replacement: new lock overwrites old ----------------------------

test('new lock replaces old lock', async () => {
  const chatId = 700;
  cleanup(chatId);
  staffLockByChat.set(chatId, { staffId: 's-ali', staffName: 'Ali', branchId: 'br-A' });

  // Start a new lock pick
  const { deps: startDeps } = baseDeps();
  await handleStaffLockStart(chatId, 'br-A', startDeps);

  // Pick Raj (index 2)
  const { deps } = baseDeps();
  await handleCallbackQuery(cqTap(chatId, 'slock:2'), deps);

  const lock = staffLockByChat.get(chatId);
  assert.strictEqual(lock.staffId, 's-raj');
  assert.strictEqual(lock.staffName, 'Raj');
  cleanup(chatId);
});

// ---- Lock cleared on bot restart (documented v1 caveat) -------------------

test('lock is in-memory Map: clearing it simulates restart behavior', () => {
  const chatId = 800;
  staffLockByChat.set(chatId, { staffId: 's-ali', staffName: 'Ali', branchId: 'br-A' });
  assert.ok(staffLockByChat.has(chatId));
  staffLockByChat.clear();
  assert.ok(!staffLockByChat.has(chatId));
});

// ---- Locked status info tap -----------------------------------------------

test('tapping the locked name button shows current lock status', async () => {
  const chatId = 900;
  cleanup(chatId);
  staffLockByChat.set(chatId, { staffId: 's-mei', staffName: 'Mei', branchId: 'br-A' });

  const { deps, sent } = baseDeps({
    getCapabilities: () => ({ multiUser: true }),
    resolveBinding: async () => ({ branch_id: 'br-A', company_id: 'co-1', account_id: 'acc-1' }),
  });

  await handleUpdate({
    message: {
      chat: { id: chatId },
      from: { first_name: 'Clerk' },
      text: '🔓 Locked: Mei',
    },
  }, deps);

  assert.ok(sent.some(s => /locked to.*Mei/.test(s.text)));
  cleanup(chatId);
});
