'use strict';
// lib/branches.js (ADR-021 Phase 2): branch/staff provisioning. Supabase writes stub global.fetch
// (same pattern as tests/supabase.insertreturning.test.js); a POST returns the row it inserted so
// sbInsertReturning gets an id back.
const test = require('node:test');
const assert = require('node:assert');
const {
  genPassword, passwordPolicy, genUsername, genBindingToken,
  createBranch, listBranches, softDeleteBranch, addStaff, listStaff, removeStaff,
} = require('../lib/branches');

// Route each fetch by table + method; echo inserted rows back with a fake id.
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
    // default: a POST returning=representation echoes the row + a generated id
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{}]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

// ---- credential generators --------------------------------------------------

test('genPassword: 14 chars, unambiguous alphabet, passes the policy, and is random', () => {
  const a = genPassword(), b = genPassword();
  assert.strictEqual(a.length, 14);
  assert.match(a, /^[a-zA-Z2-9]+$/);       // no 0/1, no symbols
  assert.doesNotMatch(a, /[lIO0]/);         // unambiguous
  assert.notStrictEqual(a, b, 'two passwords must differ');
  assert.strictEqual(passwordPolicy(a).ok, true);
});

test('passwordPolicy rejects weak, accepts strong (SEC-1)', () => {
  assert.strictEqual(passwordPolicy('short1').ok, false);          // too short
  assert.strictEqual(passwordPolicy('alllettersonly').ok, false);  // no digit
  assert.strictEqual(passwordPolicy('aaaaaaaaaa1').ok, true);       // has digit + letters, len>=10
  assert.strictEqual(passwordPolicy('1111111111').ok, false);      // no letters
  assert.strictEqual(passwordPolicy('Str0ngPass99').ok, true);
});

test('genUsername: slugifies the office + adds a random suffix', () => {
  const u = genUsername('KL Branch #2');
  assert.match(u, /^kl-branch-2-[a-z2-9]{4}$/);
  // Randomness check that can't flake: 8 generations must not all collide.
  const set = new Set(Array.from({ length: 8 }, () => genUsername('X')));
  assert.ok(set.size > 1, 'suffix randomises');
});

