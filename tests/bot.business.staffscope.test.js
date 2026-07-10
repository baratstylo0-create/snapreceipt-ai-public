'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Business staff-tag picker + branch scoping (ADR-021 Phase 5 follow-up, issue #107):
// after a bound chat's receipt saves, the bot asks "who is this receipt for?" with the
// branch's staff as buttons; a tap stamps staff_user_id on the saved row. Today Bills /
// Today Expenses / Weekly Record are hard-scoped to a clerk's own branch (admins still
// see every branch), and bound business chats get Sunday-start weeks. Everything here
// must be a no-op in personal mode — the personal bot path stays byte-for-byte intact.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleUpdate, handleCallbackQuery, sendStaffPicker, branchEq,
  handleTodayBills, handleTodayExpenses, handleWeeklyRecord,
} = require('../lib/bot');
const { assembleExpense } = require('../lib/ocr');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const updates = [];
  const edited = [];
  return {
    deps: {
      tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
      tgEditMessage: async (chatId, messageId, text) => { edited.push({ chatId, messageId, text }); },
      tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
      sbSelect: async () => [],
      sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); return []; },
      getCapabilities: () => ({ multiUser: true }),
      ...over,
    },
    sent, answered, updates, edited,
  };
}

const STAFF = [
  { id: 's-ali', display_name: 'Ali' },
  { id: 's-mei', display_name: 'Mei' },
  { id: 's-raj', display_name: 'Raj' },
];

const spTap = (chatId, expenseId, idx) => ({
  id: 'cq9', data: 'sp:' + expenseId + ':' + idx,
  message: { chat: { id: chatId }, message_id: 77 },
});

// --- branchEq -------------------------------------------------------------------------

test('branchEq: a clerk binding filters to their own branch', () => {
  assert.deepStrictEqual(branchEq({ role: 'clerk', branch_id: 'br-A' }), { branch_id: 'br-A' });
});

test('branchEq: an admin binding applies NO branch filter (sees every branch)', () => {
  assert.deepStrictEqual(branchEq({ role: 'admin', branch_id: 'br-HQ' }), {});
});

test('branchEq: personal mode (null binding) applies no filter — unchanged behaviour', () => {
  assert.deepStrictEqual(branchEq(null), {});
  assert.deepStrictEqual(branchEq(undefined), {});
});

test('branchEq: a clerk binding somehow missing branch_id fails open to no filter, never a broken query', () => {
  assert.deepStrictEqual(branchEq({ role: 'clerk' }), {});
});

// --- sendStaffPicker --------------------------------------------------------------------

test('sendStaffPicker: sends the "who is this for?" prompt with one button per staff member', async () => {
  const { deps, sent } = baseDeps({ listStaff: async (branchId) => { assert.strictEqual(branchId, 'br-A'); return STAFF; } });
  await sendStaffPicker(10, { id: 'e1', merchant: 'Bonda Cafe', amount: 21.2, currency: 'MYR' }, 'br-A', deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /Who is this receipt for/);
  assert.match(sent[0].text, /Bonda Cafe/);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.text), ['Ali', 'Mei', 'Raj']);
  assert.deepStrictEqual(buttons.map(b => b.callback_data), ['sp:e1:0', 'sp:e1:1', 'sp:e1:2']);
});

test('sendStaffPicker: buttons are laid out two per row (fits a phone screen)', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(11, { id: 'e2', merchant: 'X', amount: 1 }, 'br-A', deps);
  const rows = sent[0].replyMarkup.inline_keyboard;
  assert.strictEqual(rows[0].length, 2);
  assert.strictEqual(rows[1].length, 1);
});

test('sendStaffPicker: a branch with no staff directory sends nothing (receipt already saved, nothing to tag)', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => [] });
  await sendStaffPicker(12, { id: 'e3', merchant: 'X', amount: 1 }, 'br-A', deps);
  assert.strictEqual(sent.length, 0);
});

test('sendStaffPicker: a staff-directory lookup error never crashes or blocks the save', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => { throw new Error('db down'); } });
  await sendStaffPicker(13, { id: 'e4', merchant: 'X', amount: 1 }, 'br-A', deps);
  assert.strictEqual(sent.length, 0);
});

