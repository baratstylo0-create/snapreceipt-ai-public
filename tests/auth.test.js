'use strict';
// lib/auth.js (ADR-021 Phase 1): scrypt password hashing, opaque sessions, and the
// frozen scopeForUser isolation contract. DB-touching session functions stub global.fetch
// (same pattern as tests/supabase.insertreturning.test.js).
const test = require('node:test');
const assert = require('node:assert');
const {
  hashPassword, verifyPassword,
  mintSession, lookupSession, revokeSessionsForUser, tokenHash,
  scopeForUser,
} = require('../lib/auth');

function stubFetch(respond) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const call = { url, method: opt.method || 'GET', headers: opt.headers, body: opt.body ? JSON.parse(opt.body) : undefined };
    calls.push(call);
    return { text: async () => JSON.stringify(respond(call)) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

// ---- password hashing -------------------------------------------------------

test('hashPassword/verifyPassword round-trips a correct password', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.strictEqual(await verifyPassword('correct horse battery staple', h), true);
});

test('verifyPassword rejects the wrong password', async () => {
  const h = await hashPassword('s3cret');
  assert.strictEqual(await verifyPassword('S3cret', h), false);
  assert.strictEqual(await verifyPassword('', h), false);
});

test('two hashes of the same password differ (random salt)', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notStrictEqual(a, b);
  assert.strictEqual(await verifyPassword('same', a), true);
  assert.strictEqual(await verifyPassword('same', b), true);
});

test('verifyPassword returns false (never throws) on malformed/absent stored hash', async () => {
  for (const bad of [null, undefined, '', 'notscrypt', 'scrypt$only', 'bcrypt$aa$bb', 'scrypt$$', 'scrypt$zz$zz']) {
    assert.strictEqual(await verifyPassword('x', bad), false);
  }
});

// ---- sessions ---------------------------------------------------------------

test('mintSession stores only the token hash and returns the raw token', async () => {
  const stub = stubFetch(() => []);
  try {
    const token = await mintSession({ id: 'u1', role: 'clerk', branch_id: 'b1' });
    assert.ok(token && token.length >= 32, 'returns a non-trivial raw token');
    const posted = stub.calls[0];
    assert.strictEqual(posted.method, 'POST');
    assert.match(posted.url, /\/sessions$/);
    assert.strictEqual(posted.body.token_hash, tokenHash(token), 'stores sha-256 of the token');
    assert.notStrictEqual(posted.body.token_hash, token, 'never stores the raw token');
    assert.strictEqual(posted.body.user_id, 'u1');
    assert.strictEqual(posted.body.role, 'clerk');
    assert.strictEqual(posted.body.branch_id, 'b1');
    assert.ok(posted.body.account_id, 'account-scoped');
    assert.ok(new Date(posted.body.expires_at).getTime() > Date.now(), 'has a future expiry');
  } finally { stub.restore(); }
});

test('mintSession stores null branch_id for an admin (all-branch)', async () => {
  const stub = stubFetch(() => []);
  try {
    await mintSession({ id: 'admin1', role: 'admin' });
    assert.strictEqual(stub.calls[0].body.branch_id, null);
  } finally { stub.restore(); }
});

test('lookupSession resolves a live session by token hash', async () => {
  const stub = stubFetch((call) => {
    assert.match(call.url, /token_hash=eq\./);
    return [{ user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1',
      expires_at: new Date(Date.now() + 60000).toISOString() }];
  });
  try {
    const s = await lookupSession('sometoken');
    assert.deepStrictEqual(s, { user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1' });
  } finally { stub.restore(); }
});

test('lookupSession returns null for a missing token, empty input, or expired session', async () => {
  assert.strictEqual(await lookupSession(''), null);
  assert.strictEqual(await lookupSession(null), null);

  let stub = stubFetch(() => []); // not found
  try { assert.strictEqual(await lookupSession('nope'), null); } finally { stub.restore(); }

  stub = stubFetch(() => [{ user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1',
    expires_at: new Date(Date.now() - 1000).toISOString() }]); // expired
  try { assert.strictEqual(await lookupSession('stale'), null); } finally { stub.restore(); }
});

test('revokeSessionsForUser issues a DELETE filtered by user_id', async () => {
  const stub = stubFetch(() => []);
  try {
    await revokeSessionsForUser('u1');
    const del = stub.calls[0];
    assert.strictEqual(del.method, 'DELETE');
    assert.match(del.url, /\/sessions\?user_id=eq\.u1/);
    assert.match(del.url, /account_id=eq\./);
  } finally { stub.restore(); }
});

// ---- scopeForUser (frozen contract) -----------------------------------------

test('scopeForUser(admin) has NO branch filter (sees all branches)', () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'admin' });
  assert.deepStrictEqual(scope, { account_id: 'acme', role: 'admin' });
  assert.ok(!('branch_id' in scope), 'admin scope must not carry a branch_id');
});

test('scopeForUser(clerk) is hard-filtered to the clerk branch', () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'clerk', branch_id: 'b2' });
  assert.deepStrictEqual(scope, { account_id: 'acme', branch_id: 'b2', role: 'clerk' });
});

test('scopeForUser throws for a clerk without a branch, staff, or a missing role', () => {
  assert.throws(() => scopeForUser({ role: 'clerk' }), /branch_id/);
  assert.throws(() => scopeForUser({ role: 'staff', branch_id: 'b1' }), /unsupported role/);
  assert.throws(() => scopeForUser(null), /role/);
  assert.throws(() => scopeForUser({}), /role/);
});
