'use strict';
// routes/branches.js — ADR-025 amendment (Owner-approved, 2026-07-11 QA round):
// GET /api/branches/:id/credentials (view anytime) + POST /api/branches/:id/reset-password.
// Same harness as tests/branches.route.test.js. CRED_ENC_KEY set before first require of
// routes/branches (-> lib/branches -> lib/credCrypto -> lib/config); node --test isolates
// each test file in its own process so this doesn't leak into other files.
process.env.CRED_ENC_KEY = 'a-test-operator-secret';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountBranches = require('../routes/branches');
const { encryptSecret } = require('../lib/credCrypto');

function app() {
  const a = express();
  mountBranches(a);
  return a;
}

async function req(a, method, path, { token, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

function stubDb({ session, handlers = {} } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (table === 'sessions' && method === 'GET') return { text: async () => JSON.stringify(session ? [session] : []) };
    const key = table + ':' + method;
    if (handlers[key]) return { text: async () => JSON.stringify(handlers[key]({ url: u, body })) };
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{}]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };

test('GET /api/branches/:id/credentials: admin sees username+password+bindToken', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const enc = encryptSecret('Str0ngPass!!');
    const stub = stubDb({
      session: ADMIN,
      handlers: {
        'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', password_enc: enc, active: true }],
        'bot_bindings:GET': () => [{ bind_token: 'tok-1', created_at: '2026-07-11T00:00:00Z' }],
      },
    });
    try {
      const { status, json } = await req(app(), 'GET', '/api/branches/bA/credentials', { token: 't' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, { username: 'kl-ab12', password: 'Str0ngPass!!', bindToken: 'tok-1' });
    } finally { stub.restore(); }
  });
});

test('GET /api/branches/:id/credentials: legacy branch (no password_enc) -> password null, still 200', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: ADMIN,
      handlers: { 'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', password_enc: null, active: true }] },
    });
    try {
      const { status, json } = await req(app(), 'GET', '/api/branches/bA/credentials', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.password, null);
    } finally { stub.restore(); }
  });
});

test('GET /api/branches/:id/credentials: no credentialed user -> 404', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'users:GET': () => [] } });
    try {
      const { status } = await req(app(), 'GET', '/api/branches/bA/credentials', { token: 't' });
      assert.strictEqual(status, 404);
    } finally { stub.restore(); }
  });
});

test('GET /api/branches/:id/credentials: clerk -> 403 (admin-only, same as branch CRUD)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'GET', '/api/branches/bA/credentials', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('GET /api/branches/:id/credentials: flag OFF -> 404 (personal product has no branches)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await req(app(), 'GET', '/api/branches/bA/credentials');
    assert.strictEqual(status, 404);
  });
});

test('POST /api/branches/:id/reset-password: admin gets a fresh password once, sessions revoked', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: ADMIN,
      handlers: { 'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', active: true }] },
    });
    try {
      const { status, json } = await req(app(), 'POST', '/api/branches/bA/reset-password', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.credentials.username, 'kl-ab12');
      assert.strictEqual(json.credentials.password.length, 14);
      assert.ok(stub.calls.some((c) => c.method === 'DELETE' && /\/sessions\?user_id=eq\.u1/.test(c.url)));
    } finally { stub.restore(); }
  });
});

test('POST /api/branches/:id/reset-password: clerk -> 403', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'POST', '/api/branches/bA/reset-password', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});
