'use strict';
// routes/auth.js (ADR-021 Phase 1): POST /api/login + /api/logout. Flag-gated by
// capabilities.multiUser. Supabase reads/writes are stubbed at global.fetch; the test's
// own HTTP call to the Express server is delegated to the real fetch.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountAuth = require('../routes/auth');
const { hashPassword, tokenHash } = require('../lib/auth');

function app() {
  const a = express();
  mountAuth(a);
  return a;
}

async function post(a, path, { headers = {}, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
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

// Route Supabase calls: `users` select via `handlers.users(url)`; `sessions` writes via
// `handlers.sessions(url, opt)`. Everything else (the test's own probe) hits real fetch.
function stubSupabase(handlers) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('/users?')) return { text: async () => JSON.stringify(handlers.users ? handlers.users(u) : []) };
    if (u.includes('/sessions')) {
      calls.push({ url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined });
      return { text: async () => JSON.stringify(handlers.sessions ? handlers.sessions(u, opt) : []) };
    }
    return realFetch(url, opt);
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

test('login: flag OFF -> 404 (personal product has no login)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await post(app(), '/api/login', { body: { username: 'x', password: 'y' } });
    assert.strictEqual(status, 404);
  });
});

test('login: valid clerk credentials -> 200 + token, session minted', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const hash = await hashPassword('hunter2');
    const stub = stubSupabase({
      users: () => [{ id: 'u1', role: 'clerk', branch_id: 'b1', username: 'clerkbob', password_hash: hash, display_name: 'Bob', active: true }],
      sessions: () => [],
    });
    try {
      const { status, json } = await post(app(), '/api/login', { body: { username: 'clerkbob', password: 'hunter2' } });
      assert.strictEqual(status, 200);
      assert.ok(json.token, 'returns a session token');
      assert.strictEqual(json.role, 'clerk');
      assert.strictEqual(json.branch_id, 'b1');
      const minted = stub.calls.find((c) => c.method === 'POST');
      assert.ok(minted, 'a session row was POSTed');
      assert.strictEqual(minted.body.token_hash, tokenHash(json.token), 'stored hash matches returned token');
    } finally { stub.restore(); }
  });
});

test('login: wrong password -> 401, no session minted', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const hash = await hashPassword('right');
    const stub = stubSupabase({
      users: () => [{ id: 'u1', role: 'clerk', branch_id: 'b1', username: 'clerkbob', password_hash: hash, active: true }],
    });
    try {
      const { status } = await post(app(), '/api/login', { body: { username: 'clerkbob', password: 'wrong' } });
      assert.strictEqual(status, 401);
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST'), false, 'no session minted on failed login');
    } finally { stub.restore(); }
  });
});

test('login: unknown user -> 401 (and still runs a hash for uniform timing)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubSupabase({ users: () => [] });
    try {
      const { status } = await post(app(), '/api/login', { body: { username: 'ghost', password: 'x' } });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('login: a staff row can never authenticate -> 401', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    // Even if a staff row somehow had a hash, role==='staff' is refused.
    const hash = await hashPassword('x');
    const stub = stubSupabase({ users: () => [{ id: 's1', role: 'staff', username: null, password_hash: hash, active: true }] });
    try {
      const { status } = await post(app(), '/api/login', { body: { username: 'someone', password: 'x' } });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('login: missing fields -> 400', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubSupabase({});
    try {
      const { status } = await post(app(), '/api/login', { body: { username: 'x' } });
      assert.strictEqual(status, 400);
    } finally { stub.restore(); }
  });
});

test('logout: valid session -> revokes (DELETE by user_id) and 200s', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const token = 'tok-abc';
    const stub = stubSupabase({
      sessions: (u) => u.includes('token_hash=eq.')
        ? [{ user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1', expires_at: new Date(Date.now() + 60000).toISOString() }]
        : [],
    });
    try {
      const { status, json } = await post(app(), '/api/logout', { headers: { Authorization: 'Bearer ' + token } });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, { ok: true });
      const del = stub.calls.find((c) => c.method === 'DELETE');
      assert.ok(del, 'a DELETE was issued');
      assert.match(del.url, /user_id=eq\.u1/);
    } finally { stub.restore(); }
  });
});

test('logout: flag OFF -> 404', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await post(app(), '/api/logout', {});
    assert.strictEqual(status, 404);
  });
});
