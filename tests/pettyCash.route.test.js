'use strict';
// routes/pettyCash.js (ADR-023 Phase 9): petty-cash floats + claim summary. Flag-gated by
// capabilities.pettyCash (AND multiUser). GET summary — admin any branch (branch param required),
// clerk hard-forced to their own branch (a body/query branch is ignored, SEC-2). Float PUT +
// cash-in POST/DELETE are ADMIN-ONLY (the Owner's rule: only the admin sets floats, incl. Head
// Office). Same stub harness as tests/submissions.route.test.js. The summary numbers must equal the
// pure layer (tests/pettyCash.test.js) — including the canonical +75.09 surplus / zero-claims case.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountPettyCash = require('../routes/pettyCash');

function app() {
  const a = express();
  mountPettyCash(a);
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
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
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
    return { text: async () => JSON.stringify([{ id: 'patched', ...body }]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };

const ON = { CAP_MULTI_USER: 'true', CAP_PETTY_CASH: 'true' };

// the canonical fixture: float 3000, three expenses summing to 2924.91 → +75.09, zero claims
const CANON_FLOAT = [{ id: 'f1', branch_id: 'bA', period: '2026-07', balance_bf: 3000 }];
const CANON_EXPENSES = [
  { id: 'e1', branch_id: 'bA', expense_date: '2026-07-01', amount: 10.10, created_at: '2026-07-01T00:00:00Z' },
  { id: 'e2', branch_id: 'bA', expense_date: '2026-07-02', amount: 20.20, created_at: '2026-07-02T00:00:00Z' },
  { id: 'e3', branch_id: 'bA', expense_date: '2026-07-03', amount: 2894.61, created_at: '2026-07-03T00:00:00Z' },
];

test('petty-cash: pettyCash flag OFF -> 404 (even with multiUser ON)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_PETTY_CASH: 'false' }, async () => {
    const { status } = await req(app(), 'GET', '/api/petty-cash?branch=bA&period=2026-07');
    assert.strictEqual(status, 404);
  });
});

test('petty-cash: multiUser OFF -> 404 (personal product has no petty-cash engine)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal', CAP_PETTY_CASH: 'true' }, async () => {
    const { status } = await req(app(), 'GET', '/api/petty-cash?branch=bA&period=2026-07');
    assert.strictEqual(status, 404);
  });
});

test('petty-cash: no session in business mode -> 401', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: null });
    try {
      const { status } = await req(app(), 'GET', '/api/petty-cash?branch=bA&period=2026-07', { token: 'ghost' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('petty-cash: GET summary numbers match the pure layer (+75.09 surplus, ZERO claims)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN, handlers: {
      'petty_cash_floats:GET': () => CANON_FLOAT,
      'cash_in:GET': () => [],
      'expenses:GET': () => CANON_EXPENSES,
    } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/petty-cash?branch=bA&period=2026-07', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.cashInHand, 3000);
      assert.strictEqual(json.expenditure, 2924.91);
      assert.strictEqual(json.balance, 75.09, 'surplus, not a −75.09 claim (the client-sheet bug)');
      assert.deepStrictEqual(json.claims.ids, []);
      assert.strictEqual(json.claims.total, 0);
    } finally { stub.restore(); }
  });
});

test('petty-cash: clerk GET is hard-forced to their own branch (query branch ignored)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A, handlers: {
      'petty_cash_floats:GET': () => CANON_FLOAT,
      'cash_in:GET': () => [],
      'expenses:GET': () => CANON_EXPENSES,
    } });
    try {
      const { status } = await req(app(), 'GET', '/api/petty-cash?branch=bEVIL&period=2026-07', { token: 't' });
      assert.strictEqual(status, 200);
      assert.ok(!stub.calls.some((c) => /bEVIL/.test(c.url)), 'a clerk can never query another branch');
      assert.ok(stub.calls.some((c) => /branch_id=eq\.bA/.test(c.url)), 'queries are pinned to the clerk’s own branch');
    } finally { stub.restore(); }
  });
});

test('petty-cash: admin GET requires a branch param; missing -> 400', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status } = await req(app(), 'GET', '/api/petty-cash?period=2026-07', { token: 't' });
      assert.strictEqual(status, 400);
    } finally { stub.restore(); }
  });
});

test('petty-cash: GET bad/missing period -> 400', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      for (const period of [undefined, 'July', '2026-13', '2026-7', '2026-07-01']) {
        const q = period === undefined ? '' : '?period=' + period;
        const { status } = await req(app(), 'GET', '/api/petty-cash' + q, { token: 't' });
        assert.strictEqual(status, 400, 'period ' + JSON.stringify(period) + ' must be rejected');
      }
    } finally { stub.restore(); }
  });
});

test('petty-cash: PUT float is ADMIN-ONLY (clerk -> 403, nothing written)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'PUT', '/api/petty-cash/float', { token: 't', body: { branchId: 'bA', period: '2026-07', balanceBf: 3000 } });
      assert.strictEqual(status, 403);
      assert.ok(!stub.calls.some((c) => /petty_cash_floats/.test(c.url) && c.method !== 'GET'), 'no float write by a clerk');
    } finally { stub.restore(); }
  });
});

