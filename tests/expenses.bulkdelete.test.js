'use strict';
// routes/expenses.js — B4 (QA round, docs/qa/2026-07-09-qa-round.md PR-B): bulk select ->
// Delete on the Activity list. POST /api/expenses/bulk-delete applies the SAME per-row
// canTouchExpense + sbSoftDelete path the single DELETE /api/expenses/:id already uses, just
// looped over a batch of ids — no new business rule, just orchestration.
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

function stubDb({ session, rowsById = {} } = {}) {
  const realFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) {
      // sbSoftDelete issues a PATCH (deleted_at stamp), not a DELETE — same underlying
      // HTTP verb as the single DELETE /api/expenses/:id route this bulk endpoint reuses.
      if (method === 'PATCH') {
        writes.push({ url: u, method });
        return { text: async () => JSON.stringify([{ id: 'e-any' }]) };
      }
      // canTouchExpense fetches by id=eq.<id> with no other filter. Anchor on [?&] so this
      // doesn't false-match the "id=eq." substring inside "account_id=eq.default".
      const m = u.match(/[?&]id=eq\.([^&]+)/);
      const id = m ? decodeURIComponent(m[1]) : null;
      const row = id && rowsById[id] ? [rowsById[id]] : [];
      return { text: async () => JSON.stringify(row) };
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

test('POST /api/expenses/bulk-delete: admin bulk-deletes -> 200, one DELETE per id', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN, rowsById: { e1: { id: 'e1', branch_id: 'bHQ' }, e2: { id: 'e2', branch_id: 'bA' } } });
    try {
      const { status, json } = await call('POST', '/api/expenses/bulk-delete', { token: 't', body: { ids: ['e1', 'e2'] } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.requested, 2);
      assert.strictEqual(json.deleted, 2);
      assert.strictEqual(s.writes.length, 2);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/bulk-delete: clerk deleting a mix of own/other-branch rows -> only own-branch id deleted', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A, rowsById: { e1: { id: 'e1', branch_id: 'bA' }, e2: { id: 'e2', branch_id: 'bB' } } });
    try {
      const { status, json } = await call('POST', '/api/expenses/bulk-delete', { token: 't', body: { ids: ['e1', 'e2'] } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.requested, 2);
      assert.strictEqual(json.deleted, 1);
      assert.strictEqual(s.writes.length, 1);
      const failed = json.results.find((r) => r.id === 'e2');
      assert.strictEqual(failed.ok, false);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/bulk-delete: empty/missing ids -> 400, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN });
    try {
      const r1 = await call('POST', '/api/expenses/bulk-delete', { token: 't', body: { ids: [] } });
      assert.strictEqual(r1.status, 400);
      const r2 = await call('POST', '/api/expenses/bulk-delete', { token: 't', body: {} });
      assert.strictEqual(r2.status, 400);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses/bulk-delete: too many ids -> 413, nothing written', async () => {
  // BULK_DELETE_MAX_IDS is read once at module-require time (mirrors BULK_PAY_MAX_IDS), so an
  // env override here wouldn't take effect — exceed the real default (200) instead.
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN });
    const tooMany = Array.from({ length: 201 }, (_, i) => 'id' + i);
    try {
      const { status } = await call('POST', '/api/expenses/bulk-delete', { token: 't', body: { ids: tooMany } });
      assert.strictEqual(status, 413);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});
