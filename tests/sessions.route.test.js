'use strict';
// routes/sessions.js — P-02a device-management endpoints (issue #35).
//
// The load-bearing property across this file is horizontal isolation: every one of these
// routes is reachable by any authenticated user, and each addresses rows BY ID. If the
// user_id boundary were ever dropped, one customer could enumerate and revoke another's
// sessions. Several tests below exist purely to make that failure loud.
process.env.CAP_PERSONAL_AUTH = 'true';
process.env.SESSIONS_READ_RATE_MAX = '1000';
process.env.SESSIONS_REVOKE_RATE_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { createFakePostgrest } = require('./fixtures/fakePostgrest');
const mountSessions = require('../routes/sessions');
const { tokenHash } = require('../lib/auth');
const ds = require('../lib/deviceSessions');

const HOUR = 60 * 60 * 1000;
const FUTURE = new Date(Date.now() + 12 * HOUR).toISOString();

function session(over = {}) {
  return {
    id: 's-1', account_id: 'default', token_hash: tokenHash('tok-mine'), user_id: 'u-1',
    role: 'owner', branch_id: null, created_at: new Date(Date.now() - HOUR).toISOString(),
    expires_at: FUTURE, last_seen_at: null, user_agent: 'Mozilla/5.0 (Windows NT 10.0)',
    ip_hash: ds.hashIp('203.0.113.5'), ...over,
  };
}

function withServer(seed, fn) {
  const fake = createFakePostgrest(seed);
  const realFetch = global.fetch;
  fake.install();
  const a = express();
  a.set('trust proxy', true);
  mountSessions(a);
  const srv = a.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;

  async function req(method, path, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await realFetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  return Promise.resolve().then(() => fn({ req, db: fake.db }))
    .finally(() => { srv.close(); global.fetch = realFetch; });
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

// ---- gating and authentication ---------------------------------------------

test('every route 404s when the deployment has no session concept', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'false', CAP_MULTI_USER: 'false' }, async () => {
    await withServer({ sessions: [session()] }, async ({ req }) => {
      assert.strictEqual((await req('GET', '/api/sessions', { token: 'tok-mine' })).status, 404);
      assert.strictEqual((await req('GET', '/api/sessions/events', { token: 'tok-mine' })).status, 404);
      assert.strictEqual((await req('DELETE', '/api/sessions/s-1', { token: 'tok-mine' })).status, 404);
      assert.strictEqual((await req('POST', '/api/sessions/revoke-others', { token: 'tok-mine' })).status, 404);
    });
  });
});

test('every route requires a live session', async () => {
  await withServer({ sessions: [session()] }, async ({ req }) => {
    for (const [method, path] of [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/events'],
      ['DELETE', '/api/sessions/s-1'], ['POST', '/api/sessions/revoke-others'],
    ]) {
      assert.strictEqual((await req(method, path)).status, 401, method + ' ' + path + ' without a token');
      assert.strictEqual((await req(method, path, { token: 'not-a-real-token' })).status, 401, method + ' ' + path + ' with a bogus token');
    }
  });
});

test('an EXPIRED session cannot manage devices', async () => {
  await withServer({
    sessions: [session({ token_hash: tokenHash('stale'), expires_at: new Date(Date.now() - HOUR).toISOString() })],
  }, async ({ req }) => {
    assert.strictEqual((await req('GET', '/api/sessions', { token: 'stale' })).status, 401);
  });
});

// ---- listing ----------------------------------------------------------------

test('GET /api/sessions lists my devices and flags the current one', async () => {
  await withServer({
    sessions: [session(), session({ id: 's-2', token_hash: tokenHash('tok-phone') })],
  }, async ({ req }) => {
    const { status, json } = await req('GET', '/api/sessions', { token: 'tok-mine' });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.devices.length, 2);
    assert.strictEqual(json.devices.find((d) => d.id === 's-1').current, true);
    assert.strictEqual(json.devices.find((d) => d.id === 's-2').current, false);
  });
});

test('GET /api/sessions never serialises a credential-derived or tracking value', async () => {
  await withServer({ sessions: [session()] }, async ({ req }) => {
    const { json } = await req('GET', '/api/sessions', { token: 'tok-mine' });
    const blob = JSON.stringify(json);
    assert.ok(!blob.includes(tokenHash('tok-mine')), 'no token hash');
    assert.ok(!blob.includes('tok-mine'), 'and certainly no raw token');
    assert.ok(!blob.includes(ds.hashIp('203.0.113.5')), 'no ip hash');
  });
});