test('sendStaffPicker: missing expense or branch is a silent no-op', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(14, null, 'br-A', deps);
  await sendStaffPicker(14, { id: 'e5' }, null, deps);
  assert.strictEqual(sent.length, 0);
});

// --- Issue #162 D11: "always ask for staff name" — the ask must be a tracked, real
// pending state (status: 'awaiting_staff'), not just a fire-and-forget message that can
// go unanswered with no trace. ---

test('sendStaffPicker: marks the receipt awaiting_staff when it actually asks', async () => {
  const { deps, updates } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(30, { id: 'e-await1', merchant: 'Shop', amount: 5, status: 'saved' }, 'br-A', deps);
  assert.deepStrictEqual(updates, [{ table: 'expenses', where: { id: 'e-await1' }, patch: { status: 'awaiting_staff' } }]);
});

test('sendStaffPicker: a branch with no staff directory never touches status (nothing to ask)', async () => {
  const { deps, updates } = baseDeps({ listStaff: async () => [] });
  await sendStaffPicker(31, { id: 'e-await2', merchant: 'X', amount: 1, status: 'saved' }, 'br-A', deps);
  assert.strictEqual(updates.length, 0);
});

test('staff tap: resolving the pick restores the PRIOR status (e.g. needs_review), not a hardcoded "saved"', async () => {
  const { deps: pickDeps } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(32, { id: 'e-await3', merchant: 'Shop', amount: 7, status: 'needs_review' }, 'br-A', pickDeps);
  const { deps: tapDeps, updates } = baseDeps();
  await handleCallbackQuery(spTap(32, 'e-await3', 0), tapDeps);
  assert.strictEqual(updates[0].patch.status, 'needs_review', 'must restore the anomaly flag, not silently clear it');
});

// --- the staff-tag tap (sp:<expenseId>:<idx>) --------------------------------------------

test('staff tap: tapping a name stamps staff_user_id on that expense and confirms in place', async () => {
  const { deps, sent } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(20, { id: 'e-tag1', merchant: 'Shop', amount: 5 }, 'br-A', deps);
  assert.strictEqual(sent.length, 1);

  const { deps: tapDeps, updates, edited, answered } = baseDeps();
  await handleCallbackQuery(spTap(20, 'e-tag1', 1), tapDeps); // idx 1 = Mei
  // Issue #162 D11: resolving the pick also restores the receipt's prior status (here
  // 'saved', since this fixture's expense had no status set) — see the dedicated
  // priorStatus test below for the 'needs_review' case.
  assert.deepStrictEqual(updates, [{ table: 'expenses', where: { id: 'e-tag1' }, patch: { staff_user_id: 's-mei', status: 'saved' } }]);
  assert.match(edited[0].text, /Tagged to \*Mei\*/);
  assert.strictEqual(answered[0].opts.text, 'Tagged');
});

test('staff tap: remember-last — the person tagged last time is offered FIRST (with a star) next time', async () => {
  // The tap in the previous test set chat 20's last pick to Mei.
  const { deps, sent } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(20, { id: 'e-tag2', merchant: 'Shop', amount: 6 }, 'br-A', deps);
  const buttons = sent[0].replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(b => b.text), ['⭐ Mei', 'Ali', 'Raj']);
  // Index buttons must match the REORDERED list, so tapping the star still tags Mei.
  const { deps: tapDeps, updates } = baseDeps();
  await handleCallbackQuery(spTap(20, 'e-tag2', 0), tapDeps);
  assert.strictEqual(updates[0].patch.staff_user_id, 's-mei');
});

test('staff tap: an expired/unknown picker (e.g. bot restarted) degrades to an honest note, receipt untouched', async () => {
  const { deps, updates, edited, answered } = baseDeps();
  await handleCallbackQuery(spTap(21, 'e-never-pinned', 0), deps);
  assert.strictEqual(updates.length, 0);
  assert.match(edited[0].text, /expired/i);
  assert.strictEqual(answered[0].opts.text, 'Expired');
});

