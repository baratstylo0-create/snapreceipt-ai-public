'use strict';
// api.js's apiFetch/fetchBlob are the ONE choke point every dashboard view calls through
// (Overview, Activity, Team, ...). Today a 401 (expired/invalid session) just throws — each
// caller's own .catch renders its own generic "could not load" message, with no way for the
// user to tell "server hiccup" from "you're logged out" (Owner-reported live incident,
// 2026-07-11: every panel failed the same way after the session's 12h TTL lapsed; only a
// manual logout+login fixed it). onAuthExpired is a global notification hook so app.js can
// react ONCE, everywhere, instead of every view showing its own dead-end error.
//
// Rule (deliberately narrow): only fire when a bearer token was actually attached to the
// FAILING request. This is what tells a real "your session died" 401 (a token was sent and
// rejected) apart from an expected, unauthenticated 401 like a wrong-password POST /api/login
// attempt (no token exists yet — that 401 is normal login-form feedback, not a session death,
// and must not yank the login form away out from under the user mid-attempt).
const test = require('node:test');
const assert = require('node:assert');
const Api = require('../../public/js/api');

// 2026-08-24: apiFetch/fetchBlob now retry once (after a short delay) before treating a
// 401 as a real session death — see api.js's own doc comment. Drop the delay to 0 so
// these tests don't actually wait ~600ms per 401 case.
Api.setAuthRetryDelayForTests(0);

function fakeRes(status, body, headers) {
  headers = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function (k) { return headers[k] || null; } },
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)); },
  };
}

test('onAuthExpired fires on a 401 WHEN a bearer token was attached to the request', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(401, { error: 'unauthorized' }, { 'content-type': 'application/json' }));
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  await assert.rejects(() => Api.apiFetch('/api/reports'));
  assert.strictEqual(fired, true);
  Api.setToken(null);
  global.fetch = origFetch;
});

test('onAuthExpired does NOT fire on a 401 with no token attached (e.g. a login attempt)', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(401, { error: 'invalid credentials' }, { 'content-type': 'application/json' }));
  Api.setToken(null); // no token — mirrors POST /api/login with a wrong password
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  await assert.rejects(() => Api.apiFetch('/api/login', { method: 'POST', body: { username: 'x', password: 'wrong' } }));
  assert.strictEqual(fired, false);
  global.fetch = origFetch;
});

test('onAuthExpired does NOT fire on a non-401 error (e.g. a 502) with a token attached', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(502, { error: 'report failed' }, { 'content-type': 'application/json' }));
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  await assert.rejects(() => Api.apiFetch('/api/reports'));
  assert.strictEqual(fired, false);
  Api.setToken(null);
  global.fetch = origFetch;
});

test('onAuthExpired fires on a 401 from fetchBlob too (the /receipt/:fileId path)', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(401, 'unauthorized'));
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  await assert.rejects(() => Api.fetchBlob('/receipt/abc123'));
  assert.strictEqual(fired, true);
  Api.setToken(null);
  global.fetch = origFetch;
});

test('a bad subscriber never breaks the underlying fetch (matches onRateLimit\'s own guard)', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(401, {}, { 'content-type': 'application/json' }));
  Api.setToken('sess-abc');
  Api.onAuthExpired(() => { throw new Error('boom'); });
  await assert.rejects(() => Api.apiFetch('/api/reports')); // still rejects with the real {status,body} error, not the subscriber's throw
  Api.setToken(null);
  global.fetch = origFetch;
});

test('a single transient 401 (server hiccup) does NOT log the user out if the retry succeeds', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = () => {
    calls++;
    if (calls === 1) return Promise.resolve(fakeRes(401, { error: 'unauthorized' }, { 'content-type': 'application/json' }));
    return Promise.resolve(fakeRes(200, { ok: true }, { 'content-type': 'application/json' }));
  };
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  const body = await Api.apiFetch('/api/reports'); // resolves — never rejects — once the retry succeeds
  assert.deepStrictEqual(body, { ok: true });
  assert.strictEqual(calls, 2, 'exactly one retry, not a retry loop');
  assert.strictEqual(fired, false, 'a session that turns out to still be valid must never trigger a logout');
  Api.setToken(null);
  global.fetch = origFetch;
});

test('two 401s in a row (genuinely dead session) still logs the user out — retry does not weaken real expiry', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = () => { calls++; return Promise.resolve(fakeRes(401, { error: 'unauthorized' }, { 'content-type': 'application/json' })); };
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  await assert.rejects(() => Api.apiFetch('/api/reports'));
  assert.strictEqual(calls, 2, 'one original request + one retry, not more');
  assert.strictEqual(fired, true);
  Api.setToken(null);
  global.fetch = origFetch;
});

test('fetchBlob also retries once before logging out (mirrors apiFetch)', async () => {
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = () => {
    calls++;
    if (calls === 1) return Promise.resolve(fakeRes(401, 'unauthorized'));
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, blob: () => Promise.resolve('the-blob') });
  };
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  const blob = await Api.fetchBlob('/receipt/abc123');
  assert.strictEqual(blob, 'the-blob');
  assert.strictEqual(calls, 2);
  assert.strictEqual(fired, false);
  Api.setToken(null);
  global.fetch = origFetch;
});

test('a normal 2xx call does not notify onAuthExpired', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve(fakeRes(200, { ok: true }, { 'content-type': 'application/json' }));
  Api.setToken('sess-abc');
  let fired = false;
  Api.onAuthExpired(() => { fired = true; });
  const body = await Api.apiFetch('/api/reports');
  assert.deepStrictEqual(body, { ok: true });
  assert.strictEqual(fired, false);
  Api.setToken(null);
  global.fetch = origFetch;
});
