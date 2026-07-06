'use strict';
// routes/branches.js (ADR-021 Phase 2): admin branch CRUD + clerk-manages-own-branch-staff, all
// flag-gated by capabilities.multiUser, role-guarded via req.scope (the scopeForUser bouncer), and
// rate-limited (SEC-7). Supabase REST is stubbed at global.fetch (URLs carry '/rest/v1/'); the
// test's own HTTP probe to the Express server is delegated to the real fetch.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountBranches = require('../routes/branches');

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
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
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

// Stub Supabase. `session` seeds the checkDash session lookup (→ req.scope). `handlers` maps
// '<table>:<METHOD>' → fn returning rows. Anything without '/rest/v1/' is the test's own probe.
function stubDb({ session, handlers = {} } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt); // the test's HTTP probe
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

test('branches: flag OFF -> 404 (personal product has no branches)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await req(app(), 'GET', '/api/branches');
    assert.strictEqual(status, 404);
  });
});

test('branches: no session -> 401', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: null });
    try {
      const { status } = await req(app(), 'GET', '/api/branches', { token: 'nope' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('branches: admin GET lists active branches', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'branches:GET': () => [{ id: 'bA', office: 'Head Office', active: true }] } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/branches', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.branches[0].office, 'Head Office');
    } finally { stub.restore(); }
  });
});

test('branches: clerk GET /api/branches -> 403 (CRUD is admin-only)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'GET', '/api/branches', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('branches: admin POST creates a branch + returns credentials ONCE + bindToken', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN }); // account_settings GET -> [] (default cap), branches GET -> [] (count 0)
    try {
      const { status, json } = await req(app(), 'POST', '/api/branches', { token: 't', body: { office: 'KL Branch', clerkName: 'Aisha' } });
      assert.strictEqual(status, 201);
      assert.ok(json.credentials.username && json.credentials.password, 'creds shown once');
      assert.ok(json.bindToken);
      const branchPost = stub.calls.find((c) => c.method === 'POST' && /\/branches/.test(c.url));
      assert.strictEqual(branchPost.body.office, 'KL Branch');
    } finally { stub.restore(); }
  });
});

test('branches: admin POST is refused (403) when max_branches is reached', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: ADMIN,
      handlers: {
        'account_settings:GET': () => [{ value: { limit: 1 } }],
        'branches:GET': () => [{ id: 'b1', active: true }], // already at the cap of 1
      },
    });
    try {
      const { status, json } = await req(app(), 'POST', '/api/branches', { token: 't', body: { office: 'Second' } });
      assert.strictEqual(status, 403);
      assert.match(json.error, /limit/i);
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST' && /\/branches/.test(c.url)), false, 'no branch created past the cap');
    } finally { stub.restore(); }
  });
});

test('branches: clerk POST /api/branches -> 403', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'POST', '/api/branches', { token: 't', body: { office: 'X' } });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('branches: admin DELETE soft-deletes; clerk DELETE -> 403', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    let stub = stubDb({ session: ADMIN, handlers: { 'users:GET': () => [], 'bot_bindings:GET': () => [] } });
    try {
      const { status, json } = await req(app(), 'DELETE', '/api/branches/bX', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.ok, true);
      assert.ok(stub.calls.some((c) => c.method === 'PATCH' && /\/branches\?/.test(c.url) && c.body.active === false));
    } finally { stub.restore(); }

    stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'DELETE', '/api/branches/bX', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('branches: clerk manages staff on OWN branch (200) but not another (403); admin any (200)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    // clerk A adds staff to own branch bA
    let stub = stubDb({ session: CLERK_A });
    try {
      const { status, json } = await req(app(), 'POST', '/api/branches/bA/staff', { token: 't', body: { name: 'Ravi' } });
      assert.strictEqual(status, 201);
      assert.strictEqual(json.staff.display_name, 'Ravi');
      const post = stub.calls.find((c) => c.method === 'POST' && /\/users/.test(c.url));
      assert.strictEqual(post.body.role, 'staff');
    } finally { stub.restore(); }

    // clerk A tries another branch bB -> 403, no write
    stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'POST', '/api/branches/bB/staff', { token: 't', body: { name: 'Mallory' } });
      assert.strictEqual(status, 403);
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST' && /\/users/.test(c.url)), false);
    } finally { stub.restore(); }

    // admin adds staff to any branch -> 201
    stub = stubDb({ session: ADMIN });
    try {
      const { status } = await req(app(), 'POST', '/api/branches/bZ/staff', { token: 't', body: { name: 'Sam' } });
      assert.strictEqual(status, 201);
    } finally { stub.restore(); }
  });
});

test('branches: clerk lists staff on own branch (200), another branch (403)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    let stub = stubDb({ session: CLERK_A, handlers: { 'users:GET': () => [{ id: 's1', display_name: 'Ravi', role: 'staff' }] } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/branches/bA/staff', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.staff[0].display_name, 'Ravi');
    } finally { stub.restore(); }

    stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'GET', '/api/branches/bB/staff', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});
