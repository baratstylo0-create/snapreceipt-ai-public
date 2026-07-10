'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tgSend, tgSendPhoto, tgEditMessage, tgAnswerCallback, registerWebhook } = require('../lib/telegram');
const { cfg } = require('../lib/config');

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

// --- tgEditMessage (Owner request 2026-07-04): turn a category-picker prompt into its
// final "Saved" state in place, instead of leaving stale buttons + sending a new message. ---

// --- tgSendPhoto (issue #152): resend an already-received photo by its own file_id,
// with a reason-specific caption — no re-download needed. ---

test('tgSendPhoto: posts chat_id/photo(file_id)/caption to sendPhoto', async () => {
  const s = stubTelegram([{ ok: true, result: { message_id: 9 } }]);
  try {
    await tgSendPhoto(42, 'AgAC-abc123', '📷 This one was too blurry to read the total.');
    assert.strictEqual(s.calls.length, 1);
    assert.strictEqual(s.calls[0].chat_id, 42);
    assert.strictEqual(s.calls[0].photo, 'AgAC-abc123');
    assert.strictEqual(s.calls[0].caption, '📷 This one was too blurry to read the total.');
    assert.strictEqual(s.calls[0].parse_mode, 'Markdown');
  } finally { s.restore(); }
});

test('tgSendPhoto: a Markdown-rejected caption is RETRIED as plain text (same safety net as tgSend)', async () => {
  const s = stubTelegram([
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    { ok: true, result: { message_id: 9 } },
  ]);
  try {
    await tgSendPhoto(42, 'fid1', 'Cut off: 7*11 & A_B [store]');
    assert.strictEqual(s.calls.length, 2);
    assert.strictEqual(s.calls[0].parse_mode, 'Markdown');
    assert.ok(!('parse_mode' in s.calls[1]));
    assert.strictEqual(s.calls[1].caption, s.calls[0].caption);
  } finally { s.restore(); }
});

test('tgSendPhoto: never throws even if both attempts fail, or on a network error', async () => {
  const s = stubTelegram([{ ok: false, description: 'bad' }, { ok: false, description: 'still bad' }]);
  try { await assert.doesNotReject(() => tgSendPhoto(1, 'fid', 'x')); } finally { s.restore(); }

  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  try { await assert.doesNotReject(() => tgSendPhoto(1, 'fid', 'x')); } finally { global.fetch = realFetch; }
});

test('tgEditMessage: posts chat_id/message_id/text to editMessageText and explicitly clears the keyboard', async () => {
  const s = stubTelegram([{ ok: true, result: { message_id: 5 } }]);
  try {
    await tgEditMessage(42, 5, '✅ Saved as Groceries');
    assert.strictEqual(s.calls.length, 1);
    assert.strictEqual(s.calls[0].chat_id, 42);
    assert.strictEqual(s.calls[0].message_id, 5);
    assert.strictEqual(s.calls[0].text, '✅ Saved as Groceries');
    assert.deepStrictEqual(s.calls[0].reply_markup, { inline_keyboard: [] }, 'the keyboard must be explicitly cleared — Telegram does not remove it on its own');
  } finally { s.restore(); }
});

test('tgEditMessage: a Markdown-rejected edit is RETRIED as plain text (same safety net as tgSend)', async () => {
  const s = stubTelegram([
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    { ok: true, result: { message_id: 5 } },
  ]);
  try {
    await tgEditMessage(42, 5, '✅ Saved as 7*11 & A_B [store]');
    assert.strictEqual(s.calls.length, 2);
    assert.strictEqual(s.calls[0].parse_mode, 'Markdown');
    assert.ok(!('parse_mode' in s.calls[1]));
    assert.strictEqual(s.calls[1].text, s.calls[0].text);
  } finally { s.restore(); }
});

