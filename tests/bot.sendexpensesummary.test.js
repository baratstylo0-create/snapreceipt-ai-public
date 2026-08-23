'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// 2026-08-21 bug fix: sendExpenseSummary (the "show expenses" free-text reply) had NO
// deleted_at or status filter at all — every sibling summary function in lib/bot.js
// (handleTodayBills/handleTodayExpenses/handleWeeklyRecord) already excludes soft-deleted rows,
// this one never did. Confirmed live: a real bot chat got back old soft-deleted test receipts
// mixed into "Recent Expenses", with a wrong total. Fixed to match the sibling pattern exactly
// (deleted_at=is.null&status=neq.rejected, plus guestVisibilityExtra like every sibling has).
const { test } = require('node:test');
const assert = require('node:assert');
const { sendExpenseSummary } = require('../lib/bot');

test('sendExpenseSummary: query excludes soft-deleted rows and rejected status', async () => {
  const sent = [];
  let captured = null;
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    sbSelect: async (table, opts) => { captured = { table, opts }; return []; },
  };
  await sendExpenseSummary('123', deps, null);
  assert.strictEqual(captured.table, 'expenses');
  assert.match(captured.opts.extra, /deleted_at=is\.null/);
  assert.match(captured.opts.extra, /status=neq\.rejected/);
});

test('sendExpenseSummary: soft-deleted rows never reach the reply text or the total (real regression case)', async () => {
  const sent = [];
  // A stub that actually HONORS the filter (mirrors how PostgREST/sbSelect really behaves) —
  // proves the fix is effective end-to-end, not just that the right string was sent.
  const ALL_ROWS = [
    { id: 'e1', merchant: 'Real Receipt A', amount: 100, currency: 'MYR', category: 'Food', deleted_at: null, status: 'saved' },
    { id: 'e2', merchant: 'Real Receipt B', amount: 101.65, currency: 'MYR', category: 'Food', deleted_at: null, status: 'saved' },
    { id: 'e3', merchant: 'Delete Test Receipt', amount: 999, currency: 'MYR', category: 'Food', deleted_at: '2026-07-01T00:00:00Z', status: 'saved' },
    { id: 'e4', merchant: '🎉🔥 Node Test Cafe ☕', amount: 500, currency: 'MYR', category: 'Food', deleted_at: '2026-07-02T00:00:00Z', status: 'saved' },
  ];
  const deps = {
    tgSend: async (chatId, text) => { sent.push({ chatId, text }); },
    sbSelect: async (table, opts) => {
      // A crude but faithful stand-in for what deleted_at=is.null&status=neq.rejected would
      // actually filter server-side, driven by the SAME extra string the fix sends.
      const wantsNotDeleted = /deleted_at=is\.null/.test(opts.extra || '');
      const wantsNotRejected = /status=neq\.rejected/.test(opts.extra || '');
      return ALL_ROWS.filter((r) =>
        (!wantsNotDeleted || !r.deleted_at) && (!wantsNotRejected || r.status !== 'rejected'));
    },
  };
  await sendExpenseSummary('123', deps, null);
  assert.strictEqual(sent.length, 1);
  const text = sent[0].text;
  assert.ok(!text.includes('Delete Test Receipt'), 'a soft-deleted row must never appear in the summary');
  assert.ok(!text.includes('Node Test Cafe'), 'a soft-deleted row must never appear in the summary');
  assert.match(text, /Real Receipt A/);
  assert.match(text, /Real Receipt B/);
  // 100 + 101.65 = 201.65 — the deleted 999/500 rows must NOT be folded into the total.
  assert.match(text, /201\.65/);
  assert.ok(!text.includes('1701.65'), 'must not silently include the deleted rows in the total');
});

test('sendExpenseSummary: guest binding gets guestVisibilityExtra folded in, same as every sibling summary function', async () => {
  let captured = null;
  const deps = {
    tgSend: async () => {},
    sbSelect: async (table, opts) => { captured = opts; return []; },
  };
  await sendExpenseSummary('123', deps, { role: 'guest', user_id: 'u-guest-1' });
  assert.match(captured.extra, /owner_user_id=eq\.u-guest-1/);
});
