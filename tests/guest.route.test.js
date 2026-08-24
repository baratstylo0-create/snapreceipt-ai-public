'use strict';
// routes/guest.js: POST /api/guest/start + /api/guest/end. Flag-gated by
// capabilities.guestMode + capabilities.personalAuth. Supabase reads/writes are stubbed at
// global.fetch (same convention as tests/auth.route.test.js); the test's own HTTP call to the
// Express server is delegated to the real fetch. `trust proxy` is enabled to match server.js's
// real config, so an X-Forwarded-For header lets each test simulate a distinct client IP.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountGuest = require('../routes/guest');

function app() {
  const a = express();
  a.set('trust proxy', true);
  mountGuest(a);
  return a;
}

async function post(a, path, { headers = {}, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// handlers.guestIpLog(url, opt) governs `guest_ip_log` selects/inserts; everything else needed
// for a full guest signup (users/bot_bindings/sessions) gets a generic success stub so each
// test can focus on the guest_ip_log gate alone.
function stubSupabase(handlers = {}) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/guest_ip_log')) {
      calls.push({ table: 'guest_ip_log', url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined });
      return { text: async () => JSON.stringify(handlers.guestIpLog ? handlers.guestIpLog(u, opt) : []) };
    }
    if (u.includes('/users?') || u.includes('/rest/v1/users') ) {
      if ((opt.method || 'GET') === 'POST') return { text: async () => JSON.stringify([{ id: 'guestUser1', role: 'guest' }]) };
      return { text: async () => JSON.stringify([]) };
    }
    if (u.includes('/bot_bindings')) return { text: async () => JSON.stringify([{}]) };
    if (u.includes('/sessions')) return { text: async () => JSON.stringify([]) };
    return realFetch(url, opt);
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

test('guest/start: flag OFF -> 404', async () => {
  await withEnv({ CAP_GUEST_MODE: 'false', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const { status } = await post(app(), '/api/guest/start');
    assert.strictEqual(status, 404);
  });
});

test('guest/start: a NEW device (no prior guest_ip_log row) succeeds and logs the IP', async () => {
  await withEnv({ CAP_GUEST_MODE: 'true', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({ guestIpLog: () => [] }); // no existing row -> not blocked
    try {
      const { status, json } = await post(app(), '/api/guest/start');
      assert.strictEqual(status, 201);
      assert.ok(json.token, 'a session token is returned');
      const logged = stub.calls.find((c) => c.table === 'guest_ip_log' && c.method === 'POST');
      assert.ok(logged, 'guest_ip_log gets a new row on a confirmed successful signup');
      assert.strictEqual(logged.body.ip_address, '203.0.113.9');
    } finally { stub.restore(); }
  });
});

test('guest/start: a device that already has a guest_ip_log row is refused with 403 guest_already_used', async () => {
  await withEnv({ CAP_GUEST_MODE: 'true', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({ guestIpLog: () => [{ id: 'row1', ip_address: '203.0.113.9' }] });
    try {
      const { status, json } = await post(app(), '/api/guest/start');
      assert.strictEqual(status, 403);
      assert.strictEqual(json.error, 'guest_already_used');
      const insertAttempt = stub.calls.find((c) => c.table === 'guest_ip_log' && c.method === 'POST');
      assert.strictEqual(insertAttempt, undefined, 'a refused request must never touch users/bot_bindings/sessions or double-log the IP');
    } finally { stub.restore(); }
  });
});

test('guest/start: a DIFFERENT device (different X-Forwarded-For) is unaffected by another device\'s block', async () => {
  await withEnv({ CAP_GUEST_MODE: 'true', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({
      guestIpLog: (u) => (u.includes('203.0.113.9') ? [{ id: 'row1' }] : []),
    });
    try {
      const { status } = await post(app(), '/api/guest/start', { headers: { 'X-Forwarded-For': '198.51.100.4' } });
      assert.strictEqual(status, 201, 'a different device is never blocked by another device\'s guest_ip_log row');
    } finally { stub.restore(); }
  });
});
