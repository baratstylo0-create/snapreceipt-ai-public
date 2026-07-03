'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tgSend, tgAnswerCallback } = require('../lib/telegram');

// Stub global.fetch (tgSend -> hreq -> fetch). Each call returns the next queued
// Telegram API body; records the request body sent so we can assert parse_mode.
function stubTelegram(responses) {
  const realFetch = global.fetch;
  const calls = [];
  let i = 0;
  global.fetch = async (_url, opt) => {
    calls.push(JSON.parse(opt.body));
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text: async () => JSON.stringify(body) };
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test('the "no reply" bug: a Markdown-rejected message is RESENT as plain text', async () => {
  // 1st send (Markdown) is rejected by Telegram; 2nd send (plain) succeeds.
  const s = stubTelegram([
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    { ok: true, result: { message_id: 1 } },
  ]);
  try {
    await tgSend(42, '✅ *Expense* — Merchant: 7*11 & A_B [store]'); // hostile Markdown chars
    assert.strictEqual(s.calls.length, 2, 'exactly one retry after the rejection');
    assert.strictEqual(s.calls[0].parse_mode, 'Markdown', 'first attempt uses Markdown');
    assert.ok(!('parse_mode' in s.calls[1]), 'retry drops parse_mode → plain text');
    assert.strictEqual(s.calls[1].text, s.calls[0].text, 'same message text, just unstyled');
    assert.strictEqual(s.calls[1].chat_id, 42);
  } finally { s.restore(); }
});

test('a Markdown message that Telegram accepts is sent ONCE (no needless retry)', async () => {
  const s = stubTelegram([{ ok: true, result: { message_id: 2 } }]);
  try {
    await tgSend(7, 'plain ok message');
    assert.strictEqual(s.calls.length, 1, 'no retry when the first send succeeds');
    assert.strictEqual(s.calls[0].parse_mode, 'Markdown');
  } finally { s.restore(); }
});

test('tgSend never throws even if BOTH the styled and plain sends fail', async () => {
  const s = stubTelegram([
    { ok: false, description: 'parse error' },
    { ok: false, description: 'still bad' },
  ]);
  try {
    await assert.doesNotReject(() => tgSend(1, 'anything'));
    assert.strictEqual(s.calls.length, 2, 'tried Markdown then plain, then gave up quietly');
  } finally { s.restore(); }
});

test('tgSend never throws on a network error (fetch rejects)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    await assert.doesNotReject(() => tgSend(1, 'anything'));
  } finally { global.fetch = realFetch; }
});

test('tgAnswerCallback posts callback_query_id + opts to answerCallbackQuery', async () => {
  const s = stubTelegram([{ ok: true }]);
  try {
    await tgAnswerCallback('cbid1', { text: 'Deleted' });
    assert.strictEqual(s.calls.length, 1);
    assert.strictEqual(s.calls[0].callback_query_id, 'cbid1');
    assert.strictEqual(s.calls[0].text, 'Deleted');
  } finally { s.restore(); }
});

test('tgAnswerCallback never throws on a network error (fetch rejects)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    await assert.doesNotReject(() => tgAnswerCallback('cbid2'));
  } finally { global.fetch = realFetch; }
});
