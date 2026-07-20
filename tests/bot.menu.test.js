'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Persistent menu bar (Owner request 2026-07-04): 4 always-visible buttons — Today Bills,
// Today Expenses, Weekly Record, Bot Guide. All day/week boundaries use Malaysia time
// (UTC+8) regardless of the server's own timezone. 2024-01-01 is a known real-world
// Monday — used as bedrock for the date-math tests below instead of hardcoding "today".
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleUpdate, handleTodayBills, handleTodayExpenses, handleWeeklyRecord,
  todayISO_MYT, weekStartISO_MYT, mytDayBoundsUTC, mytWeekStartBoundUTC,
  MAIN_MENU_KEYBOARD, BOT_GUIDE_TEXT,
} = require('../lib/bot');

// --- todayISO_MYT / weekStartISO_MYT (pure date math) ---

test('todayISO_MYT: a UTC time landing before MYT midnight (UTC 16:00) stays on the same MYT day', () => {
  const t = Date.parse('2024-01-01T15:59:00Z');
  assert.strictEqual(todayISO_MYT(t), '2024-01-01');
});

test('todayISO_MYT: UTC 16:00 IS the MYT midnight boundary — rolls over to the next MYT day', () => {
  const t = Date.parse('2024-01-01T16:00:00Z');
  assert.strictEqual(todayISO_MYT(t), '2024-01-02');
});

test('weekStartISO_MYT: a Monday in MYT returns itself', () => {
  const t = Date.parse('2024-01-01T04:00:00Z'); // 2024-01-01 is a real Monday; MYT = noon, still Jan 1
  assert.strictEqual(todayISO_MYT(t), '2024-01-01');
  assert.strictEqual(weekStartISO_MYT(t), '2024-01-01');
});

test('weekStartISO_MYT: a Thursday in MYT rolls back to that week\'s Monday', () => {
  const t = Date.parse('2024-01-03T20:00:00Z'); // +8h -> 2024-01-04T04:00 MYT = Thursday
  assert.strictEqual(todayISO_MYT(t), '2024-01-04');
  assert.strictEqual(weekStartISO_MYT(t), '2024-01-01');
});

test('weekStartISO_MYT: Sunday (the dow===0 edge case) rolls back 6 days to Monday', () => {
  const t = Date.parse('2024-01-06T20:00:00Z'); // +8h -> 2024-01-07T04:00 MYT = Sunday
  assert.strictEqual(todayISO_MYT(t), '2024-01-07');
  assert.strictEqual(weekStartISO_MYT(t), '2024-01-01');
});

// --- mytDayBoundsUTC / mytWeekStartBoundUTC (the created_at query-bound helpers) ---

test('mytDayBoundsUTC: MYT midnight for a given day is UTC 16:00 the PREVIOUS day, and the window is exactly 24h', () => {
  const t = Date.parse('2024-01-01T15:59:00Z'); // still 2024-01-01 in MYT (just before rollover)
  const { startUTC, endUTC } = mytDayBoundsUTC(t);
  assert.strictEqual(startUTC, '2023-12-31T16:00:00.000Z', 'MYT midnight on Jan 1 = UTC 16:00 on Dec 31');
  assert.strictEqual(endUTC, '2024-01-01T16:00:00.000Z');
  assert.strictEqual(Date.parse(endUTC) - Date.parse(startUTC), 24 * 3600 * 1000);
});

test('mytDayBoundsUTC: a timestamp right at the UTC 16:00 boundary belongs to the NEXT MYT day\'s bounds', () => {
  const t = Date.parse('2024-01-01T16:00:00Z'); // exactly MYT midnight on Jan 2
  const { startUTC } = mytDayBoundsUTC(t);
  assert.strictEqual(startUTC, '2024-01-01T16:00:00.000Z');
});

test('mytWeekStartBoundUTC: matches mytDayBoundsUTC\'s start for the Monday of that MYT week', () => {
  const t = Date.parse('2024-01-03T20:00:00Z'); // MYT Thursday, Jan 4
  const weekStart = mytWeekStartBoundUTC(t);
  const mondayBounds = mytDayBoundsUTC(Date.parse('2024-01-01T04:00:00Z')); // MYT Monday, Jan 1
  assert.strictEqual(weekStart, mondayBounds.startUTC, 'the week boundary must line up exactly with that Monday\'s day-start boundary');
});

