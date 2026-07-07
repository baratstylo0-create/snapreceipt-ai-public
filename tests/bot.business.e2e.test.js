'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist
// END-TO-END business-bot flow (ADR-021 Phase 5, issue #107). Unlike the per-feature unit
// tests, this drives the REAL handleUpdate / handleCallbackQuery / resolveBinding /
// bindWithToken / sendStaffPicker / handleTodayBills through ONE shared in-memory store —
// the whole conversation wired together, the way production wires it. The point is to
// prove the SECURITY-CRITICAL guarantees hold when the pieces run as a system:
//   1. an unbound chat can do NOTHING (no bind, no receipt, no menu, no button);
//   2. a one-time link binds a chat to a branch/role and is then used up;
//   3. a clerk NEVER sees another branch's receipts (branch isolation);
//   4. an admin sees every branch;
//   5. the personal bot (flag off) is byte-for-byte unaffected.
// No network, no real Telegram, no real Supabase — but every branch decision is the
// production code path, not a re-implementation.
const { test } = require('node:test');
const assert = require('node:assert');
const bot = require('../lib/bot');

// --- a tiny in-memory Supabase that behaves like lib/supabase's sbSelect/sbUpdate/insert -
// Rows are plain objects; sbSelect filters by every key in `eq` (+ a minimal created_at
// range parse from `extra`, since handleTodayBills scopes the day that way). This is the
// same contract the real REST helpers honour; nothing here is bot-specific logic.
function makeDb(seed = {}) {
  const tables = { bot_bindings: [], expenses: [], field_templates: [], ...seed };
  function matchesExtra(row, extra) {
    if (!extra) return true;
    if (/deleted_at=is\.null/.test(extra) && row.deleted_at) return false;
    const gte = /created_at=gte\.([^&]+)/.exec(extra);
    const lt = /created_at=lt\.([^&]+)/.exec(extra);
    if (gte && !(String(row.created_at) >= decodeURIComponent(gte[1]))) return false;
    if (lt && !(String(row.created_at) < decodeURIComponent(lt[1]))) return false;
    return true;
  }
  return {
    tables,
    sbSelect: async (table, opts = {}) => {
      const eq = opts.eq || {};
      let rows = (tables[table] || []).filter(r =>
        Object.keys(eq).every(k => String(r[k]) === String(eq[k])) && matchesExtra(r, opts.extra));
      if (typeof opts.limit === 'number') rows = rows.slice(0, opts.limit);
      return rows.map(r => ({ ...r }));
    },
    sbUpdate: async (table, where, patch) => {
      const row = (tables[table] || []).find(r => String(r.id) === String(where.id));
      if (row) Object.assign(row, patch);
      return row ? [{ ...row }] : [];
    },
    sbInsert: async (table, row) => { (tables[table] = tables[table] || []).push({ ...row }); return [{ ...row }]; },
  };
}

// A shared deps object bound to one db, plus a transcript of everything the bot "sent".
function harness({ multiUser = true, staffByBranch = {}, db = makeDb() } = {}) {
  const sent = [];   // { chatId, text, replyMarkup }
  const answered = [];
  let expenseSeq = 0;

  const deps = {
    // capability flag — the ONLY thing that turns business mode on
    getCapabilities: () => ({ multiUser }),
    // real DB
    sbSelect: db.sbSelect, sbUpdate: db.sbUpdate, sbInsert: db.sbInsert,
    // Telegram sink
    tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
    tgEditMessage: async (chatId, messageId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup, edited: true }); },
    tgAnswerCallback: async (id, opts) => { answered.push({ id, opts }); },
    // the branch staff directory (Jeevan's lib/branches.listStaff in prod; injected here)
    listStaff: async (branchId) => staffByBranch[branchId] || [],
    // OCR is out of scope for this flow test: a photo deterministically "reads" into a saved
    // expense row, stamped with whatever branch meta handleUpdate passes down. This mirrors
    // assembleExpense's real contract (stamp branch_id only when supplied) without a Groq call.
    expenseFromPhoto: async (chatId, repName, fileId, meta) => {
      const id = 'exp-' + (++expenseSeq);
      const row = {
        id, rep_chat_id: String(chatId), merchant: 'Shop ' + expenseSeq, amount: 10 * expenseSeq,
        currency: 'MYR', category: 'Groceries', created_at: new Date().toISOString(), deleted_at: null,
        ...(meta && meta.branch_id ? { branch_id: meta.branch_id } : {}),
      };
      await db.sbInsert('expenses', row);
      return { ok: true, expense: row };
    },
    // day bounds wide open so the seeded created_at always falls "today" for the scope test
    dayBounds: () => ({ startUTC: '1970-01-01T00:00:00.000Z', endUTC: '2999-01-01T00:00:00.000Z' }),
    todayISO: () => '2026-07-07',
  };
  return { deps, db, sent, answered, last: () => sent[sent.length - 1] };
}

const msg = (chatId, text) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' + chatId }, text } });
const photo = (chatId) => ({ message: { chat: { id: chatId }, from: { first_name: 'U' + chatId }, photo: [{ file_id: 's' }, { file_id: 'big' }] } });
const tap = (chatId, data) => ({ callback_query: { id: 'cq' + chatId, data, message: { chat: { id: chatId }, message_id: 1 } } });

