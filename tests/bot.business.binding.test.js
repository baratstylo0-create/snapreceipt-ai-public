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
  // sbSelectGlobal (2026-08-22): bindWithToken's own token lookup now goes through
  // sbSelectGlobal, not sbSelect (see lib/supabase.js's doc comment). Mirroring whatever
  // `sbSelect` override a test passes keeps every existing token-lookup scenario working
  // without touching each call site individually.
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  return {
    deps: {
      tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
      tgAnswerCallback: async (id) => { answered.push(id); },
      sbSelect: async () => [],
      sbSelectGlobal: async () => [],
      sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); return []; },
      getCapabilities: () => ({ multiUser: true }),
      ...resolvedOver,
    },
    sent, answered, updates,
  };
}

const msgUpdate = (chatId, text) => ({ message: { chat: { id: chatId }, from: { first_name: 'A' }, text } });

// --- resolveBinding -----------------------------------------------------------------

test('resolveBinding: returns the active bot_bindings row for this chat', async () => {
  const row = { id: 'b1', chat_id: '100', branch_id: 'br-A', role: 'clerk', active: true };
  const seen = [];
  const binding = await resolveBinding(100, { sbSelectGlobal: async (table, opts) => { seen.push({ table, opts }); return [row]; } });
  assert.deepStrictEqual(binding, row);
  assert.strictEqual(seen[0].table, 'bot_bindings');
  assert.deepStrictEqual(seen[0].opts.eq, { chat_id: '100', active: true });
});

test('resolveBinding: returns null when no active binding exists', async () => {
  const binding = await resolveBinding(999, { sbSelectGlobal: async () => [] });
  assert.strictEqual(binding, null);
});

test('resolveBinding: fails CLOSED (returns null, never throws) on a lookup error', async () => {
  const binding = await resolveBinding(1, { sbSelectGlobal: async () => { throw new Error('ECONNREFUSED internal'); } });
  assert.strictEqual(binding, null);
});

// --- 30-day inactivity auto-unbind (2026-08-08) — scoped to role==='owner' ONLY ------

test('resolveBinding: a stale (31+ days inactive) OWNER binding is auto-unbound (clears chat_id, returns null)', async () => {
  const staleAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const row = { id: 'ownerBind1', chat_id: '100', role: 'owner', active: true, last_active_at: staleAt };
  const updates = [];
  const binding = await resolveBinding(100, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.strictEqual(binding, null);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].where.id, 'ownerBind1');
  assert.strictEqual(updates[0].patch.chat_id, null);
});

