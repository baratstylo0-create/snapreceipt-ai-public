'use strict';
// routes/expenses.js — B8 (QA round, docs/qa/2026-07-09-qa-round.md PR-B): permanent delete on
// REJECTED bills only. One-click, no confirmation (Owner explicit) — that's a frontend concern;
// the backend contract is: DELETE /api/expenses/:id/permanent hard-deletes iff the row's
// status is 'rejected', respecting the same clerk/admin scope as the existing soft-DELETE.
// Anything else (pending/saved/approved/not-found/wrong-branch) must refuse without writing.
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

function stubDb({ session, rows = [], deleteRows = [{ id: 'e-any' }] } = {}) {
  const realFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) {
      if (method === 'DELETE') {
        writes.push({ url: u, method });
        return { text: async () => JSON.stringify(deleteRows) };
      }
      if (method === 'PATCH') {
        writes.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : undefined });
        return { text: async () => JSON.stringify([{ id: 'e-any' }]) };
      }
      return { text: async () => JSON.stringify(rows) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, writes };
}

async function call(method, path, { token } = {}) {
  const app = express();
  mountExpenses(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };

test('DELETE /api/expenses/:id/permanent: admin hard-deletes a rejected row -> 200, one DELETE issued', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [{ id: 'e1', status: 'rejected', branch_id: 'bA' }] });
    try {
      const { status, json } = await call('DELETE', '/api/expenses/e1/permanent', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.ok, true);
      assert.strictEqual(s.writes.length, 1);
      assert.strictEqual(s.writes[0].method, 'DELETE');
      assert.match(s.writes[0].url, /status=eq\.rejected/);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id/permanent: non-rejected row -> 409, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [{ id: 'e1', status: 'saved', branch_id: 'bA' }] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e1/permanent', { token: 't' });
      assert.strictEqual(status, 409);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id/permanent: row not found -> 404, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e1/permanent', { token: 't' });
      assert.strictEqual(status, 404);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id/permanent: clerk on another branch\'s rejected row -> 403, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'e2', status: 'rejected', branch_id: 'bB' }] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e2/permanent', { token: 't' });
      assert.strictEqual(status, 403);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id/permanent: clerk on OWN branch\'s rejected row -> 200, DELETE issued', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'e1', status: 'rejected', branch_id: 'bA' }] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e1/permanent', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(s.writes.length, 1);
      assert.match(s.writes[0].url, /status=eq\.rejected/);
    } finally { s.restore(); }
  });
});

test('DELETE /api/expenses/:id/permanent: rejected status predicate is atomic with DELETE', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    // The SELECT sees a rejected row, but the DELETE returns zero rows (e.g. status changed
    // between the read and the delete). The route must not report success.
    const s = stubDb({ session: ADMIN, rows: [{ id: 'e1', status: 'rejected', branch_id: 'bA' }], deleteRows: [] });
    try {
      const { status } = await call('DELETE', '/api/expenses/e1/permanent', { token: 't' });
      assert.strictEqual(status, 409);
      assert.strictEqual(s.writes.length, 1);
      assert.match(s.writes[0].url, /status=eq\.rejected/);
    } finally { s.restore(); }
  });
});
