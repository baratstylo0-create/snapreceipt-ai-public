'use strict';
// routes/expenses.js Phase 6 (ADR-021, SEC-2): clerk isolation on the expense surface itself.
// GET /api/expenses is branch-filtered for a clerk; PATCH/DELETE /api/expenses/:id refuse a
// clerk touching another branch's row (403, nothing written). Admin + personal mode unchanged.
// Session lookup + expenses reads/writes all ride global.fetch (lib/supabase -> hreq -> fetch).
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

function stubDb({ session, rows = [] } = {}) {
  const realFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) {
      if (method === 'PATCH' || method === 'DELETE') {
        writes.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : undefined });
        return { text: async () => JSON.stringify([{ id: 'e-any' }]) };
      }
      return { text: async () => JSON.stringify(rows) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, writes };
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
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };
const MIXED = [
  { id: 'e1', merchant: 'Cafe', branch_id: 'bA' },
  { id: 'e2', merchant: 'Fuel', branch_id: 'bB' },
  { id: 'e3', merchant: 'Untagged', branch_id: null },
];

test('GET /api/expenses: clerk sees only own-branch rows; admin sees all', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    let s = stubDb({ session: CLERK_A, rows: MIXED });
    try {
      const { status, json } = await call('GET', '/api/expenses', { token: 't' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.map((e) => e.id), ['e1'], 'branch bB + untagged rows hidden from a clerk');
    } finally { s.restore(); }

    s = stubDb({ session: ADMIN, rows: MIXED });
    try {
      const { json } = await call('GET', '/api/expenses', { token: 't' });
      assert.strictEqual(json.length, 3);
    } finally { s.restore(); }
  });
});

test('PATCH /api/expenses/:id: clerk editing another branch\'s row -> 403, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'e2', merchant: 'Fuel', branch_id: 'bB' }] });
    try {
      const { status } = await call('PATCH', '/api/expenses/e2', { token: 't', body: { merchant: 'Hacked' } });
      assert.strictEqual(status, 403);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('PATCH /api/expenses/:id: clerk editing an OWN-branch row proceeds', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'e1', merchant: 'Cafe', branch_id: 'bA' }] });
    try {
      const { status } = await call('PATCH', '/api/expenses/e1', { token: 't', body: { merchant: 'Cafe KL' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(s.writes.length, 1);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id: clerk deleting another branch\'s row -> 403, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'e2', branch_id: 'bB' }] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e2', { token: 't' });
      assert.strictEqual(status, 403);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});