test('staff tap: a save failure gets a friendly warning — never a crash, receipt row already safe', async () => {
  const { deps: pickDeps } = baseDeps({ listStaff: async () => STAFF });
  await sendStaffPicker(22, { id: 'e-tag3', merchant: 'Shop', amount: 7 }, 'br-A', pickDeps);
  const { deps, edited } = baseDeps({ sbUpdate: async () => { throw new Error('db write refused'); } });
  await handleCallbackQuery(spTap(22, 'e-tag3', 0), deps);
  assert.match(edited[0].text, /Couldn't save that tag/);
  assert.doesNotMatch(edited[0].text, /db write refused/); // internals never leak to the chat
});

// --- branch-scoped Today Bills / Today Expenses / Weekly Record --------------------------

function scopeProbe(rows = []) {
  const seen = [];
  return { seen, sbSelect: async (table, opts) => { seen.push({ table, opts }); return rows; } };
}

test('Today Bills: a bound CLERK only sees their own branch', async () => {
  const probe = scopeProbe();
  const { deps } = baseDeps({ sbSelect: probe.sbSelect });
  await handleTodayBills(30, deps, { role: 'clerk', branch_id: 'br-A' });
  assert.deepStrictEqual(probe.seen[0].opts.eq, { branch_id: 'br-A' });
});

test('Today Bills: a bound ADMIN sees every branch (no filter)', async () => {
  const probe = scopeProbe();
  const { deps } = baseDeps({ sbSelect: probe.sbSelect });
  await handleTodayBills(31, deps, { role: 'admin', branch_id: 'br-HQ' });
  assert.deepStrictEqual(probe.seen[0].opts.eq, {});
});

test('Today Bills: personal mode (no binding) queries exactly as before — no branch filter', async () => {
  const probe = scopeProbe();
  const { deps } = baseDeps({ sbSelect: probe.sbSelect });
  await handleTodayBills(32, deps);
  assert.deepStrictEqual(probe.seen[0].opts.eq, {});
});

test('Today Expenses: clerk scoped to own branch; personal unscoped', async () => {
  const clerkProbe = scopeProbe();
  const { deps: clerkDeps } = baseDeps({ sbSelect: clerkProbe.sbSelect });
  await handleTodayExpenses(33, clerkDeps, { role: 'clerk', branch_id: 'br-B' });
  assert.deepStrictEqual(clerkProbe.seen[0].opts.eq, { branch_id: 'br-B' });

  const personalProbe = scopeProbe();
  const { deps: personalDeps } = baseDeps({ sbSelect: personalProbe.sbSelect });
  await handleTodayExpenses(34, personalDeps);
  assert.deepStrictEqual(personalProbe.seen[0].opts.eq, {});
});

test('Weekly Record: a bound business chat counts the week from SUNDAY; personal keeps Monday', async () => {
  const calls = { sunday: 0, monday: 0 };
  const helpers = {
    weekStartSundayISO: () => { calls.sunday++; return '2026-07-05'; },
    weekStartSundayBoundUTC: () => '2026-07-04T16:00:00.000Z',
    weekStartISO: () => { calls.monday++; return '2026-07-06'; },
    weekStartBoundUTC: () => '2026-07-05T16:00:00.000Z',
  };
  const boundProbe = scopeProbe();
  const { deps: boundDeps } = baseDeps({ sbSelect: boundProbe.sbSelect, ...helpers });
  await handleWeeklyRecord(35, boundDeps, { role: 'clerk', branch_id: 'br-A' });
  assert.strictEqual(calls.sunday, 1);
  assert.strictEqual(calls.monday, 0);
  assert.deepStrictEqual(boundProbe.seen[0].opts.eq, { branch_id: 'br-A' });
  assert.match(boundProbe.seen[0].opts.extra, /2026-07-04T16/); // Sunday boundary in the query

  const personalProbe = scopeProbe();
  const { deps: personalDeps } = baseDeps({ sbSelect: personalProbe.sbSelect, ...helpers });
  await handleWeeklyRecord(36, personalDeps);
  assert.strictEqual(calls.sunday, 1); // unchanged
  assert.strictEqual(calls.monday, 1);
  assert.deepStrictEqual(personalProbe.seen[0].opts.eq, {});
});

// --- the bound photo path: branch tag + staff picker --------------------------------------

const photoMsg = (chatId) => ({ message: { chat: { id: chatId }, from: { first_name: 'A' }, photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
const CLERK_BINDING = { id: 'b1', chat_id: '40', branch_id: 'br-A', role: 'clerk', active: true };

test('bound photo: the receipt is tagged with the binding\'s branch, then the staff picker follows', async () => {
  const photoCalls = [];
  const pickerCalls = [];
  const savedExpense = { id: 'e-photo1', merchant: 'Cafe', amount: 9, currency: 'MYR' };
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING,
    expenseFromPhoto: async (chatId, repName, fileId, meta) => { photoCalls.push({ chatId, fileId, meta }); return { ok: true, expense: savedExpense }; },
    sendStaffPicker: async (chatId, expense, branchId) => { pickerCalls.push({ chatId, expense, branchId }); },
  });
  await handleUpdate(photoMsg(40), deps);
  assert.strictEqual(photoCalls[0].fileId, 'big'); // largest photo size, same as personal
  assert.deepStrictEqual(photoCalls[0].meta, { branch_id: 'br-A' });
  assert.deepStrictEqual(pickerCalls, [{ chatId: 40, expense: savedExpense, branchId: 'br-A' }]);
});

// Multi-company client (ADR-023 Phase 8): a binding that carries a company_id stamps BOTH
// branch and company onto the receipt, so per-company reports/statements need no join.
const CLERK_BINDING_CO = { id: 'b7', chat_id: '44', branch_id: 'br-A', company_id: 'co-1', role: 'clerk', active: true };

test('bound photo (multi-company): the receipt meta carries BOTH branch_id and company_id', async () => {
  const photoCalls = [];
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING_CO,
    expenseFromPhoto: async (chatId, repName, fileId, meta) => { photoCalls.push({ meta }); return { ok: true, expense: { id: 'e-co1' } }; },
    sendStaffPicker: async () => {},
  });
  await handleUpdate(photoMsg(44), deps);
  assert.deepStrictEqual(photoCalls[0].meta, { branch_id: 'br-A', company_id: 'co-1' });
});