test('tgEditMessage never throws even if both attempts fail, or on a network error', async () => {
  const s = stubTelegram([{ ok: false, description: 'bad' }, { ok: false, description: 'still bad' }]);
  try { await assert.doesNotReject(() => tgEditMessage(1, 1, 'x')); } finally { s.restore(); }

  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  try { await assert.doesNotReject(() => tgEditMessage(1, 1, 'x')); } finally { global.fetch = realFetch; }
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

// registerWebhook: self-signed-host cert support. A self-signed VPS deploy needs the
// cert uploaded WITH setWebhook (multipart `certificate` field) or Telegram refuses to
// trust the host — a plain JSON body (the only path this used to have) silently doesn't
// work there. These lock the new optional-cert-path behaviour without an env var.

test('registerWebhook: no PUBLIC_URL -> skips without calling fetch', async () => {
  const realFetch = global.fetch;
  const realUrl = cfg.PUBLIC_URL;
  cfg.PUBLIC_URL = '';
  let called = false;
  global.fetch = async () => { called = true; return { text: async () => '{}' }; };
  try {
    await registerWebhook();
    assert.strictEqual(called, false, 'must not call fetch when PUBLIC_URL is unset');
  } finally { global.fetch = realFetch; cfg.PUBLIC_URL = realUrl; }
});

test('registerWebhook: no cert path -> plain JSON setWebhook body (unchanged existing behaviour)', async () => {
  const realFetch = global.fetch;
  const realUrl = cfg.PUBLIC_URL;
  const realSecret = cfg.WEBHOOK_SECRET;
  cfg.PUBLIC_URL = 'https://example.com';
  cfg.WEBHOOK_SECRET = 's3cret';
  let captured;
  global.fetch = async (_url, opt) => { captured = opt; return { text: async () => JSON.stringify({ ok: true }) }; };
  try {
    await registerWebhook();
    assert.strictEqual(typeof captured.body, 'string', 'body must still be a plain JSON string with no cert path');
    const body = JSON.parse(captured.body);
    assert.strictEqual(body.url, 'https://example.com/webhook');
    assert.strictEqual(body.secret_token, 's3cret');
    assert.deepStrictEqual(body.allowed_updates, ['message', 'edited_message', 'callback_query']);
  } finally { global.fetch = realFetch; cfg.PUBLIC_URL = realUrl; cfg.WEBHOOK_SECRET = realSecret; }
});

test('registerWebhook: cert path given -> uploads multipart/form-data with the certificate file', async () => {
  const realFetch = global.fetch;
  const realUrl = cfg.PUBLIC_URL;
  const realSecret = cfg.WEBHOOK_SECRET;
  cfg.PUBLIC_URL = 'https://31.97.70.50';
  cfg.WEBHOOK_SECRET = 'hook-secret';
  const certPath = path.join(os.tmpdir(), 'test-cert-' + Date.now() + '.pem');
  fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
  let captured;
  global.fetch = async (_url, opt) => { captured = opt; return { text: async () => JSON.stringify({ ok: true }) }; };
  try {
    await registerWebhook(certPath);
    assert.ok(captured.body instanceof FormData, 'body must be sent as multipart FormData, not JSON, when a cert path is given');
    assert.strictEqual(captured.body.get('url'), 'https://31.97.70.50/webhook');
    assert.strictEqual(captured.body.get('secret_token'), 'hook-secret');
    assert.deepStrictEqual(JSON.parse(captured.body.get('allowed_updates')), ['message', 'edited_message', 'callback_query']);
    const certField = captured.body.get('certificate');
    assert.ok(certField, 'certificate field must be present');
    assert.ok((await certField.text()).includes('BEGIN CERTIFICATE'));
  } finally {
    global.fetch = realFetch; cfg.PUBLIC_URL = realUrl; cfg.WEBHOOK_SECRET = realSecret;
    fs.unlinkSync(certPath);
  }
});

test('registerWebhook: falls back to cfg.WEBHOOK_CERT_PATH when no explicit arg is passed', async () => {
  const realFetch = global.fetch;
  const realUrl = cfg.PUBLIC_URL;
  const realCertCfg = cfg.WEBHOOK_CERT_PATH;
  cfg.PUBLIC_URL = 'https://example.com';
  const certPath = path.join(os.tmpdir(), 'test-cert-cfg-' + Date.now() + '.pem');
  fs.writeFileSync(certPath, 'dummy');
  cfg.WEBHOOK_CERT_PATH = certPath;
  let captured;
  global.fetch = async (_url, opt) => { captured = opt; return { text: async () => JSON.stringify({ ok: true }) }; };
  try {
    await registerWebhook(); // no arg -> must read cfg.WEBHOOK_CERT_PATH itself
    assert.ok(captured.body instanceof FormData);
  } finally {
    global.fetch = realFetch; cfg.PUBLIC_URL = realUrl; cfg.WEBHOOK_CERT_PATH = realCertCfg;
    fs.unlinkSync(certPath);
  }
});

test('registerWebhook: never throws on a network error, cert path or not', async () => {
  const realFetch = global.fetch;
  const realUrl = cfg.PUBLIC_URL;
  cfg.PUBLIC_URL = 'https://example.com';
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    await assert.doesNotReject(() => registerWebhook());
  } finally { global.fetch = realFetch; cfg.PUBLIC_URL = realUrl; }
});
