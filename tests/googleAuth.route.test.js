'use strict';
// routes/googleAuth.js — GET /api/auth/google/callback (2026-07-30 Google Sign-In).
// Previously had NO test coverage at all. Added alongside the 2026-08-14 security fix:
// a brand-new owner account must get its own unique account_id (see lib/personalAuth.js
// genAccountId's doc comment, and lib/auth.js mintSession/lookupSession) — before the fix,
// this route left account_id unset, so it fell back to the shared DB-default 'default',
// the same value every other personal account got, which is what let two real accounts
// see each other's receipts.
//
// exchangeCode/verifyIdToken talk to real Google endpoints in production; here they're
// monkeypatched on the lib/googleAuth module object BEFORE routes/googleAuth.js is required,
// so its top-level `const { exchangeCode, verifyIdToken } = require(...)` destructuring
// captures the patched (test) versions — same trick, same reasoning as any other
// dependency-injection seam in this codebase, just applied at the module boundary since this
// particular route has none of its own.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const googleAuthLib = require('../lib/googleAuth');
googleAuthLib.isConfigured = () => true;
googleAuthLib.exchangeCode = async () => ({ idToken: 'fake-id-token', accessToken: 'fake-access' });
googleAuthLib.verifyIdToken = async () => ({ email: 'new.owner@example.com', name: 'New Owner' });

const mountGoogleAuth = require('../routes/googleAuth');

function app() {
  const a = express();
  mountGoogleAuth(a);
  return a;
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

// Stub Supabase (`users`/`bot_bindings`) the same way tests/auth.route.test.js does; anything
// else (the test's own probe against the running Express server) hits the real fetch.
function stubSupabase(handlers) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    // A GET carries a query string (/users?...); an INSERT (sbInsertReturning) does not
    // (/users, no '?' — lib/supabase.js's sbInsertReturning builds no query at all) — match
    // both by checking for the path segment alone, not '?'.
    if (u.includes('/users')) {
      calls.push({ url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined });
      return { text: async () => JSON.stringify(handlers.users ? handlers.users(u, opt) : []) };
    }
    if (u.includes('/bot_bindings')) {
      calls.push({ url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined });
      return { text: async () => JSON.stringify(handlers.bindings ? handlers.bindings(u, opt) : []) };
    }
    // mintSession's POST /sessions — not under test here, just needs to not hit the real network.
    if (u.includes('/sessions')) {
      calls.push({ url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined });
      return { text: async () => '[]' };
    }
    return realFetch(url, opt);
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

// Drives the real redirect-based flow: GET /api/auth/google (grabs the state cookie Google
// would normally round-trip) -> GET /api/auth/google/callback?code&state (with that cookie).
async function runCallback(a) {
  const srv = a.listen(0);
  const { port } = srv.address();
  const base = 'http://127.0.0.1:' + port;
  try {
    const start = await fetch(base + '/api/auth/google', { redirect: 'manual' });
    const setCookie = start.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0]; // "g_oauth_state=<value>"
    const state = decodeURIComponent(cookie.split('=')[1] || '');
    const cb = await fetch(base + '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state),
      { redirect: 'manual', headers: { Cookie: cookie } });
    const location = cb.headers.get('location') || '';
    return { status: cb.status, location };
  } finally { srv.close(); }
}

test('google callback: brand-new signup gets its OWN account_id, not the shared default', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }, async () => {
    const stub = stubSupabase({
      users: (u, opt) => {
        if ((opt.method || 'GET') === 'GET') return []; // no existing account with this email
        return [{ id: 'newuser1', username: 'new.owner@example.com', account_id: JSON.parse(opt.body).account_id }];
      },
      bindings: () => [],
    });
    try {
      const { status, location } = await runCallback(app());
      assert.strictEqual(status, 302);
      assert.match(location, /gauth_token=/, 'redirects with a session token in the fragment');

      const userInsert = stub.calls.find((c) => c.url.includes('/users') && c.method === 'POST');
      const bindingInsert = stub.calls.find((c) => c.url.includes('/bot_bindings') && c.method === 'POST');
      assert.ok(userInsert, 'expected a users row to be created');
      assert.ok(userInsert.body.account_id, 'must carry a real account_id');
      assert.notStrictEqual(userInsert.body.account_id, 'default', 'must NOT be the shared literal default — the exact bug this fix closes');
      assert.ok(bindingInsert, 'expected a bot_bindings row to be created');
      assert.strictEqual(bindingInsert.body.account_id, userInsert.body.account_id, 'binding must match the user row exactly');
    } finally { stub.restore(); }
  });
});

test('google callback: an existing owner signing back in is NOT re-assigned a new account_id', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'true', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }, async () => {
    const stub = stubSupabase({
      users: () => [{ id: 'existing1', username: 'new.owner@example.com', role: 'owner', account_id: 'p_existing123', display_name: 'New Owner' }],
      bindings: () => [],
    });
    try {
      const { status, location } = await runCallback(app());
      assert.strictEqual(status, 302);
      assert.match(location, /gauth_token=/);
      const userInsert = stub.calls.find((c) => c.url.includes('/users') && c.method === 'POST');
      assert.strictEqual(userInsert, undefined, 'no new users row for a returning account');
    } finally { stub.restore(); }
  });
});
