'use strict';
// routes/guest.js -- P-02a (#35) device/timeline instrumentation on guest session creation.
// Cross-lane pre-review on #48 (Codex) found that /api/guest/start minted a session with no
// device metadata and recorded no auth_events row, so a guest's "devices"/timeline was
// silently incomplete relative to a password signup. This proves the fix: mintSession
// receives device metadata, and a login_ok event is written for the guest's own user id.
//
// There was no existing test file for this route at all before this one.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountGuest = require('../routes/guest');
const { tokenHash } = require('../lib/auth');

function app() {
  const a = express();
  mountGuest(a);
  return a;
}

async function post(a, path, { headers = {} } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers });
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

// Stubs every Supabase call /api/guest/start makes: the staleness sweep's `users` select,
// the `users` insert (returning the new guest row), the `bot_bindings` insert, the
// `sessions` insert (mintSession), and the `auth_events` insert (recordAuthEvent). Delegates
// anything else (the test's own probe request) to the real fetch.
function stubGuestStart() {
  const realFetch = global.fetch;
  const calls = { sessions: [], auth_events: [] };
  let nextId = 1;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = (opt.method || 'GET').toUpperCase();
    const body = () => (opt.body ? JSON.parse(opt.body) : null);

    if (u.includes('/users?') && method === 'GET') return { text: async () => '[]' }; // sweep: nothing stale
    if (u.includes('/users') && method === 'POST') {
      const row = { id: 'guest-' + nextId++, role: 'guest', active: true, ...body() };
      return { text: async () => JSON.stringify([row]) };
    }
    if (u.includes('/bot_bindings') && method === 'POST') return { text: async () => '[]' };
    if (u.includes('/sessions') && method === 'POST') {
      calls.sessions.push(body());
      return { text: async () => '[]' };
    }
    if (u.includes('/auth_events') && method === 'POST') {
      calls.auth_events.push(body());
      return { text: async () => '[]' };
    }
    return realFetch(url, opt);
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test('guest start: flag OFF -> 404, no writes attempted', async () => {
  await withEnv({ CAP_GUEST_MODE: 'false', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubGuestStart();
    try {
      const { status } = await post(app(), '/api/guest/start');
      assert.strictEqual(status, 404);
      assert.strictEqual(stub.calls.sessions.length, 0);
    } finally { stub.restore(); }
  });
});

test('guest start: mints a session carrying device metadata and records login_ok', async () => {
  await withEnv({ CAP_GUEST_MODE: 'true', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubGuestStart();
    try {
      const { status, json } = await post(app(), '/api/guest/start', {
        headers: { 'User-Agent': 'GuestProbe/1.0' },
      });
      assert.strictEqual(status, 201);
      assert.strictEqual(json.role, 'guest');
      assert.ok(json.token, 'a session token is still returned');

      assert.strictEqual(stub.calls.sessions.length, 1, 'exactly one session row is minted');
      const session = stub.calls.sessions[0];
      assert.strictEqual(session.user_agent, 'GuestProbe/1.0',
        'the FIX: the session row must carry device metadata, previously always absent');
      assert.ok(session.ip_hash, 'and a hashed (never raw) client identifier');
      assert.strictEqual(session.token_hash, tokenHash(json.token), 'the minted token really matches this session row');

      assert.strictEqual(stub.calls.auth_events.length, 1, 'exactly one timeline entry is written');
      const event = stub.calls.auth_events[0];
      assert.strictEqual(event.event, 'login_ok');
      assert.strictEqual(event.user_id, json.token ? stub.calls.sessions[0].user_id : null,
        'the timeline entry belongs to the SAME guest user the session was minted for');
    } finally { stub.restore(); }
  });
});

test('guest start: never records a new_device event (ephemeral identity, no meaningful prior device)', async () => {
  await withEnv({ CAP_GUEST_MODE: 'true', CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubGuestStart();
    try {
      await post(app(), '/api/guest/start');
      const events = stub.calls.auth_events.map((e) => e.event);
      assert.ok(!events.includes('new_device'), 'a one-shot guest identity has nothing to compare a "new device" against');
    } finally { stub.restore(); }
  });
});