test('resolveBinding: a RECENTLY active owner binding (within 30 days) is returned normally, not unbound', async () => {
  const recentAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const row = { id: 'ownerBind2', chat_id: '100', role: 'owner', active: true, last_active_at: recentAt };
  const updates = [];
  const binding = await resolveBinding(100, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.deepStrictEqual(binding, row);
  assert.strictEqual(updates.length, 0);
});

test('resolveBinding: a stale BUSINESS (clerk) binding is NEVER auto-unbound — business behavior is byte-for-byte unchanged', async () => {
  const staleAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // over a year inactive
  const row = { id: 'clerkBind1', chat_id: '100', branch_id: 'br-A', role: 'clerk', active: true, last_active_at: staleAt };
  const updates = [];
  const binding = await resolveBinding(100, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.deepStrictEqual(binding, row);
  assert.strictEqual(updates.length, 0, 'business bindings must never be auto-unbound by the inactivity check');
});

test('resolveBinding: a stale GUEST binding is NEVER auto-unbound by the inactivity check (guest cleanup is a separate mechanism)', async () => {
  const staleAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const row = { id: 'guestBind1', chat_id: '100', role: 'guest', active: true, last_active_at: staleAt };
  const updates = [];
  const binding = await resolveBinding(100, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.deepStrictEqual(binding, row);
  assert.strictEqual(updates.length, 0);
});

// --- bindWithToken -------------------------------------------------------------------

test('bindWithToken: a valid, unbound token binds this chat and returns the role', async () => {
  const updates = [];
  const row = { id: 'bind1', bind_token: 'tok123', role: 'clerk', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const deps = {
    sbSelectGlobal: async () => [row],
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
  const result = await bindWithToken('tokA', 1, { sbSelectGlobal: async () => [row], sbUpdate: async () => {} });
  assert.strictEqual(result.role, 'admin');
});

test('bindWithToken: re-tapping the SAME chat\'s already-bound token is a harmless no-op (idempotent)', async () => {
  const updates = [];
  const row = { id: 'bind3', bind_token: 'tok3', role: 'clerk', chat_id: '555', active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const result = await bindWithToken('tok3', 555, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alreadyBound, true);
  assert.strictEqual(updates.length, 0, 'must not re-issue an update for an already-bound re-tap');
});

test('bindWithToken: a token already bound to a DIFFERENT chat is refused (used up)', async () => {
  const row = { id: 'bind4', bind_token: 'tok4', role: 'clerk', chat_id: '111', active: true,
    token_expires_at: new Date(Date.now() + 60000).toISOString() };
  const result = await bindWithToken('tok4', 222, { sbSelectGlobal: async () => [row] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /already been used/i);
});

test('bindWithToken: an expired BUSINESS (clerk) token is still refused (2026-08-08 fix is scoped to owner only)', async () => {
  const row = { id: 'bind5', bind_token: 'tok5', role: 'clerk', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() - 1000).toISOString() };
  const result = await bindWithToken('tok5', 1, { sbSelectGlobal: async () => [row] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /expired/i);
});

test('bindWithToken: an expired token is NOT enforced for a personal OWNER binding (2026-08-08 — connect links are permanent for owners)', async () => {
  const row = { id: 'bind5b', bind_token: 'tok5b', role: 'owner', chat_id: null, active: true,
    token_expires_at: new Date(Date.now() - 1000).toISOString() };
  const updates = [];
  const result = await bindWithToken('tok5b', 1, {
    sbSelectGlobal: async () => [row],
    sbUpdate: async (table, where, patch) => { updates.push({ table, where, patch }); },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].patch.chat_id, '1');
  assert.ok(updates[0].patch.last_active_at, 'owner binds should stamp last_active_at for the 30-day inactivity clock');
});

test('bindWithToken: an unknown token is refused', async () => {
  const result = await bindWithToken('nope', 1, { sbSelectGlobal: async () => [] });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /isn't valid|not valid/i);
});

test('bindWithToken: empty/missing token is refused without a lookup', async () => {
  const result = await bindWithToken('', 1, { sbSelectGlobal: async () => { throw new Error('should not be called'); } });
  assert.strictEqual(result.ok, false);
});

test('bindWithToken: a lookup error never throws, friendly message', async () => {
  const result = await bindWithToken('tok', 1, { sbSelectGlobal: async () => { throw new Error('ECONNREFUSED 10.0.0.5'); } });
  assert.strictEqual(result.ok, false);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(result.message));
});

// --- guest trial-ended gate (2026-08-22, QA report #3) --------------------------------
// "If user try to chat with bot after their guest mode trial finish, I want bot show
// message (access the app now...) don't reply other than that." Before this fix, only
// the photo-capture path checked the cap; a capped guest's plain text or a stale button
// tap fell through to the normal menu/reply logic.

test('handleUpdate: a guest AT the receipt cap gets ONLY the cap-reached message for a plain text message', async () => {
  const { GUEST_CAP_REACHED_MESSAGE } = require('../lib/ocr');
  const binding = { id: 'g1', chat_id: '500', role: 'guest', user_id: 'guestUser1', active: true };
  const { deps, sent } = baseDeps({
    sbSelectGlobal: async () => [binding],
    countGuestExpenses: async () => 4, // at GUEST_RECEIPT_CAP
  });
  await handleUpdate(msgUpdate(500, 'hi'), deps);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, GUEST_CAP_REACHED_MESSAGE);
});

test('handleUpdate: a guest AT the receipt cap gets ONLY the cap-reached message for a callback-query button tap', async () => {
  const { GUEST_CAP_REACHED_MESSAGE } = require('../lib/ocr');
  const binding = { id: 'g2', chat_id: '501', role: 'guest', user_id: 'guestUser2', active: true };
  const { deps, sent, answered } = baseDeps({
    sbSelectGlobal: async () => [binding],
    countGuestExpenses: async () => 5, // over cap
  });
  await handleUpdate({ callback_query: { id: 'cq1', message: { chat: { id: 501 } }, data: 'anything' } }, deps);
  assert.deepStrictEqual(answered, ['cq1']);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, GUEST_CAP_REACHED_MESSAGE);
});

test('handleUpdate: a guest UNDER the cap is routed normally, not gated', async () => {
  const binding = { id: 'g3', chat_id: '502', role: 'guest', user_id: 'guestUser3', active: true };
  const { deps, sent } = baseDeps({
    sbSelectGlobal: async () => [binding],
    countGuestExpenses: async () => 2, // under GUEST_RECEIPT_CAP (4)
  });
  await handleUpdate(msgUpdate(502, 'hi'), deps);
  // Not gated: falls through to the normal (non-cap) reply, whatever that is — just
  // confirming it's NOT the cap-reached message and the guest cap check didn't short-circuit.
  const { GUEST_CAP_REACHED_MESSAGE } = require('../lib/ocr');
  assert.ok(!sent.some((s) => s.text === GUEST_CAP_REACHED_MESSAGE));
});

test('handleUpdate: an OWNER binding is never subject to the guest cap check (countGuestExpenses not called)', async () => {
  const binding = { id: 'o1', chat_id: '503', role: 'owner', user_id: 'ownerUser1', active: true };
  let capCheckCalled = false;
  const { deps, sent } = baseDeps({
    sbSelectGlobal: async () => [binding],
    countGuestExpenses: async () => { capCheckCalled = true; return 99; },
  });
  await handleUpdate(msgUpdate(503, 'hi'), deps);
  assert.strictEqual(capCheckCalled, false);
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
  // This test sends "🧭 Bot Guide" (not an expense-keyword message), so sendExpenseSummary
  // (deps-injectable since 2026-08-21, see its own bug-fix comment in lib/bot.js) is never
  // actually reached here — assert via the reply path instead: the point is the message
  // reaches PAST the unbound-gate (no BUSINESS_UNBOUND_MESSAGE sent).
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
