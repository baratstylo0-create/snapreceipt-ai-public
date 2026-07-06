'use strict';
// setup/provision.js (ADR-021 Phase 2): bootstrap the first admin + a "Head Office" branch for a
// fresh managed-silo instance. Supabase reads/writes are stubbed at global.fetch (same pattern as
// tests/branches.test.js). We test the exported provisionAdmin(); the CLI wrapper (stdout print) is
// only exercised when run directly.
const test = require('node:test');
const assert = require('node:assert');
const { provisionAdmin } = require('../setup/provision');
const { passwordPolicy } = require('../lib/branches');

// Route each fetch by table+method; a POST returning=representation echoes the row + a fake id.
// `admins` seeds the users GET (the "does an admin already exist?" check).
function stubDb({ admins = [] } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (method === 'GET' && table === 'users') return { text: async () => JSON.stringify(admins) };
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{}]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  for (const k of Object.keys(vars)) if (vars[k] === undefined) delete process.env[k];
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('provisionAdmin: creates exactly one admin + a Head Office branch when none exists', async () => {
  await withEnv({ ADMIN_USERNAME: 'hqadmin', ADMIN_PASSWORD: undefined }, async () => {
    const stub = stubDb({ admins: [] });
    try {
      const r = await provisionAdmin();
      assert.strictEqual(r.created, true);
      assert.strictEqual(r.user.role, 'admin');
      assert.ok(r.credentials.username && r.credentials.password, 'creds returned once');
      assert.ok(r.bindToken, 'a one-time bot-binding token is minted');

      const posts = stub.calls.filter((c) => c.method === 'POST');
      const branchPost = posts.find((c) => /\/branches/.test(c.url));
      const userPost = posts.find((c) => /\/users/.test(c.url) && c.body.role === 'admin');
      assert.strictEqual(branchPost.body.office, 'Head Office');
      assert.strictEqual(userPost.body.role, 'admin');
      assert.strictEqual(userPost.body.username, 'hqadmin');
      assert.match(userPost.body.password_hash, /^scrypt\$/);
      assert.ok(!('password' in userPost.body), 'plaintext never written to the DB');
    } finally { stub.restore(); }
  });
});

test('provisionAdmin: refuses (no writes) when an admin already exists and --force is absent', async () => {
  const stub = stubDb({ admins: [{ id: 'u1', role: 'admin', active: true }] });
  try {
    const r = await provisionAdmin({ force: false });
    assert.strictEqual(r.created, false);
    assert.match(r.reason, /already exists/i);
    assert.strictEqual(stub.calls.some((c) => c.method === 'POST'), false, 'no rows inserted');
  } finally { stub.restore(); }
});

test('provisionAdmin: with force, creates even when an admin already exists', async () => {
  const stub = stubDb({ admins: [{ id: 'u1', role: 'admin', active: true }] });
  try {
    const r = await provisionAdmin({ force: true });
    assert.strictEqual(r.created, true);
    assert.ok(stub.calls.some((c) => c.method === 'POST' && /\/users/.test(c.url)));
  } finally { stub.restore(); }
});

test('provisionAdmin: honours ADMIN_USERNAME + ADMIN_PASSWORD from env', async () => {
  await withEnv({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'Str0ngPass99' }, async () => {
    const stub = stubDb({ admins: [] });
    try {
      const r = await provisionAdmin();
      assert.strictEqual(r.credentials.username, 'boss');
      assert.strictEqual(r.credentials.password, 'Str0ngPass99');
    } finally { stub.restore(); }
  });
});

test('provisionAdmin: auto-generates a SEC-1-passing password when ADMIN_PASSWORD is unset', async () => {
  await withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: undefined }, async () => {
    const stub = stubDb({ admins: [] });
    try {
      const r = await provisionAdmin();
      assert.strictEqual(r.credentials.password.length, 14);
      assert.strictEqual(passwordPolicy(r.credentials.password).ok, true);
    } finally { stub.restore(); }
  });
});
