'use strict';
// lib/branches.js — ADR-025 amendment (Owner-approved, 2026-07-11 QA round):
// getBranchCredentials (view a branch's login anytime) + resetBranchPassword. Same
// stubDb pattern as tests/branches.test.js. CRED_ENC_KEY must be set BEFORE lib/branches
// (-> lib/credCrypto -> lib/config) is first required, so it's set at the top of this file
// (node --test isolates each test file in its own process, so this doesn't leak).
process.env.CRED_ENC_KEY = 'a-test-operator-secret';

const test = require('node:test');
const assert = require('node:assert');
const { createBranch, getBranchCredentials, resetBranchPassword } = require('../lib/branches');
const { encryptSecret } = require('../lib/credCrypto');

function stubDb(handlers = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (handlers[table + ':' + method]) {
      return { text: async () => JSON.stringify(handlers[table + ':' + method]({ url: u, body })) };
    }
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{}]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

// ---- createBranch now also stores an encrypted-recoverable copy ----

test('createBranch: also stores password_enc (encrypted, recoverable), distinct from the hash', async () => {
  const stub = stubDb();
  try {
    const r = await createBranch({ office: 'KL Branch' });
    const userPost = stub.calls.find((c) => c.method === 'POST' && /\/users/.test(c.url));
    assert.ok(userPost.body.password_enc, 'password_enc is stored');
    assert.notStrictEqual(userPost.body.password_enc, r.credentials.password, 'never the raw plaintext');
    assert.notStrictEqual(userPost.body.password_enc, userPost.body.password_hash, 'distinct from the login hash');
  } finally { stub.restore(); }
});

// ---- getBranchCredentials ----

test('getBranchCredentials: returns username/password/bindToken for a branch with an encrypted copy', async () => {
  const enc = encryptSecret('Str0ngPass!!');
  const stub = stubDb({
    'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', password_enc: enc, active: true }],
    'bot_bindings:GET': () => [{ bind_token: 'tok-latest', created_at: '2026-07-11T00:00:00Z' }],
  });
  try {
    const creds = await getBranchCredentials('b1');
    assert.deepStrictEqual(creds, { username: 'kl-ab12', password: 'Str0ngPass!!', bindToken: 'tok-latest' });
  } finally { stub.restore(); }
});

test('getBranchCredentials: legacy branch with no password_enc -> password null (not an error)', async () => {
  const stub = stubDb({
    'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', password_enc: null, active: true }],
    'bot_bindings:GET': () => [],
  });
  try {
    const creds = await getBranchCredentials('b1');
    assert.strictEqual(creds.password, null);
    assert.strictEqual(creds.username, 'kl-ab12');
    assert.strictEqual(creds.bindToken, null);
  } finally { stub.restore(); }
});

test('getBranchCredentials: ignores name-only staff rows, only the admin/clerk login is returned', async () => {
  const stub = stubDb({
    'users:GET': () => [
      { id: 'st1', role: 'staff', display_name: 'Ravi', active: true },
      { id: 'u1', role: 'clerk', username: 'kl-ab12', password_enc: null, active: true },
    ],
    'bot_bindings:GET': () => [],
  });
  try {
    const creds = await getBranchCredentials('b1');
    assert.strictEqual(creds.username, 'kl-ab12');
  } finally { stub.restore(); }
});

test('getBranchCredentials: no credentialed user for the branch -> null', async () => {
  const stub = stubDb({ 'users:GET': () => [] });
  try {
    assert.strictEqual(await getBranchCredentials('b1'), null);
  } finally { stub.restore(); }
});

test('getBranchCredentials: requires branchId', async () => {
  await assert.rejects(() => getBranchCredentials(), /branchId is required/);
});

// ---- resetBranchPassword ----

test('resetBranchPassword: issues a NEW password, updates hash + encrypted copy, revokes sessions', async () => {
  const stub = stubDb({
    'users:GET': () => [{ id: 'u1', role: 'clerk', username: 'kl-ab12', active: true }],
    'sessions:GET': () => [],
  });
  try {
    const r = await resetBranchPassword('b1');
    assert.strictEqual(r.username, 'kl-ab12');
    assert.strictEqual(r.password.length, 14, 'a freshly generated strong password');

    const patch = stub.calls.find((c) => c.method === 'PATCH' && /\/users\?/.test(c.url));
    assert.match(patch.body.password_hash, /^scrypt\$/);
    assert.ok(patch.body.password_enc, 'encrypted copy also updated');
    assert.ok(!('password' in patch.body), 'plaintext never sent to the DB');

    assert.ok(stub.calls.some((c) => c.method === 'DELETE' && /\/sessions\?user_id=eq\.u1/.test(c.url)),
      'old sessions revoked — a stale browser session must not survive a reset');
  } finally { stub.restore(); }
});

test('resetBranchPassword: no credentialed user for the branch -> rejects, no writes', async () => {
  const stub = stubDb({ 'users:GET': () => [] });
  try {
    await assert.rejects(() => resetBranchPassword('b1'), /no credentialed user/);
    assert.strictEqual(stub.calls.some((c) => c.method === 'PATCH'), false);
  } finally { stub.restore(); }
});

test('resetBranchPassword: requires branchId', async () => {
  await assert.rejects(() => resetBranchPassword(), /branchId is required/);
});