// --- handleTodayBills ---

function baseDeps(over = {}) {
  const sent = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgAnswerCallback: async () => {},
    sbSelect: async () => [],
    todayISO: () => '2026-07-04',
    weekStartISO: () => '2026-06-29',
    // BUG FIX 2026-07-04: Today/Weekly filter by created_at (capture time), not
    // expense_date (the date printed on the receipt) — see lib/bot.js's fix note.
    dayBounds: () => ({ startUTC: '2026-07-03T16:00:00.000Z', endUTC: '2026-07-04T16:00:00.000Z' }),
    weekStartBoundUTC: () => '2026-06-28T16:00:00.000Z',
    ...over,
  };
  return { deps, sent };
}

test('handleTodayBills: empty -> friendly "nothing yet" message, no keyboard', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleTodayBills(1, deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /nothing captured yet today/i);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('handleTodayBills: lists each bill and gives every one its own delete-ask button', async () => {
  const eqSeen = [];
  const rows = [
    { id: 'e1', merchant: 'Shell', amount: 50, currency: 'MYR', category: 'Fuel & Auto' },
    { id: 'e2', merchant: 'Starbucks', amount: 12, currency: 'MYR', category: 'Meals & Entertainment' },
  ];
  const { deps, sent } = baseDeps({
    sbSelect: async (table, opts) => { eqSeen.push(opts); return rows; },
  });
  await handleTodayBills(100, deps);
  // BUG FIX 2026-07-04: must scope by created_at (capture time), NOT expense_date (the
  // date printed on the receipt) — a receipt dated weeks ago but uploaded today must
  // still show up. Live QA caught the old expense_date-based version missing exactly this.
  assert.match(eqSeen[0].extra, /created_at=gte\..*created_at=lt\./, 'scoped to the MYT-today created_at window, not expense_date');
  assert.ok(!/expense_date=/.test(eqSeen[0].extra), 'must NOT filter by expense_date (the printed date), only by created_at (capture time)');
  assert.match(sent[0].text, /Shell/);
  assert.match(sent[0].text, /Starbucks/);
  const btns = sent[0].replyMarkup.inline_keyboard.flat();
  assert.strictEqual(btns.length, 2);
  assert.strictEqual(btns[0].callback_data, 'delask:e1');
  assert.strictEqual(btns[1].callback_data, 'delask:e2');
});

test('handleTodayBills: a receipt CAPTURED today but PRINTED-dated weeks ago still shows up (the exact live-QA bug: 4 receipts uploaded today, all dated March-June, invisible under the old expense_date filter)', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ id: 'e9', merchant: 'Safeguards', amount: 449, currency: 'MYR', category: 'Bank & Fees', expense_date: '2026-05-14' }],
  });
  await handleTodayBills(1, deps);
  assert.match(sent[0].text, /Safeguards/, 'must list a receipt captured today regardless of its printed expense_date');
  assert.ok(!/Nothing captured yet today/i.test(sent[0].text));
});

test('handleTodayBills: a lookup failure never throws, safe reply, no internals leak', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5 internal'); } });
  await assert.doesNotReject(() => handleTodayBills(1, deps));
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(sent[0].text));
});

// --- handleTodayExpenses / handleWeeklyRecord ---

test('handleTodayExpenses: sums today\'s bills into one total', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ amount: 10, currency: 'MYR' }, { amount: 20, currency: 'MYR' }],
  });
  await handleTodayExpenses(1, deps);
  assert.match(sent[0].text, /2 bills/);
  assert.match(sent[0].text, /30/);
});

test('handleWeeklyRecord: queries created_at from Monday\'s MYT midnight onward (NOT expense_date) and sums the total', async () => {
  const eqSeen = [];
  const { deps, sent } = baseDeps({
    sbSelect: async (table, opts) => { eqSeen.push(opts); return [{ amount: 100, currency: 'MYR' }]; },
  });
  await handleWeeklyRecord(1, deps);
  assert.match(eqSeen[0].extra, /created_at=gte\./);
  assert.ok(!/expense_date=/.test(eqSeen[0].extra), 'must NOT filter by expense_date — a receipt captured this week but dated earlier must still count');
  assert.match(sent[0].text, /100/);
});

