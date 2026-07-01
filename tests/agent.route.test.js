'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountAgent = require('../routes/agent');
const { cfg } = require('../lib/config');

function appWith(runAgentFake) {
  const app = express();
  mountAgent(app, { runAgent: runAgentFake, chat: async () => ({ role: 'assistant', content: 'ok' }) });
  return app;
}
async function post(app, body, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

test('happy path returns answer + updated transcript', async () => {
  const app = appWith(async () => ({ answer: 'Spent $70.', toolCalls: [], iterations: 1 }));
  const r = await post(app, { messages: [{ role: 'user', content: 'total?' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.answer, 'Spent $70.');
  const last = r.json.messages[r.json.messages.length - 1];
  assert.deepEqual(last, { role: 'assistant', content: 'Spent $70.' });
});

test('malformed body -> 400, no stack trace', async () => {
  const app = appWith(async () => ({ answer: 'x' }));
  const r = await post(app, { nope: true });
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.json).includes('at ')); // no stack frames leaked
});

test('transcript too many messages -> 413 (runAgent not called)', async () => {
  let called = false;
  const app = appWith(async () => { called = true; return { answer: 'x' }; });
  const big = { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' })) };
  const r = await post(app, big);
  assert.equal(r.status, 413);
  assert.equal(called, false);
});

test('transcript too many chars -> 413', async () => {
  const app = appWith(async () => ({ answer: 'x' }));
  const r = await post(app, { messages: [{ role: 'user', content: 'a'.repeat(12001) }] });
  assert.equal(r.status, 413);
});

test('runAgent failure -> 502 JSON, no stack trace', async () => {
  const app = appWith(async () => { throw new Error('groq down at internal/path.js:1'); });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/path.js'));
});

test('checkDash enforced: 401 without token, 200 with correct token when DASHBOARD_TOKEN set', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const app = appWith(async () => ({ answer: 'ok', toolCalls: [] }));
    const noKey = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(noKey.status, 401);
    const withKey = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer secret' });
    assert.equal(withKey.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('rejects a message whose content is not a string -> 400', async () => {
  const app = appWith(async () => ({ answer: 'x', toolCalls: [] }));
  const r = await post(app, { messages: [{ role: 'user', content: 42 }] });
  assert.equal(r.status, 400);
});