test('bound photo: a failed/skipped read sends NO staff picker (nothing was saved to tag)', async () => {
  const pickerCalls = [];
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING,
    expenseFromPhoto: async () => false, // skip/error path
    sendStaffPicker: async (...a) => { pickerCalls.push(a); },
  });
  await handleUpdate(photoMsg(41), deps);
  assert.strictEqual(pickerCalls.length, 0);
});

test('personal photo: no branch meta, no staff picker — the old path byte-for-byte', async () => {
  const photoCalls = [];
  const pickerCalls = [];
  const { deps } = baseDeps({
    getCapabilities: () => ({ multiUser: false }),
    expenseFromPhoto: async (chatId, repName, fileId, meta) => { photoCalls.push({ meta }); return { ok: true, expense: { id: 'x' } }; },
    sendStaffPicker: async (...a) => { pickerCalls.push(a); },
  });
  await handleUpdate(photoMsg(42), deps);
  assert.strictEqual(photoCalls[0].meta, undefined);
  assert.strictEqual(pickerCalls.length, 0);
});

test('bound image-document (photo sent as file): same branch tag + picker as a photo', async () => {
  const photoCalls = [];
  const pickerCalls = [];
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING,
    expenseFromPhoto: async (chatId, repName, fileId, meta) => { photoCalls.push({ fileId, meta }); return { ok: true, expense: { id: 'e-doc1' } }; },
    sendStaffPicker: async (...a) => { pickerCalls.push(a); },
  });
  await handleUpdate({ message: { chat: { id: 43 }, from: { first_name: 'A' }, document: { file_id: 'doc9', mime_type: 'image/jpeg' } } }, deps);
  assert.deepStrictEqual(photoCalls[0], { fileId: 'doc9', meta: { branch_id: 'br-A' } });
  assert.strictEqual(pickerCalls.length, 1);
});

// --- bound album (media group) + PDF: branch rides the batch meta ---------------------------

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    runPending: async () => { for (const fn of [...pending.values()]) { pending.clear(); await fn(); } },
  };
}

test('bound album: the whole photo album is attributed to the binding\'s branch (one tag for the batch)', async () => {
  const timers = fakeTimers();
  const runBatchCalls = [];
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => FIELDSPEC,
    runBatch: async (images, fieldSpec, d) => {
      runBatchCalls.push({ meta: d.meta });
      return { images: images.length, receipts: 1, saved: 1, failed: [], flagged: [], truncated_images: [] };
    },
  });
  const albumMsg = (fid) => ({ message: { chat: { id: 50 }, from: { first_name: 'A' }, media_group_id: 'biz-grp', photo: [{ file_id: fid }] } });
  await handleUpdate(albumMsg('p1'), deps);
  await handleUpdate(albumMsg('p2'), deps);
  await timers.runPending();
  assert.strictEqual(runBatchCalls.length, 1);
  assert.strictEqual(runBatchCalls[0].meta.branch_id, 'br-A');
});

