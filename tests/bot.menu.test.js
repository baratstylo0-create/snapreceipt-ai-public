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
  todayISO_MYT, weekStartISO_MYT, MAIN_MENU_KEYBOARD, BOT_GUIDE_TEXT,
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

// --- handleTodayBills ---

function baseDeps(over = {}) {
  const sent = [];
  const deps = {
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgAnswerCallback: async () => {},
    sbSelect: async () => [],
    todayISO: () => '2026-07-04',
    weekStartISO: () => '2026-06-29',
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
  assert.match(eqSeen[0].extra, /expense_date=eq\.2026-07-04/, 'scoped to MYT today');
  assert.match(sent[0].text, /Shell/);
  assert.match(sent[0].text, /Starbucks/);
  const btns = sent[0].replyMarkup.inline_keyboard.flat();
  assert.strictEqual(btns.length, 2);
  assert.strictEqual(btns[0].callback_data, 'delask:e1');
  assert.strictEqual(btns[1].callback_data, 'delask:e2');
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

test('handleWeeklyRecord: queries a gte/lte date range (Monday to today) and sums the total', async () => {
  const eqSeen = [];
  const { deps, sent } = baseDeps({
    sbSelect: async (table, opts) => { eqSeen.push(opts); return [{ amount: 100, currency: 'MYR' }]; },
  });
  await handleWeeklyRecord(1, deps);
  assert.match(eqSeen[0].extra, /expense_date=gte\.2026-06-29/);
  assert.match(eqSeen[0].extra, /expense_date=lte\.2026-07-04/);
  assert.match(sent[0].text, /100/);
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