test('petty-cash: admin PUT float upserts on (branch, period) — insert first, UPDATE second (no duplicate)', async () => {
  await withEnv(ON, async () => {
    // first call: no existing row -> INSERT
    let stub = stubDb({ session: ADMIN, handlers: { 'petty_cash_floats:GET': () => [] } });
    try {
      const { status } = await req(app(), 'PUT', '/api/petty-cash/float', { token: 't', body: { branchId: 'bA', period: '2026-07', balanceBf: 3000, currency: 'MYR' } });
      assert.strictEqual(status, 200);
      const post = stub.calls.find((c) => c.method === 'POST' && /petty_cash_floats/.test(c.url));
      assert.ok(post, 'first set inserts the float');
      assert.strictEqual(post.body.balance_bf, 3000);
      assert.strictEqual(post.body.branch_id, 'bA');
    } finally { stub.restore(); }

    // second call: existing row -> UPDATE, never a duplicate insert
    stub = stubDb({ session: ADMIN, handlers: {
      'petty_cash_floats:GET': () => [{ id: 'f1', branch_id: 'bA', period: '2026-07', balance_bf: 3000 }],
      'petty_cash_floats:PATCH': ({ body }) => [{ id: 'f1', ...body }],
    } });
    try {
      const { status } = await req(app(), 'PUT', '/api/petty-cash/float', { token: 't', body: { branchId: 'bA', period: '2026-07', balanceBf: 3500 } });
      assert.strictEqual(status, 200);
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST' && /petty_cash_floats/.test(c.url)), false, 'no second insert');
      const patch = stub.calls.find((c) => c.method === 'PATCH' && /petty_cash_floats/.test(c.url));
      assert.ok(patch, 're-set updates the existing float');
      assert.strictEqual(patch.body.balance_bf, 3500);
    } finally { stub.restore(); }
  });
});

test('petty-cash: PUT float validates period + balanceBf (SEC-5)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'petty_cash_floats:GET': () => [] } });
    try {
      const bads = [
        { branchId: 'bA', period: 'xx', balanceBf: 100 },
        { branchId: 'bA', period: '2026-07', balanceBf: -5 },
        { branchId: 'bA', period: '2026-07', balanceBf: 'abc' },
        { branchId: '', period: '2026-07', balanceBf: 100 },
      ];
      for (const body of bads) {
        const { status } = await req(app(), 'PUT', '/api/petty-cash/float', { token: 't', body });
        assert.strictEqual(status, 400, JSON.stringify(body) + ' must be rejected');
      }
    } finally { stub.restore(); }
  });
});

test('petty-cash: cash-in POST is admin-only + validates amount > 0', async () => {
  await withEnv(ON, async () => {
    // clerk -> 403
    let stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'POST', '/api/petty-cash/cash-in', { token: 't', body: { branchId: 'bA', period: '2026-07', amount: 100 } });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }

    // admin ok
    stub = stubDb({ session: ADMIN });
    try {
      const { status, json } = await req(app(), 'POST', '/api/petty-cash/cash-in', { token: 't', body: { branchId: 'bA', period: '2026-07', date: '2026-07-05', description: 'Top up', amount: 250 } });
      assert.strictEqual(status, 201);
      assert.ok(json.cashIn, 'echoes the created row');
      const post = stub.calls.find((c) => c.method === 'POST' && /cash_in/.test(c.url));
      assert.strictEqual(post.body.amount, 250);
      assert.strictEqual(post.body.branch_id, 'bA');
    } finally { stub.restore(); }

    // bad amounts -> 400
    stub = stubDb({ session: ADMIN });
    try {
      for (const amount of [0, -5, 'abc', undefined]) {
        const { status } = await req(app(), 'POST', '/api/petty-cash/cash-in', { token: 't', body: { branchId: 'bA', period: '2026-07', amount } });
        assert.strictEqual(status, 400, 'amount ' + JSON.stringify(amount) + ' must be rejected');
      }
    } finally { stub.restore(); }
  });
});

test('petty-cash: cash-in DELETE is admin-only (clerk 403; admin deletes)', async () => {
  await withEnv(ON, async () => {
    let stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'DELETE', '/api/petty-cash/cash-in/ci1', { token: 't' });
      assert.strictEqual(status, 403);
      assert.ok(!stub.calls.some((c) => c.method === 'DELETE' && /cash_in/.test(c.url)), 'no delete by a clerk');
    } finally { stub.restore(); }

    stub = stubDb({ session: ADMIN });
    try {
      const { status } = await req(app(), 'DELETE', '/api/petty-cash/cash-in/ci1', { token: 't' });
      assert.strictEqual(status, 200);
      assert.ok(stub.calls.some((c) => c.method === 'DELETE' && /cash_in\?id=eq\.ci1/.test(c.url)), 'admin hard-deletes the ledger row');
    } finally { stub.restore(); }
  });
});