test('genBindingToken: url-safe and non-trivial', () => {
  const t = genBindingToken();
  assert.ok(t.length >= 24);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

// ---- createBranch -----------------------------------------------------------

test('createBranch: inserts branch + clerk user (hashed pw) + one-time bind token; returns creds ONCE', async () => {
  const stub = stubDb();
  try {
    const r = await createBranch({ office: 'KL Branch', clerkName: 'Aisha', companyId: 'co-1' });
    // returned shape
    assert.ok(r.branch.id && r.user.id && r.bindToken);
    assert.strictEqual(r.user.role, 'clerk');
    assert.ok(r.credentials.username && r.credentials.password, 'plaintext creds returned once');

    const posts = stub.calls.filter((c) => c.method === 'POST');
    const branchPost = posts.find((c) => /\/branches/.test(c.url));
    const userPost = posts.find((c) => /\/users/.test(c.url));
    const bindPost = posts.find((c) => /\/bot_bindings/.test(c.url));
    assert.ok(branchPost && userPost && bindPost, 'all three rows inserted');

    // the clerk row stores a scrypt HASH, never the plaintext
    assert.match(userPost.body.password_hash, /^scrypt\$/);
    assert.ok(!('password' in userPost.body), 'plaintext password never sent to the DB');
    assert.notStrictEqual(userPost.body.password_hash, r.credentials.password);
    assert.strictEqual(userPost.body.company_id, 'co-1');
    assert.strictEqual(userPost.body.branch_id, branchPost.body ? r.branch.id : r.branch.id);

    // binding token matches what we return, with an expiry in the future
    assert.strictEqual(bindPost.body.bind_token, r.bindToken);
    assert.ok(new Date(bindPost.body.token_expires_at).getTime() > Date.now());
    assert.ok(!('password' in bindPost.body));
  } finally { stub.restore(); }
});

test('createBranch: role admin is allowed (bootstrap Head Office reuse)', async () => {
  const stub = stubDb();
  try {
    const r = await createBranch({ office: 'Head Office', role: 'admin' });
    assert.strictEqual(r.user.role, 'admin');
    const userPost = stub.calls.find((c) => c.method === 'POST' && /\/users/.test(c.url));
    assert.strictEqual(userPost.body.role, 'admin');
  } finally { stub.restore(); }
});

test('createBranch: rejects a missing office and a bad role', async () => {
  await assert.rejects(() => createBranch({}), /office is required/);
  await assert.rejects(() => createBranch({ office: 'X', role: 'staff' }), /role must be clerk or admin/);
});

// ---- listBranches / softDelete / staff --------------------------------------

test('listBranches: filters active (and company when given)', async () => {
  const stub = stubDb({ 'branches:GET': () => [{ id: 'b1', office: 'KL', active: true }] });
  try {
    const rows = await listBranches({ companyId: 'co-1' });
    assert.strictEqual(rows[0].office, 'KL');
    const get = stub.calls.find((c) => c.method === 'GET' && /\/branches/.test(c.url));
    assert.match(get.url, /active=eq\.true/);
    assert.match(get.url, /company_id=eq\.co-1/);
  } finally { stub.restore(); }
});

test('softDeleteBranch: deactivates branch + its users, revokes sessions, kills bindings', async () => {
  const stub = stubDb({
    'users:GET': () => [{ id: 'u1', branch_id: 'b1' }],
    'bot_bindings:GET': () => [{ id: 'bind1', branch_id: 'b1' }],
    'sessions:GET': () => [],
  });
  try {
    const r = await softDeleteBranch('b1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.users_revoked, 1);
    // branch set inactive
    const branchPatch = stub.calls.find((c) => c.method === 'PATCH' && /\/branches\?/.test(c.url));
    assert.strictEqual(branchPatch.body.active, false);
    // user set inactive
    assert.ok(stub.calls.some((c) => c.method === 'PATCH' && /\/users\?/.test(c.url) && c.body.active === false));
    // a DELETE against sessions for the user (revokeSessionsForUser)
    assert.ok(stub.calls.some((c) => c.method === 'DELETE' && /\/sessions\?user_id=eq\.u1/.test(c.url)));
    // binding deactivated
    assert.ok(stub.calls.some((c) => c.method === 'PATCH' && /\/bot_bindings\?/.test(c.url) && c.body.active === false));
  } finally { stub.restore(); }
});

test('addStaff / listStaff / removeStaff: name-only, soft-remove', async () => {
  let stub = stubDb();
  try {
    const s = await addStaff({ branchId: 'b1', name: 'Ravi', companyId: 'co-1' });
    const post = stub.calls.find((c) => c.method === 'POST' && /\/users/.test(c.url));
    assert.strictEqual(post.body.role, 'staff');
    assert.strictEqual(post.body.display_name, 'Ravi');
    assert.ok(!('username' in post.body) && !('password_hash' in post.body), 'staff have no login');
    assert.ok(s.id);
  } finally { stub.restore(); }

  stub = stubDb({ 'users:GET': () => [{ id: 'st1', display_name: 'Ravi', role: 'staff' }] });
  try {
    const list = await listStaff('b1');
    assert.strictEqual(list[0].display_name, 'Ravi');
    const get = stub.calls.find((c) => c.method === 'GET' && /\/users/.test(c.url));
    assert.match(get.url, /role=eq\.staff/);
  } finally { stub.restore(); }

  stub = stubDb();
  try {
    await removeStaff('st1');
    const patch = stub.calls.find((c) => c.method === 'PATCH' && /\/users\?/.test(c.url));
    assert.strictEqual(patch.body.active, false);
  } finally { stub.restore(); }
});

test('addStaff/removeStaff/listStaff validate required args', async () => {
  await assert.rejects(() => addStaff({ name: 'X' }), /branchId is required/);
  await assert.rejects(() => addStaff({ branchId: 'b1' }), /name is required/);
  await assert.rejects(() => listStaff(), /branchId is required/);
  await assert.rejects(() => removeStaff(), /id is required/);
});