test('personal album: batch meta carries NO branch_id — unchanged', async () => {
  const timers = fakeTimers();
  const runBatchCalls = [];
  const { deps } = baseDeps({
    getCapabilities: () => ({ multiUser: false }),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, debounceMs: 1,
    tgFileUrl: async (fid) => ({ url: 'https://tg/' + fid }),
    getFieldSpec: async () => FIELDSPEC,
    runBatch: async (images, fieldSpec, d) => {
      runBatchCalls.push({ meta: d.meta });
      return { images: images.length, receipts: 1, saved: 1, failed: [], flagged: [], truncated_images: [] };
    },
  });
  await handleUpdate({ message: { chat: { id: 51 }, from: { first_name: 'A' }, media_group_id: 'per-grp', photo: [{ file_id: 'p9' }] } }, deps);
  await timers.runPending();
  assert.ok(!('branch_id' in runBatchCalls[0].meta));
});

test('bound PDF: the PDF\'s receipts are attributed to the binding\'s branch', async () => {
  const pdfCalls = [];
  const { deps } = baseDeps({
    resolveBinding: async () => CLERK_BINDING,
    handlePdfDocument: async (chatId, repName, fileId, d, extraMeta) => { pdfCalls.push({ fileId, extraMeta }); },
  });
  await handleUpdate({ message: { chat: { id: 52 }, from: { first_name: 'A' }, document: { file_id: 'pdf1', mime_type: 'application/pdf', file_name: 'r.pdf' } } }, deps);
  assert.deepStrictEqual(pdfCalls, [{ fileId: 'pdf1', extraMeta: { branch_id: 'br-A' } }]);
});

// --- assembleExpense: branch/staff stamping (the save itself) ------------------------------

const FIELDSPEC = { account_id: 'default', columns: [
  { key: 'merchant', label: 'Vendor', type: 'text', required: true },
  { key: 'amount', label: 'Total', type: 'currency', required: true },
] };
function ocrInput(over = {}) {
  return {
    chatId: 1, repName: 'Tester', fileId: 'f1', fieldSpec: FIELDSPEC,
    fields: { merchant: 'Acme', amount: 100 },
    rawParsed: { merchant: 'Acme', amount: '100' },
    ...over,
  };
}
const ocrDeps = () => ({
  categorizeLineItems: async () => ({ category: 'Others', items: [] }),
  detectAnomalies: async () => ({ flagged: false, reasons: [], status_suggestion: 'saved' }),
  convertCurrency: async () => ({ ok: false, rate: null }),
  loadHistory: async () => [],
  insertExpense: async () => {},
});

test('assembleExpense: stamps branch_id and staff_user_id ONLY when the caller supplies them', async () => {
  const { expense } = await assembleExpense(ocrInput({ branch_id: 'br-A', staff_user_id: 's-ali' }), ocrDeps());
  assert.strictEqual(expense.branch_id, 'br-A');
  assert.strictEqual(expense.staff_user_id, 's-ali');
});

test('assembleExpense: personal callers (no meta) leave branch/staff completely absent — zero change', async () => {
  const { expense } = await assembleExpense(ocrInput(), ocrDeps());
  assert.ok(!('branch_id' in expense));
  assert.ok(!('company_id' in expense));
  assert.ok(!('staff_user_id' in expense));
});

test('assembleExpense: stamps company_id ONLY when the caller supplies it (multi-company attribution)', async () => {
  const withCo = await assembleExpense(ocrInput({ branch_id: 'br-A', company_id: 'co-1', staff_user_id: 's-ali' }), ocrDeps());
  assert.strictEqual(withCo.expense.company_id, 'co-1');
  assert.strictEqual(withCo.expense.branch_id, 'br-A');
  // a branch-only binding (no company) leaves company_id absent, never null-keyed
  const branchOnly = await assembleExpense(ocrInput({ branch_id: 'br-A' }), ocrDeps());
  assert.ok(!('company_id' in branchOnly.expense));
});
