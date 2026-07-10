'use strict';
// routes/expenses.js — B7 (QA round, docs/qa/2026-07-09-qa-round.md PR-B): "Recently deleted"
// bin + recover. Expenses already soft-delete via `deleted_at` (schema.sql line 32) — this is a
// view + restore on existing data, no schema change. GET /api/expenses/deleted lists soft-deleted
// rows (scoped like GET /api/expenses); POST /api/expenses/:id/restore clears deleted_at, scoped
// like every other write (clerk own-branch only, admin anywhere).
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

function stubDb({ session, rows = [], updateRows = [{ id: 'e-any', deleted_at: null }] } = {}) {
  const realFetch = global.fetch;
  const writes = [];
  const gets = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) {
      if (method === 'PATCH') {
        writes.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : undefined });
        return { text: async () => JSON.stringify(updateRows) };
      }
      gets.push(u);
      return { text: async () => JSON.stringify(rows) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, writes, gets };
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

test('GET /api/expenses/deleted: returns soft-deleted rows, filtering deleted_at=not.is.null', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const DELETED = [{ id: 'd1', merchant: 'Old', deleted_at: '2026-07-01T00:00:00Z', branch_id: 'bHQ' }];
    const s = stubDb({ session: ADMIN, rows: DELETED });
    try {
      const { status, json } = await call('GET', '/api/expenses/deleted', { token: 't' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.map((r) => r.id), ['d1']);
      assert.ok(s.gets.some((u) => u.includes('deleted_at=not.is.null')), 'must filter to deleted rows only');
    } finally { s.restore(); }
  });
});

test('GET /api/expenses/deleted: clerk sees only own-branch deleted rows', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const MIXED_DELETED = [
      { id: 'd1', branch_id: 'bA', deleted_at: '2026-07-01T00:00:00Z' },
      { id: 'd2', branch_id: 'bB', deleted_at: '2026-07-01T00:00:00Z' },
    ];
    const s = stubDb({ session: CLERK_A, rows: MIXED_DELETED });
    try {
      const { status, json } = await call('GET', '/api/expenses/deleted', { token: 't' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.map((r) => r.id), ['d1']);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: admin restores a deleted row -> 200, deleted_at cleared', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [{ id: 'd1', deleted_at: '2026-07-01T00:00:00Z', branch_id: 'bHQ' }] });
    try {
      const { status } = await call('POST', '/api/expenses/d1/restore', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(s.writes.length, 1);
      assert.strictEqual(s.writes[0].body.deleted_at, null);
      assert.match(s.writes[0].url, /deleted_at=not\.is\.null/);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: row not currently deleted -> 409, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [{ id: 'e1', deleted_at: null, branch_id: 'bHQ' }] });
    try {
      const { status } = await call('POST', '/api/expenses/e1/restore', { token: 't' });
      assert.strictEqual(status, 409);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: row not found -> 404, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rows: [] });
    try {
      const { status } = await call('POST', '/api/expenses/e1/restore', { token: 't' });
      assert.strictEqual(status, 404);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: clerk restoring another branch\'s deleted row -> 403, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'd2', deleted_at: '2026-07-01T00:00:00Z', branch_id: 'bB' }] });
    try {
      const { status } = await call('POST', '/api/expenses/d2/restore', { token: 't' });
      assert.strictEqual(status, 403);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: clerk restoring OWN-branch deleted row -> 200', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rows: [{ id: 'd1', deleted_at: '2026-07-01T00:00:00Z', branch_id: 'bA' }] });
    try {
      const { status } = await call('POST', '/api/expenses/d1/restore', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(s.writes.length, 1);
      assert.match(s.writes[0].url, /deleted_at=not\.is\.null/);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/:id/restore: deleted predicate is atomic with PATCH', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    // The SELECT sees a deleted row, but the PATCH matches zero rows (e.g. another request
    // already recovered it between read and write). The route must not report success.
    const s = stubDb({
      session: ADMIN,
      rows: [{ id: 'd1', deleted_at: '2026-07-01T00:00:00Z', branch_id: 'bHQ' }],
      updateRows: [],
    });
    try {
      const { status } = await call('POST', '/api/expenses/d1/restore', { token: 't' });
      assert.strictEqual(status, 409);
      assert.strictEqual(s.writes.length, 1);
      assert.match(s.writes[0].url, /deleted_at=not\.is\.null/);
    } finally { s.restore(); }
  });
});
