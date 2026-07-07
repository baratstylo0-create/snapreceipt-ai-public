'use strict';
// routes/statement.js (ADR-023/024 Phase 10): GET /api/statement?branch=&period=&format=xlsx|pdf.
// Flag-gated by pettyCash (AND multiUser). Admin any branch; clerk hard-forced to own branch (same
// bouncer as /api/petty-cash). Emits a real .xlsx (PK magic) or .pdf (%PDF- magic) with the right
// content-type + attachment filename built ONLY from validated tokens. Same stub harness as the
// other route tests.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountStatement = require('../routes/statement');

function app() { const a = express(); mountStatement(a); return a; }

async function reqRaw(a, path, { token } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, contentType: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), bytes: buf };
  } finally { srv.close(); }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
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
    return { text: async () => JSON.stringify([{ id: 'patched', ...body }]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
const ON = { CAP_MULTI_USER: 'true', CAP_PETTY_CASH: 'true' };

test('statement: pettyCash flag OFF -> 404', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_PETTY_CASH: 'false' }, async () => {
    const { status } = await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=xlsx');
    assert.strictEqual(status, 404);
  });
});

test('statement: multiUser OFF -> 404', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal', CAP_PETTY_CASH: 'true' }, async () => {
    const { status } = await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=pdf');
    assert.strictEqual(status, 404);
  });
});

test('statement: no session -> 401', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: null });
    try {
      const { status } = await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=xlsx', { token: 'ghost' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('statement: bad period / bad format / admin-missing-branch -> 400', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      assert.strictEqual((await reqRaw(app(), '/api/statement?branch=bA&period=xx&format=xlsx', { token: 't' })).status, 400);
      assert.strictEqual((await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=csv', { token: 't' })).status, 400);
      assert.strictEqual((await reqRaw(app(), '/api/statement?period=2025-10&format=xlsx', { token: 't' })).status, 400);
    } finally { stub.restore(); }
  });
});

test('statement: xlsx emits with correct content-type + PK magic + filename', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const r = await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=xlsx', { token: 't' });
      assert.strictEqual(r.status, 200);
      assert.match(r.contentType, /spreadsheetml\.sheet/);
      assert.strictEqual(r.bytes.subarray(0, 2).toString('latin1'), 'PK', 'a real .xlsx (zip) file');
      assert.match(r.disposition, /petty-cash-bA-2025-10\.xlsx/);
    } finally { stub.restore(); }
  });
});

test('statement: pdf emits with correct content-type + %PDF- magic', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const r = await reqRaw(app(), '/api/statement?branch=bA&period=2025-10&format=pdf', { token: 't' });
      assert.strictEqual(r.status, 200);
      assert.match(r.contentType, /application\/pdf/);
      assert.strictEqual(r.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(r.disposition, /petty-cash-bA-2025-10\.pdf/);
    } finally { stub.restore(); }
  });
});

test('statement: clerk is hard-forced to own branch (query branch ignored)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const r = await reqRaw(app(), '/api/statement?branch=bEVIL&period=2025-10&format=xlsx', { token: 't' });
      assert.strictEqual(r.status, 200);
      assert.ok(!stub.calls.some((c) => /bEVIL/.test(c.url)), 'a clerk can never export another branch');
      assert.ok(stub.calls.some((c) => /branch_id=eq\.bA/.test(c.url)), 'queries pinned to the clerk’s own branch');
    } finally { stub.restore(); }
  });
});
