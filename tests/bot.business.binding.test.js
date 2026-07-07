'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// Business-mode identity gate (ADR-021 Phase 5, issue #107): a one-time /start <token>
// deep link binds a Telegram chat to a bot_bindings row (clerk or admin; staff never
// bind). Entirely inert when capabilities.multiUser is off (personal bot unaffected).
// getCapabilities is injected via deps (not real process.env) to keep this hermetic —
// matches the deps-injection convention already used throughout lib/bot.js.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleUpdate, resolveBinding, bindWithToken,
  mytWeekStartSundayBoundUTC, weekStartSundayISO_MYT,
  BUSINESS_WELCOME_ADMIN, BUSINESS_WELCOME_CLERK, BUSINESS_UNBOUND_MESSAGE, MAIN_MENU_KEYBOARD, WELCOME,
} = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const updates = [];
  return {
    deps: {
      tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
      tgAnswerCallback: async (id) => { answered.push(id); },
      sbSelect: async () => [],
      sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); return []; },
      getCapabilities: () => ({ multiUser: true }),
      ...over,
    },
    sent, answered, updates,
  };
}

const msgUpdate = (chatId, text) => ({ message: { chat: { id: chatId }, from: { first_name: 'A' }, text } });

// --- resolveBinding -----------------------------------------------------------------

test('resolveBinding: returns the active bot_bindings row for this chat', async () => {
  const row = { id: 'b1', chat_id: '100', branch_id: 'br-A', role: 'clerk', active: true };
  const seen = [];
  const binding = await resolveBinding(100, { sbSelect: async (table, opts) => { seen.push({ table, opts }); return [row]; } });
  assert.deepStrictEqual(binding, row);
  assert.strictEqual(seen[0].table, 'bot_bindings');
  assert.deepStrictEqual(seen[0].opts.eq, { chat_id: '100', active: true });
});

test('resolveBinding: returns null when no active binding exists', async () => {
  const binding = await resolveBinding(999, { sbSelect: async () => [] });
  assert.strictEqual(binding, null);
});

test('resolveBinding: fails CLOSED (returns null, never throws) on a lookup error', async () => {
  const binding = await resolveBinding(1, { sbSelect: async () => { throw new Error('ECONNREFUSED internal'); } });
  assert.strictEqual(binding, null);
});

// --- bindWithToken -------------------------------------------------------------------

