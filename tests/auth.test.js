'use strict';
// lib/auth.js (ADR-021 Phase 1): scrypt password hashing, opaque sessions, and the
// frozen scopeForUser isolation contract. DB-touching session functions stub global.fetch
// (same pattern as tests/supabase.insertreturning.test.js).
const test = require('node:test');
const assert = require('node:assert');
const {
  hashPassword, verifyPassword,
  mintSession, lookupSession, revokeSessionsForUser, tokenHash, accountIdFor,
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

test('mintSession denormalises company_id onto the session row (ADR-023 Phase 8)', async () => {
  const stub = stubFetch(() => []);
  try {
    await mintSession({ id: 'u1', role: 'clerk', branch_id: 'b1', company_id: 'c1' });
    assert.strictEqual(stub.calls[0].body.company_id, 'c1');
  } finally { stub.restore(); }
});

test('mintSession stores null company_id when the user has none', async () => {
  const stub = stubFetch(() => []);
  try {
    await mintSession({ id: 'u1', role: 'clerk', branch_id: 'b1' });
    assert.strictEqual(stub.calls[0].body.company_id, null);
  } finally { stub.restore(); }
});

test('lookupSession surfaces company_id when the session row carries one', async () => {
  const stub = stubFetch(() => [{ user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1',
    company_id: 'c1', expires_at: new Date(Date.now() + 60000).toISOString() }]);
  try {
    const s = await lookupSession('sometoken');
    assert.strictEqual(s.company_id, 'c1');
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

// 2026-08-14 SECURITY FIX: this used to also assert an `account_id=eq.` predicate — that was
// the bug (see lib/auth.js's doc comment on revokeSessionsForUser). `user_id` is already a FK
// to one globally-unique `users.id`, so it alone is correct; a lingering account_id=eq.<the
// one global cfg.ACCOUNT_ID constant> predicate would silently fail to revoke a session minted
// for a user whose own account_id differs from that constant (exactly the per-account
// personal-signup case this fix introduces).
test('revokeSessionsForUser issues a DELETE filtered by user_id ONLY (no account_id predicate)', async () => {
  const stub = stubFetch(() => []);
  try {
    await revokeSessionsForUser('u1');
    const del = stub.calls[0];
    assert.strictEqual(del.method, 'DELETE');
    assert.strictEqual(del.url, '/rest/v1/sessions?user_id=eq.u1');
  } finally { stub.restore(); }
});

// 2026-08-14 SECURITY FIX regression lock: mintSession/lookupSession must round-trip a
// user's OWN account_id, not the single global cfg.ACCOUNT_ID constant — this is the actual
// isolation mechanism two different personal ("owner") accounts now rely on.
test('mintSession stamps the SESSION with the USER\'s own account_id, not the global default', async () => {
  const stub = stubFetch(() => []);
  try {
    await mintSession({ id: 'u1', role: 'owner', account_id: 'p_abc123' });
    assert.strictEqual(stub.calls[0].body.account_id, 'p_abc123');
  } finally { stub.restore(); }
});

test('mintSession falls back to cfg.ACCOUNT_ID when the user row carries none (business/legacy, unchanged)', async () => {
  const stub = stubFetch(() => []);
  try {
    await mintSession({ id: 'u1', role: 'clerk', branch_id: 'b1' });
    assert.strictEqual(stub.calls[0].body.account_id, 'default');
  } finally { stub.restore(); }
});

// 2026-08-14 regression lock — CAUGHT LIVE against the real production .env before deploy:
// a deployment can set ACCOUNT_ID to something other than the literal string 'default'
// (this one uses 'snapreceiptai'). schema.sql's users.account_id column DEFAULT is always
// the literal 'default', so every EXISTING (pre-fix) user row has account_id:'default' while
// their actual data rows all carry the deployment's real cfg.ACCOUNT_ID. A plain `||`
// fallback would treat that literal 'default' as a real, intentional value (non-empty string)
// and mint a session that matches NONE of that user's existing data — accountIdFor must
// treat 'default' as "never actually assigned" and use cfg.ACCOUNT_ID instead.
test('accountIdFor: treats the literal DB-default "default" as unset, not a real per-user value', () => {
  const savedAccountId = process.env.ACCOUNT_ID;
  process.env.ACCOUNT_ID = 'snapreceiptai';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/auth')];
  try {
    const freshAuth = require('../lib/auth');
    assert.strictEqual(freshAuth.accountIdFor({ account_id: 'default' }), 'snapreceiptai',
      'an existing pre-fix user (DB column default) must resolve to the deployment\'s real account_id, matching their existing data');
    assert.strictEqual(freshAuth.accountIdFor({ account_id: 'p_abc123' }), 'p_abc123',
      'a real per-user account_id (new signups, never literally "default") is used as-is');
    assert.strictEqual(freshAuth.accountIdFor({}), 'snapreceiptai', 'no account_id at all also falls back');
  } finally {
    if (savedAccountId === undefined) delete process.env.ACCOUNT_ID; else process.env.ACCOUNT_ID = savedAccountId;
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/auth')];
  }
});

test('mintSession: an EXISTING user row stuck on the literal "default" resolves to cfg.ACCOUNT_ID, not the literal string', async () => {
  const savedAccountId = process.env.ACCOUNT_ID;
  process.env.ACCOUNT_ID = 'snapreceiptai';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/auth')];
  try {
    const freshAuth = require('../lib/auth');
    const stub = stubFetch(() => []);
    try {
      await freshAuth.mintSession({ id: 'u1', role: 'owner', account_id: 'default' });
      assert.strictEqual(stub.calls[0].body.account_id, 'snapreceiptai',
        'must match this deployment\'s real account_id, matching every existing expense row — NOT the literal "default"');
    } finally { stub.restore(); }
  } finally {
    if (savedAccountId === undefined) delete process.env.ACCOUNT_ID; else process.env.ACCOUNT_ID = savedAccountId;
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/auth')];
  }
});

test('lookupSession does not filter by account_id (token_hash alone is the unique key)', async () => {
  const stub = stubFetch((call) => {
    assert.strictEqual(call.url, '/rest/v1/sessions?token_hash=eq.' + tokenHash('sometoken') + '&limit=1');
    return [{ user_id: 'u1', account_id: 'p_abc123', role: 'owner', expires_at: new Date(Date.now() + 60000).toISOString() }];
  });
  try {
    const s = await lookupSession('sometoken');
    assert.strictEqual(s.account_id, 'p_abc123', 'a per-user account_id survives the round trip');
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

// Issue #164 (QA PR-J, C2) data-model finding, locked in as a regression guard: a clerk carries
// EXACTLY ONE branch_id today — scopeForUser has no concept of "this clerk watches N branches",
// and the users table (schema.sql) stores branch_id as a single scalar FK, not a join table. A
// multi-branch clerk filter is therefore an ARCHITECTURE decision (a users<->branches join table,
// or a scope-shape change), not a UI-only filter — escalated to the Owner in issue #164 rather
// than silently built around. If this test ever needs to change, that decision has been made.
test("scopeForUser(clerk): branch_id is a SINGLE value — passing an array is not a supported multi-branch shape (issue #164 finding)", () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'clerk', branch_id: ['b1', 'b2'] });
  // No array-aware branching exists: whatever is passed as branch_id is stamped through verbatim,
  // so an array would silently become the scope's branch_id — never split into a real multi-branch
  // filter. This documents the CURRENT (single-branch-only) contract, not a recommendation to pass
  // an array in production.
  assert.deepStrictEqual(scope.branch_id, ['b1', 'b2'], 'no multi-branch handling exists — the value passes through unexamined');
});

// ADR-023 Phase 8: the clerk scope OPTIONALLY carries company_id when the session denormalises one
// (multi-company clients). It must be OMITTED (not null-keyed) when absent so pre-Phase-8 clerks
// and the single-company product keep the exact frozen shape. Admin is unchanged (cross-company).
test('scopeForUser(clerk) carries company_id when the session has one', () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'clerk', branch_id: 'b2', company_id: 'c1' });
  assert.deepStrictEqual(scope, { account_id: 'acme', company_id: 'c1', branch_id: 'b2', role: 'clerk' });
});

test('scopeForUser(clerk) OMITS company_id when absent (not null-keyed)', () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'clerk', branch_id: 'b2' });
  assert.ok(!('company_id' in scope), 'no company_id key on a company-less clerk');
});

test('scopeForUser(admin) is unchanged by the company dimension (sees all companies)', () => {
  const scope = scopeForUser({ account_id: 'acme', role: 'admin', company_id: 'c1' });
  assert.deepStrictEqual(scope, { account_id: 'acme', role: 'admin' });
});

test('scopeForUser throws for a clerk without a branch, staff, or a missing role', () => {
  assert.throws(() => scopeForUser({ role: 'clerk' }), /branch_id/);
  assert.throws(() => scopeForUser({ role: 'staff', branch_id: 'b1' }), /unsupported role/);
  assert.throws(() => scopeForUser(null), /role/);
  assert.throws(() => scopeForUser({}), /role/);
});
