'use strict';
// routes/expenses.js Phase 4 (ADR-021): payments. PATCH /api/expenses/payments — business ADMIN
// only — marks an id list paid/pending in BULK_PAY_CHUNK-sized chunks (reversible); a clerk gets
// 403 (they read payment_status via GET like any field, but never write it). Plus optimistic
// concurrency on the single-row PATCH: an expected_updated_at mismatch → 409 refresh.
// BULK_PAY_CHUNK must be set before the route module loads (it's read at require time).
process.env.BULK_PAY_CHUNK = '2';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountExpenses = require('../routes/expenses');

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

// Route Supabase over global.fetch: sessions GET -> the seeded session; expenses GET -> `rows`;
// expenses PATCH -> recorded + echoed. Anything without /rest/v1/ is the test's own HTTP probe.
function stubDb({ session, rows = [] } = {}) {
  const realFetch = global.fetch;
  const patches = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) {
      if (method === 'PATCH') {
        const body = opt.body ? JSON.parse(opt.body) : {};
        patches.push({ url: u, body });
        const m = u.match(/id=in\.\(([^)]*)\)/);
        const n = m ? m[1].split(',').length : 1;
        return { text: async () => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: 'e' + i, ...body }))) };
      }
      return { text: async () => JSON.stringify(rows) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, patches };
}

async function call(method, path, { token, body } = {}) {
  const app = express();
  mountExpenses(app);
  const srv = app.listen(0);
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

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };
const CLERK = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };

test('payments: flag OFF -> 404 (personal product has no payment surface)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await call('PATCH', '/api/expenses/payments', { body: { ids: ['a'], paid: true } });
    assert.strictEqual(status, 404);
  });
});

test('payments: clerk -> 403, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK });
    try {
      const { status } = await call('PATCH', '/api/expenses/payments', { token: 't', body: { ids: ['a'], paid: true } });
      assert.strictEqual(status, 403);
      assert.strictEqual(stub.patches.length, 0);
    } finally { stub.restore(); }
  });
});

test('payments: admin marks 5 ids paid -> chunked into 3 PATCHes of <=2, paid fields set', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status, json } = await call('PATCH', '/api/expenses/payments', {
        token: 't', body: { ids: ['a', 'b', 'c', 'd', 'e'], paid: true, note: 'July claim run' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.updated, 5);
      assert.strictEqual(stub.patches.length, 3, '5 ids at chunk=2 -> 3 chunked PATCHes');
      for (const p of stub.patches) {
        assert.match(p.url, /id=in\.\(/);
        assert.strictEqual(p.body.payment_status, 'paid');
        assert.ok(p.body.paid_at, 'paid_at stamped');
        assert.strictEqual(p.body.paid_note, 'July claim run');
      }
    } finally { stub.restore(); }
  });
});

test('payments: reversible — paid:false resets to pending and clears paid fields', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status } = await call('PATCH', '/api/expenses/payments', { token: 't', body: { ids: ['a'], paid: false } });
      assert.strictEqual(status, 200);
      assert.strictEqual(stub.patches[0].body.payment_status, 'pending');
      assert.strictEqual(stub.patches[0].body.paid_at, null);
      assert.strictEqual(stub.patches[0].body.paid_note, null);
    } finally { stub.restore(); }
  });
});

test('payments: bad bodies -> 400 (empty ids, non-string id, paid not boolean)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      for (const body of [{ ids: [], paid: true }, { ids: [1], paid: true }, { ids: ['a'], paid: 'yes' }, {}]) {
        const { status } = await call('PATCH', '/api/expenses/payments', { token: 't', body });
        assert.strictEqual(status, 400, JSON.stringify(body));
      }
      assert.strictEqual(stub.patches.length, 0);
    } finally { stub.restore(); }
  });
});

test('optimistic concurrency: expected_updated_at mismatch -> 409 with the fresh updated_at', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, rows: [{ id: 'e1', updated_at: '2026-07-07T10:00:00+00:00' }] });
    try {
      const { status, json } = await call('PATCH', '/api/expenses/e1', {
        token: 't', body: { merchant: 'New name', expected_updated_at: '2026-07-07T09:00:00+00:00' },
      });
      assert.strictEqual(status, 409);
      assert.strictEqual(json.updated_at, '2026-07-07T10:00:00+00:00');
      assert.strictEqual(stub.patches.length, 0, 'stale edit never written');
    } finally { stub.restore(); }
  });
});

test('optimistic concurrency: matching expected_updated_at -> write proceeds', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, rows: [{ id: 'e1', updated_at: '2026-07-07T10:00:00+00:00' }] });
    try {
      const { status } = await call('PATCH', '/api/expenses/e1', {
        token: 't', body: { merchant: 'New name', expected_updated_at: '2026-07-07T10:00:00+00:00' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(stub.patches.length, 1);
      assert.strictEqual(stub.patches[0].body.merchant, 'New name');
      assert.ok(!('expected_updated_at' in stub.patches[0].body), 'guard field never written to the DB');
    } finally { stub.restore(); }
  });
});
