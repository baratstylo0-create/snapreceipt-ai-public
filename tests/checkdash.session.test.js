'use strict';
// checkDash in BUSINESS mode (ADR-021): when capabilities.multiUser is ON, the static
// DASHBOARD_TOKEN gate is replaced by opaque session resolution. A valid session →
// 200 with req.scope attached; no/invalid session → 401. The personal path (flag OFF)
// is covered by tests/checkdash.auth.test.js and is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { checkDash } = require('../routes/expenses');
const { tokenHash } = require('../lib/auth');

// Build an app that echoes whatever scope checkDash attaches, so we can assert it.
function appWithGate() {
  const app = express();
  app.get('/probe', checkDash, (req, res) => res.json({ ok: true, scope: req.scope || null }));
  return app;
}

async function get(app, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/probe', { headers });
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

// Stub ONLY the Supabase sessions lookup; delegate every other fetch (notably the
// test's own HTTP call to the Express probe server) to the real implementation.
// `rowFor(hash)` returns the session row (or undefined).
function stubSessions(rowFor) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes('/sessions?token_hash=')) {
      const m = /token_hash=eq\.([0-9a-f]+)/.exec(u);
      const row = m ? rowFor(m[1]) : undefined;
      return { text: async () => JSON.stringify(row ? [row] : []) };
    }
    return realFetch(url, opt);
  };
  return { restore: () => { global.fetch = realFetch; } };
}

test('business mode + valid session -> 200 and req.scope resolved (clerk branch-filtered)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const token = 'live-clerk-token';
    const stub = stubSessions((h) => h === tokenHash(token)
      ? { user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1',
          expires_at: new Date(Date.now() + 60000).toISOString() }
      : undefined);
    try {
      const { status, json } = await get(appWithGate(), { Authorization: 'Bearer ' + token });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.scope, { account_id: 'default', branch_id: 'b1', role: 'clerk' });
    } finally { stub.restore(); }
  });
});

test('business mode + admin session -> scope has no branch filter (sees all branches)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const token = 'live-admin-token';
    const stub = stubSessions(() => ({ user_id: 'a1', account_id: 'default', role: 'admin', branch_id: null,
      expires_at: new Date(Date.now() + 60000).toISOString() }));
    try {
      const { status, json } = await get(appWithGate(), { Authorization: 'Bearer ' + token });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.scope, { account_id: 'default', role: 'admin' });
      assert.ok(!('branch_id' in json.scope));
    } finally { stub.restore(); }
  });
});

test('business mode + no bearer -> 401', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubSessions(() => undefined);
    try {
      const { status } = await get(appWithGate(), {});
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('business mode + unknown/expired token -> 401', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubSessions(() => undefined); // no matching session row
    try {
      const { status } = await get(appWithGate(), { Authorization: 'Bearer ghost' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});
