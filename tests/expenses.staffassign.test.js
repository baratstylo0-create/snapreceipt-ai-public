'use strict';
// Issue #153: dashboard bulk upload assigns saved rows to staff through one branch-scoped
// bulk endpoint. These tests lock the M2 isolation contract: clerks only their own branch,
// admins cannot assign an expense to staff from another branch, and clearing is allowed.
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

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };
const CLERK = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };

function stubDb({ session, expenses = [], users = [] } = {}) {
  const realFetch = global.fetch;
  const patches = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/users')) {
      const id = decodeURIComponent((u.match(/[?&]id=eq\.([^&]+)/) || [])[1] || '');
      const branch = decodeURIComponent((u.match(/branch_id=eq\.([^&]+)/) || [])[1] || '');
      return { text: async () => JSON.stringify(users.filter((x) =>
        (!id || x.id === id) &&
        (!branch || x.branch_id === branch) &&
        (!u.includes('role=eq.staff') || x.role === 'staff') &&
        (!u.includes('active=eq.true') || x.active === true))) };
    }
    if (u.includes('/expenses')) {
      const id = decodeURIComponent((u.match(/[?&]id=eq\.([^&]+)/) || [])[1] || '');
      const branch = decodeURIComponent((u.match(/branch_id=eq\.([^&]+)/) || [])[1] || '');
      if (method === 'PATCH') {
        const body = opt.body ? JSON.parse(opt.body) : {};
        patches.push({ url: u, body });
        const hit = expenses.find((x) => x.id === id && (!branch || x.branch_id === branch) && !x.deleted_at);
        if (hit) {
          Object.assign(hit, body);
          return { text: async () => JSON.stringify([{ ...hit }]) };
        }
        return { text: async () => JSON.stringify([]) };
      }
      return { text: async () => JSON.stringify(expenses.filter((x) =>
        (!id || x.id === id) &&
        (!branch || x.branch_id === branch) &&
        !x.deleted_at)) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, patches, expenses };
}

async function call(body, { token = 't' } = {}) {
  const app = express();
  mountExpenses(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/expenses', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

test('staff assign: flag OFF -> 404 (personal product has no staff assignment surface)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await call({ ids: ['e1'], staff_user_id: 's1' });
    assert.strictEqual(status, 404);
  });
});

test('staff assign: clerk assigns only own-branch rows to own-branch staff', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: CLERK,
      users: [{ id: 'sA', role: 'staff', active: true, branch_id: 'bA', display_name: 'Ali' }],
      expenses: [{ id: 'e1', branch_id: 'bA' }, { id: 'e2', branch_id: 'bB' }],
    });
    try {
      const { status, json } = await call({ ids: ['e1', 'e2'], staff_user_id: 'sA' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.updated, 1);
      assert.deepStrictEqual(json.results.map((r) => ({ id: r.id, ok: r.ok, code: r.code })), [
        { id: 'e1', ok: true, code: undefined },
        { id: 'e2', ok: false, code: 404 },
      ]);
      assert.strictEqual(stub.patches.length, 1);
      assert.match(stub.patches[0].url, /branch_id=eq\.bA/);
      assert.strictEqual(stub.patches[0].body.staff_user_id, 'sA');
    } finally { stub.restore(); }
  });
});

test('staff assign: clerk cannot use another branch staff member', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: CLERK,
      users: [{ id: 'sB', role: 'staff', active: true, branch_id: 'bB', display_name: 'Bea' }],
      expenses: [{ id: 'e1', branch_id: 'bA' }],
    });
    try {
      const { status } = await call({ ids: ['e1'], staff_user_id: 'sB' });
      assert.strictEqual(status, 403);
      assert.strictEqual(stub.patches.length, 0);
    } finally { stub.restore(); }
  });
});

test('staff assign: admin cannot assign an expense to staff from a different branch', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({
      session: ADMIN,
      users: [{ id: 'sA', role: 'staff', active: true, branch_id: 'bA', display_name: 'Ali' }],
      expenses: [{ id: 'e1', branch_id: 'bB' }],
    });
    try {
      const { status, json } = await call({ ids: ['e1'], staff_user_id: 'sA' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.updated, 0);
      assert.deepStrictEqual(json.results, [{ id: 'e1', ok: false, code: 403, error: 'staff belongs to another branch' }]);
      assert.strictEqual(stub.patches.length, 0);
    } finally { stub.restore(); }
  });
});

test('staff assign: null staff_user_id clears existing assignment', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, expenses: [{ id: 'e1', branch_id: 'bA', staff_user_id: 'sA' }] });
    try {
      const { status, json } = await call({ ids: ['e1'], staff_user_id: null });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.updated, 1);
      assert.strictEqual(stub.patches[0].body.staff_user_id, null);
    } finally { stub.restore(); }
  });
});

test('staff assign: malformed bodies are rejected before writes', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, expenses: [{ id: 'e1', branch_id: 'bA' }] });
    try {
      for (const body of [{ ids: [], staff_user_id: null }, { ids: [1], staff_user_id: null }, { ids: ['e1'], staff_user_id: '' }, {}]) {
        const { status } = await call(body);
        assert.strictEqual(status, 400, JSON.stringify(body));
      }
      assert.strictEqual(stub.patches.length, 0);
    } finally { stub.restore(); }
  });
});
