'use strict';
// routes/auth.js's DELETE /api/account — previously had ZERO dedicated test coverage, which
// is exactly how a real live bug slipped through: a Google-only owner (password_hash null,
// routes/googleAuth.js) could never pass this endpoint at all, no matter what they typed,
// because the old code fell back to the login route's DUMMY_HASH (deliberately unmatchable
// by design) instead of skipping the password check for an account with no password.
// 2026-08-19 fix: `confirmText` (the frontend's "Type DELETE to confirm" field, previously
// client-side-only) is now the universal server-side gate; password re-entry is required
// ADDITIONALLY, but only when the account actually has a password_hash to check.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountAuth = require('../routes/auth');
const { hashPassword, tokenHash } = require('../lib/auth');

function app() {
  const a = express();
  mountAuth(a);
  return a;
}

async function del(a, path, { headers = {}, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
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

const TOKEN = 'test-raw-token-abc';
const USER_ID = 'u-owner-1';

// Stubs: /sessions (lookupSession's GET), /users (the owner lookup GET + sbHardDelete's
// DELETE — this harness is method-agnostic, matching auth.route.test.js's own pattern),
// /expenses (the created_by_user_id soft-delete-before-hard-delete step).
function stubSupabase({ user, ownedExpenses = [] } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = opt.method || 'GET';
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : undefined });
    if (u.includes('/sessions')) {
      return { text: async () => JSON.stringify([{
        token_hash: tokenHash(TOKEN), user_id: USER_ID, account_id: 'acct1', role: 'owner',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }]) };
    }
    if (u.includes('/expenses')) {
      if (method === 'PATCH') return { text: async () => JSON.stringify([{ id: 'e1', deleted_at: new Date().toISOString() }]) };
      return { text: async () => JSON.stringify(ownedExpenses) };
    }
    if (u.includes('/users')) {
      if (method === 'DELETE') return { text: async () => JSON.stringify([{ id: USER_ID }]) };
      return { text: async () => JSON.stringify(user ? [user] : []) };
    }
    return realFetch(url, opt);
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

test('delete account: capability OFF -> 404', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'false' }, async () => {
    const { status } = await del(app(), '/api/account', { body: { password: 'x', confirmText: 'DELETE' } });
    assert.strictEqual(status, 404);
  });
});

test('delete account: no Authorization header -> 401', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const { status } = await del(app(), '/api/account', { body: { password: 'x', confirmText: 'DELETE' } });
    assert.strictEqual(status, 401);
  });
});

test('delete account: confirmText missing/wrong -> 400, checked before password/session work', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const { status, json } = await del(app(), '/api/account', {
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: { password: 'x', confirmText: 'delete' }, // wrong case
    });
    assert.strictEqual(status, 400);
    assert.strictEqual(json.error, 'type DELETE to confirm');
  });
});

test('delete account: PASSWORD-LESS (Google-only) owner — no password needed, confirmText alone is enough (the bug fix)', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({ user: { id: USER_ID, role: 'owner', password_hash: null } });
    try {
      const { status, json } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { confirmText: 'DELETE' }, // no password field at all — must still succeed
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, { ok: true });
      const hardDelete = stub.calls.find((c) => c.method === 'DELETE' && c.url.includes('/users'));
      assert.ok(hardDelete, 'the user row was actually hard-deleted');
    } finally { stub.restore(); }
  });
});

test('delete account: password-having owner + correct password + DELETE -> 200', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    const stub = stubSupabase({ user: { id: USER_ID, role: 'owner', password_hash: hash } });
    try {
      const { status, json } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { password: 'correct horse battery staple', confirmText: 'DELETE' },
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json, { ok: true });
    } finally { stub.restore(); }
  });
});

test('delete account: password-having owner + WRONG password -> 400 "wrong password", user NOT deleted', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    const stub = stubSupabase({ user: { id: USER_ID, role: 'owner', password_hash: hash } });
    try {
      const { status, json } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { password: 'totally wrong', confirmText: 'DELETE' },
      });
      assert.strictEqual(status, 400);
      assert.strictEqual(json.error, 'wrong password');
      const hardDelete = stub.calls.find((c) => c.method === 'DELETE' && c.url.includes('/users'));
      assert.ok(!hardDelete, 'must NOT hard-delete on a wrong password');
    } finally { stub.restore(); }
  });
});

test('delete account: password-having owner + confirmText DELETE but NO password field -> 400 "password is required"', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const hash = await hashPassword('correct horse battery staple');
    const stub = stubSupabase({ user: { id: USER_ID, role: 'owner', password_hash: hash } });
    try {
      const { status, json } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { confirmText: 'DELETE' },
      });
      assert.strictEqual(status, 400);
      assert.strictEqual(json.error, 'password is required');
    } finally { stub.restore(); }
  });
});

test('delete account: non-owner role (e.g. business staff row) -> 403 forbidden', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({ user: { id: USER_ID, role: 'clerk', password_hash: null } });
    try {
      const { status, json } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { confirmText: 'DELETE' },
      });
      assert.strictEqual(status, 403);
      assert.strictEqual(json.error, 'forbidden');
    } finally { stub.restore(); }
  });
});

test('delete account: owner\'s own captured receipts (created_by_user_id) are soft-deleted before the hard-delete', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true' }, async () => {
    const stub = stubSupabase({
      user: { id: USER_ID, role: 'owner', password_hash: null },
      ownedExpenses: [{ id: 'e1' }, { id: 'e2' }],
    });
    try {
      const { status } = await del(app(), '/api/account', {
        headers: { Authorization: 'Bearer ' + TOKEN },
        body: { confirmText: 'DELETE' },
      });
      assert.strictEqual(status, 200);
      const softDeletes = stub.calls.filter((c) => c.method === 'PATCH' && c.url.includes('/expenses'));
      assert.strictEqual(softDeletes.length, 2, 'both owned expense rows get soft-deleted');
    } finally { stub.restore(); }
  });
});
