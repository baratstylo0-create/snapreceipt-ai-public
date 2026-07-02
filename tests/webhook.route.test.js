'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const mountWebhook = require('../routes/webhook');

// P6 regression (frontend/QA/security plan §0.1): prove the Telegram webhook's
// WEBHOOK_SECRET check actually REJECTS an unsigned / wrong-secret request. cfg is a
// live object read at request time, so we set the secret here (robust to module-load
// order — process.env may have been read before this file ran).
const SECRET = 'wh-secret-abc123';
cfg.WEBHOOK_SECRET = SECRET;

function server() {
  const app = express();
  app.set('trust proxy', true);
  mountWebhook(app);
  const s = app.listen(0);
  return { s, base: 'http://127.0.0.1:' + s.address().port };
}
// A benign body: handleUpdate({}) sees no message and returns immediately (no network).
const post = (base, headers) => fetch(base + '/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
});

test('POST /webhook with NO secret header → 401 (rejected)', async () => {
  const { s, base } = server();
  try { assert.strictEqual((await post(base, {})).status, 401); } finally { s.close(); }
});

test('POST /webhook with the WRONG secret → 401 (rejected)', async () => {
  const { s, base } = server();
  try {
    const r = await post(base, { 'X-Telegram-Bot-Api-Secret-Token': 'not-the-secret' });
    assert.strictEqual(r.status, 401);
  } finally { s.close(); }
});

test('POST /webhook with the CORRECT secret → 200 (accepted)', async () => {
  const { s, base } = server();
  try {
    const r = await post(base, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    assert.strictEqual(r.status, 200);
  } finally { s.close(); }
});

test('a rejected (401) webhook body is never processed — reply carries no internals', async () => {
  const { s, base } = server();
  try {
    const r = await post(base, { 'X-Telegram-Bot-Api-Secret-Token': 'x' });
    const body = await r.text();
    assert.strictEqual(r.status, 401);
    assert.ok(!/secret|token|stack|Error/i.test(body), 'the 401 body must not echo the secret or an error');
  } finally { s.close(); }
});