// bot_bindings fixture rows: an unused token per person (chat_id null until bound).
function seedBindings() {
  return [
    { id: 'bk-admin', bind_token: 'TOK-ADMIN', role: 'admin', branch_id: 'HQ', chat_id: null, active: true },
    { id: 'bk-clerkA', bind_token: 'TOK-A', role: 'clerk', branch_id: 'BR-A', chat_id: null, active: true },
    { id: 'bk-clerkB', bind_token: 'TOK-B', role: 'clerk', branch_id: 'BR-B', chat_id: null, active: true },
  ];
}

// =====================================================================================
// THE FULL WALKTHROUGH — one store, one conversation, every real code path.
// =====================================================================================

test('E2E: unbound chat is refused everything; binding works once; branch isolation holds; admin sees all', async () => {
  const db = makeDb({ bot_bindings: seedBindings() });
  const h = harness({
    db,
    staffByBranch: { 'BR-A': [{ id: 's-ali', display_name: 'Ali' }, { id: 's-mei', display_name: 'Mei' }] },
  });

  // --- SECURITY GATE: a stranger (no binding) can do nothing ---------------------------
  await bot.handleUpdate(msg(900, 'hello'), h.deps);
  assert.match(h.last().text, /needs a one-time access link/i, 'unbound text is refused');
  await bot.handleUpdate(photo(900), h.deps);
  assert.match(h.last().text, /needs a one-time access link/i, 'unbound photo is refused — no receipt saved');
  await bot.handleUpdate(tap(900, 'del:whatever'), h.deps);
  assert.strictEqual(h.answered.length, 1, 'unbound button tap is silently acked, never routed');
  assert.strictEqual(db.tables.expenses.length, 0, 'NOTHING was written by the unbound stranger');

  // --- BINDING: each person taps their one-time link -----------------------------------
  await bot.handleUpdate(msg(1, '/start TOK-ADMIN'), h.deps);
  assert.match(h.last().text, /bound as the \*admin\*/i);
  await bot.handleUpdate(msg(2, '/start TOK-A'), h.deps);
  assert.match(h.last().text, /branch clerk/i);
  await bot.handleUpdate(msg(3, '/start TOK-B'), h.deps);
  assert.match(h.last().text, /branch clerk/i);

  // A used link cannot be reused by a DIFFERENT chat (token burned).
  await bot.handleUpdate(msg(999, '/start TOK-A'), h.deps);
  assert.match(h.last().text, /already been used/i, 'clerk A\'s link is used up — a stranger can\'t claim it');

  // --- CAPTURE + STAFF TAG: clerk A sends a receipt ------------------------------------
  await bot.handleUpdate(photo(2), h.deps);            // chat 2 = clerk A @ BR-A
  const aRow = db.tables.expenses.find(e => e.rep_chat_id === '2');
  assert.strictEqual(aRow.branch_id, 'BR-A', 'clerk A\'s receipt is stamped with BR-A automatically');
  assert.match(h.last().text, /Who is this receipt for/i, 'the staff picker followed the save');
  const pick = h.last().replyMarkup.inline_keyboard.flat();
  assert.deepStrictEqual(pick.map(b => b.text), ['Ali', 'Mei']);
  // tap "Mei"
  await bot.handleUpdate(tap(2, pick[1].callback_data), h.deps);
  assert.strictEqual(db.tables.expenses.find(e => e.id === aRow.id).staff_user_id, 's-mei', 'tag saved');

  // --- clerk B sends a receipt (different branch) --------------------------------------
  await bot.handleUpdate(photo(3), h.deps);            // chat 3 = clerk B @ BR-B
  const bRow = db.tables.expenses.find(e => e.rep_chat_id === '3');
  assert.strictEqual(bRow.branch_id, 'BR-B');

  // --- THE ISOLATION PROOF: clerk A's "Today Bills" shows ONLY BR-A --------------------
  h.sent.length = 0;
  await bot.handleUpdate(msg(2, '📋 Today Bills'), h.deps);
  const aView = h.last().text;
  assert.match(aView, /Shop 1/, 'clerk A sees their own BR-A receipt');
  assert.doesNotMatch(aView, /Shop 2/, 'SECURITY: clerk A must NOT see clerk B\'s BR-B receipt');

  // clerk B likewise sees only BR-B
  h.sent.length = 0;
  await bot.handleUpdate(msg(3, '📋 Today Bills'), h.deps);
  assert.match(h.last().text, /Shop 2/);
  assert.doesNotMatch(h.last().text, /Shop 1/, 'SECURITY: clerk B must NOT see clerk A\'s BR-A receipt');

  // --- admin sees EVERY branch --------------------------------------------------------
  h.sent.length = 0;
  await bot.handleUpdate(msg(1, '📋 Today Bills'), h.deps);
  assert.match(h.last().text, /Shop 1/, 'admin sees BR-A');
  assert.match(h.last().text, /Shop 2/, 'admin sees BR-B');
});

test('E2E (regression): with the business flag OFF, the personal bot never binds, never gates', async () => {
  const db = makeDb({ bot_bindings: seedBindings() });
  const h = harness({ multiUser: false, db });

  // A plain chat with NO binding sends a photo -> it just works, no "access link" wall,
  // and the receipt is saved with NO branch stamp (personal path, byte-for-byte).
  await bot.handleUpdate(photo(500), h.deps);
  const row = db.tables.expenses.find(e => e.rep_chat_id === '500');
  assert.ok(row, 'personal photo saved without any binding');
  assert.ok(!('branch_id' in row), 'personal receipts carry no branch_id');
  assert.ok(!h.sent.some(s => /access link/i.test(s.text)), 'personal mode never shows the unbound wall');
  // No staff picker in personal mode.
  assert.ok(!h.sent.some(s => /Who is this receipt for/i.test(s.text)), 'no staff picker in personal mode');
});