test('handleWeeklyRecord: a receipt CAPTURED this week but PRINTED-dated months ago still counts (the exact bug scenario)', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ amount: 449, currency: 'MYR', expense_date: '2026-05-14' }], // printed date is old; captured this week
  });
  await handleWeeklyRecord(1, deps);
  assert.match(sent[0].text, /449/, 'a receipt with an old printed date must still be counted, since it was captured this week');
});

// --- Text-routing priority + /start keyboard ---

test('handleUpdate: CRITICAL — the menu button labels route correctly and take priority over the generic expense-keyword regex', async () => {
  let which = null;
  const deps = {
    sbSelect: async () => [],
    handleTodayBills: async () => { which = 'bills'; },
    handleTodayExpenses: async () => { which = 'expenses'; },
    handleWeeklyRecord: async () => { which = 'weekly'; },
  };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '📋 Today Bills' } }, deps);
  assert.strictEqual(which, 'bills');
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '💰 Today Expenses' } }, deps);
  assert.strictEqual(which, 'expenses', '"Today Expenses" must NOT fall into the generic sendExpenseSummary path');
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '📅 Weekly Record' } }, deps);
  assert.strictEqual(which, 'weekly');
});

test('handleUpdate: "🧭 Bot Guide" sends the static guide text', async () => {
  const sent = [];
  const deps = { sbSelect: async () => [], tgSend: async (chatId, text) => { sent.push(text); } };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '🧭 Bot Guide' } }, deps);
  assert.strictEqual(sent[0], BOT_GUIDE_TEXT);
});

test('handleUpdate: /start attaches the persistent menu keyboard', async () => {
  const sent = [];
  const deps = { sbSelect: async () => [], tgSend: async (chatId, text, replyMarkup) => { sent.push({ text, replyMarkup }); } };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '/start' } }, deps);
  assert.deepStrictEqual(sent[0].replyMarkup, MAIN_MENU_KEYBOARD);
});

// --- 2026-07-20 (owner-requested reversal): the acc8146 "resend the menu keyboard on every
// reply" nudge is REMOVED. is_persistent:true (see MAIN_MENU_KEYBOARD) already keeps PC/Web
// clients from collapsing the bar to an icon; resending it here on every reply was ALSO
// forcing it back open any time a user manually collapsed it — reported as "the menu keeps
// appearing on PC and won't stay closed". /start and genuine keyboard-shape changes (Staff
// Lock on/off) still resend it; these routine replies must NOT. ---

test('handleTodayExpenses: does NOT re-attach the menu keyboard (must stay collapsible on PC)', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ amount: 10, currency: 'MYR' }],
  });
  await handleTodayExpenses(1, deps);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('handleWeeklyRecord: does NOT re-attach the menu keyboard', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ amount: 100, currency: 'MYR' }],
  });
  await handleWeeklyRecord(1, deps);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('handleUpdate: "🧭 Bot Guide" does NOT re-attach the menu keyboard', async () => {
  const sent = [];
  const deps = { sbSelect: async () => [], tgSend: async (chatId, text, replyMarkup) => { sent.push({ text, replyMarkup }); } };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: '🧭 Bot Guide' } }, deps);
  assert.strictEqual(sent[0].text, BOT_GUIDE_TEXT);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

test('handleUpdate: the "didn\'t catch that" fallback does NOT re-attach the menu keyboard', async () => {
  const sent = [];
  const deps = { sbSelect: async () => [], tgSend: async (chatId, text, replyMarkup) => { sent.push({ text, replyMarkup }); } };
  await handleUpdate({ message: { chat: { id: 1 }, from: { first_name: 'A' }, text: 'blah blah unrecognised' } }, deps);
  assert.strictEqual(sent[0].replyMarkup, undefined);
});

// Issue #162 D12 (live QA): the menu only showed on mobile, not Telegram Desktop/Web.
// Without is_persistent:true, non-mobile clients collapse a ReplyKeyboardMarkup behind
// an icon the user must tap; mobile shows it automatically. is_persistent:true closes
// that gap by requesting every client keep it visible.
test('MAIN_MENU_KEYBOARD: is_persistent is set so PC/web clients show it too, not just mobile', () => {
  assert.strictEqual(MAIN_MENU_KEYBOARD.is_persistent, true);
  assert.strictEqual(MAIN_MENU_KEYBOARD.resize_keyboard, true, 'unchanged existing behaviour');
});