test('GET /api/sessions shows ONLY my own devices', async () => {
  await withServer({
    sessions: [session(), session({ id: 's-theirs', token_hash: tokenHash('theirs'), user_id: 'u-2' })],
  }, async ({ req }) => {
    const { json } = await req('GET', '/api/sessions', { token: 'tok-mine' });
    assert.deepStrictEqual(json.devices.map((d) => d.id), ['s-1']);
  });
});

test('GET /api/sessions/events returns my timeline without the ip hash', async () => {
  await withServer({
    sessions: [session()],
    auth_events: [
      { id: 'e1', user_id: 'u-1', event: 'login_ok', ip_hash: ds.hashIp('203.0.113.5'), user_agent: 'Chrome', created_at: '2026-08-20T00:00:00.000Z' },
      { id: 'e2', user_id: 'u-2', event: 'login_ok', ip_hash: 'other', user_agent: 'Edge', created_at: '2026-08-21T00:00:00.000Z' },
    ],
  }, async ({ req }) => {
    const { status, json } = await req('GET', '/api/sessions/events', { token: 'tok-mine' });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.events, [{ event: 'login_ok', created_at: '2026-08-20T00:00:00.000Z', user_agent: 'Chrome' }]);
    assert.ok(!JSON.stringify(json).includes(ds.hashIp('203.0.113.5')),
      'a stable per-network identifier must not leave the server');
  });
});

// ---- revoking ---------------------------------------------------------------

test('DELETE /api/sessions/:id signs that device out', async () => {
  await withServer({
    sessions: [session(), session({ id: 's-2', token_hash: tokenHash('tok-phone') })],
  }, async ({ req, db }) => {
    const { status, json } = await req('DELETE', '/api/sessions/s-2', { token: 'tok-mine' });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.ok, true);
    assert.deepStrictEqual(db.sessions.map((s) => s.id), ['s-1']);
    assert.ok(db.auth_events.some((e) => e.event === 'session_revoked'), 'and it is recorded on the timeline');
  });
});

test('DELETE /api/sessions/:id CANNOT touch another account\'s session', async () => {
  // The isolation test that matters most in this file.
  await withServer({
    sessions: [session(), session({ id: 's-victim', token_hash: tokenHash('victim'), user_id: 'u-victim' })],
  }, async ({ req, db }) => {
    const { status } = await req('DELETE', '/api/sessions/s-victim', { token: 'tok-mine' });
    assert.strictEqual(status, 404, 'and 404 — not 403, which would confirm the id exists');
    assert.ok(db.sessions.some((s) => s.id === 's-victim'), "the victim's session must survive");
  });
});

test('DELETE /api/sessions/:id on an unknown id is a plain 404', async () => {
  await withServer({ sessions: [session()] }, async ({ req }) => {
    assert.strictEqual((await req('DELETE', '/api/sessions/does-not-exist', { token: 'tok-mine' })).status, 404);
  });
});

test('POST revoke-others clears my other devices and keeps me signed in', async () => {
  await withServer({
    sessions: [
      session({ id: 's-1', token_hash: tokenHash('tok-mine') }),
      session({ id: 's-2', token_hash: tokenHash('tok-phone') }),
      session({ id: 's-3', token_hash: tokenHash('tok-laptop') }),
    ],
  }, async ({ req, db }) => {
    const { status, json } = await req('POST', '/api/sessions/revoke-others', { token: 'tok-mine' });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.revoked, 2);
    assert.deepStrictEqual(db.sessions.map((s) => s.id), ['s-1']);

    // And the caller's session still works afterwards — the whole point.
    assert.strictEqual((await req('GET', '/api/sessions', { token: 'tok-mine' })).status, 200);
  });
});

test('POST revoke-others never reaches another account', async () => {
  await withServer({
    sessions: [session(), session({ id: 's-theirs', token_hash: tokenHash('theirs'), user_id: 'u-2' })],
  }, async ({ req, db }) => {
    await req('POST', '/api/sessions/revoke-others', { token: 'tok-mine' });
    assert.ok(db.sessions.some((s) => s.id === 's-theirs'));
  });
});