test('bindWithToken: a valid, unbound token binds this chat and returns the role', async () => {
  const updates = [];
  const row = { id: 'bind1', bind_token: 'tok123', role: 'clerk', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const deps = {
    sbSelect: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  };
  const result = await bindWithToken('tok123', 555, deps);
  assert.deepStrictEqual(result, { ok: true, role: 'clerk' });
  assert.strictEqual(updates[0].table, 'bot_bindings');
  assert.strictEqual(updates[0].where.id, 'bind1');
  assert.strictEqual(updates[0].patch.chat_id, '555');
  assert.ok(updates[0].patch.bound_at);
});

test('bindWithToken: an admin token returns role admin', async () => {
  const row = { id: 'bind2', bind_token: 'tokA', role: 'admin', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const result = await bindWithToken('tokA', 1, { sbSelect: async () => [row], sbUpdate: async () => {} });
  assert.strictEqual(result.role, 'admin');
});

test('bindWithToken: re-tapping the SAME chat\'s already-bound token is a harmless no-op (idempotent)', async () => {
  const updates = [];
  const row = { id: 'bind3', bind_token: 'tok3', role: 'clerk', chat_id: '555', active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const result = await bindWithToken('tok3', 555, {
    sbSelect: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alreadyBound, true);
  assert.strictEqual(updates.length, 0, 'must not re-issue an update for an already-bound re-tap');
});

test('bindWithToken: a token already bound to a DIFFERENT chat is refused (used up)', async () => {
  const row = { id: 'bind4', bind_token: 'tok4', role: 'clerk', chat_id: '111', active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const result = await bindWithToken('tok4', 222, { sbSelect: async () => [row] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /already been used/i);
});

test('bindWithToken: an expired token is refused', async () => {
  const row = { id: 'bind5', bind_token: 'tok5', role: 'clerk', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() - 1000).toISOString() };
  const result = await bindWithToken('tok5', 1, { sbSelect: async () => [row] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /expired/i);
});

test('bindWithToken: an unknown token is refused', async () => {
  const result = await bindWithToken('nope', 1, { sbSelect: async () => [] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /isn't valid|not valid/i);
});

test('bindWithToken: empty/missing token is refused without a lookup', async () => {
  const result = await bindWithToken('', 1, { sbSelect: async () => { throw new Error('should not be called'); } });
  assert.strictEqual(result.ok, false);
});

test('bindWithToken: a lookup error never throws, friendly message', async () => {
  const result = await bindWithToken('tok', 1, { sbSelect: async () => { throw new Error('ECONNREFUSED 10.0.0.5'); } });
  assert.strictEqual(result.ok, false);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(result.message));
});

// --- handleUpdate: the business-mode gate ---------------------------------------------

test('handleUpdate: multiUser OFF -> /start shows the PERSONAL welcome, unchanged (zero regression)', async () => {
  const { deps, sent } = baseDeps({ getCapabilities: () => ({ multiUser: false }) });
  await handleUpdate(msgUpdate(1, '/start'), deps);
  assert.strictEqual(sent[0].text, WELCOME);
  assert.deepStrictEqual(sent[0].replyMarkup, MAIN_MENU_KEYBOARD);
});

test('handleUpdate: multiUser ON, /start <token> with a valid clerk token -> business welcome + binds', async () => {
  const row = { id: 'bindX', bind_token: 'abc', role: 'clerk', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const { deps, sent, updates } = baseDeps({ sbSelect: async () => [row] });
  await handleUpdate(msgUpdate(42, '/start abc'), deps);
  assert.strictEqual(sent[0].text, BUSINESS_WELCOME_CLERK);
  assert.strictEqual(updates[0].patch.chat_id, '42');
});

test('handleUpdate: multiUser ON, /start <token> with a valid admin token -> admin business welcome', async () => {
  const row = { id: 'bindY', bind_token: 'xyz', role: 'admin', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const { deps, sent } = baseDeps({ sbSelect: async () => [row] });
  await handleUpdate(msgUpdate(7, '/start xyz'), deps);
  assert.strictEqual(sent[0].text, BUSINESS_WELCOME_ADMIN);
});

test('handleUpdate: multiUser ON, /start with a bad token -> friendly error, no crash', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate(msgUpdate(1, '/start badtoken'), deps);
  assert.match(sent[0].text, /isn't valid|not valid/i);
});

test('handleUpdate: multiUser ON, bare /start (no token) from an UNBOUND chat -> the business unbound message, NOT the personal welcome', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] }); // no binding found
  await handleUpdate(msgUpdate(1, '/start'), deps);
  assert.strictEqual(sent[0].text, BUSINESS_UNBOUND_MESSAGE);
});

test('handleUpdate: multiUser ON, ANY text from an unbound chat is refused before normal routing', async () => {
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  await handleUpdate(msgUpdate(1, 'show expenses'), deps);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, BUSINESS_UNBOUND_MESSAGE);
});

test('handleUpdate: multiUser ON, an unbound chat\'s callback-query tap is silently answered, never routed to handleCallbackQuery', async () => {
  let cqRouted = false;
  const { deps, answered } = baseDeps({
    sbSelect: async () => [],
    handleCallbackQuery: async () => { cqRouted = true; },
  });
  await handleUpdate({ callback_query: { id: 'cq1', message: { chat: { id: 1 } }, data: 'del:e1' } }, deps);
  assert.strictEqual(cqRouted, false);
  assert.deepStrictEqual(answered, ['cq1']);
});

test('handleUpdate: multiUser ON, a BOUND chat falls through to normal routing (e.g. "show expenses" still works)', async () => {
  const binding = { id: 'bindZ', chat_id: '1', branch_id: 'br-A', role: 'clerk', active: true };
  let summarized = false;
  const { deps, sent } = baseDeps({
    sbSelect: async () => [binding],
    sendExpenseSummary: async () => { summarized = true; },
  });
  // sendExpenseSummary is called directly (not injected) inside handleUpdate's generic
  // keyword branch in the real module, so assert via the reply path instead — the point is
  // the message reaches PAST the unbound-gate (no BUSINESS_UNBOUND_MESSAGE sent).
  await handleUpdate(msgUpdate(1, '🧭 Bot Guide'), deps);
  assert.notStrictEqual(sent[0].text, BUSINESS_UNBOUND_MESSAGE);
});

// --- Sunday-start week math (business only; personal Monday-start is untouched) --------

test('weekStartSundayISO_MYT: a Sunday in MYT returns itself', () => {
  const t = Date.parse('2024-01-06T20:00:00Z'); // +8h -> 2024-01-07T04:00 MYT = Sunday
  assert.strictEqual(weekStartSundayISO_MYT(t), '2024-01-07');
});

test('weekStartSundayISO_MYT: a Thursday in MYT rolls back to that week\'s Sunday', () => {
  const t = Date.parse('2024-01-03T20:00:00Z'); // +8h -> 2024-01-04T04:00 MYT = Thursday
  assert.strictEqual(weekStartSundayISO_MYT(t), '2023-12-31', 'the Sunday before Thu Jan 4 2024 is Dec 31 2023');
});

test('mytWeekStartSundayBoundUTC: lines up with the Sunday day-start boundary', () => {
  const t = Date.parse('2024-01-03T20:00:00Z'); // MYT Thursday, Jan 4
  const weekStart = mytWeekStartSundayBoundUTC(t);
  // 2023-12-31 MYT midnight == UTC 2023-12-30T16:00:00.000Z
  assert.strictEqual(weekStart, '2023-12-30T16:00:00.000Z');
});
