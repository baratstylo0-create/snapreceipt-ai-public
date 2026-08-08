'use strict';
// lib/personalAuth.js's signupOwnerDirect/reconnectBinding (2026-08-08 in-bot signup/reconnect)
// had NO direct unit test coverage before this file — signupOwner itself was only ever
// exercised indirectly through routes/auth.js. DB-touching functions stub global.fetch, same
// pattern as tests/auth.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { signupOwner, signupOwnerDirect, reconnectBinding } = require('../lib/personalAuth');

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

test('signupOwner: token_expires_at is null on the created bot_bindings row (permanent link, 2026-08-08)', async () => {
  const { calls, restore } = stubFetch((call) => {
    if (call.url.includes('/users') && call.method === 'GET') return [];
    if (call.url.includes('/users') && call.method === 'POST') return [{ id: 'u1', username: 'a@b.com' }];
    if (call.url.includes('/bot_bindings') && call.method === 'POST') return [];
    return [];
  });
  try {
    const result = await signupOwner({ email: 'a@b.com', password: 'correcthorsebattery1' });
    assert.strictEqual(result.user.id, 'u1');
    assert.ok(result.bindToken);
    const bindingInsert = calls.find(c => c.url.includes('/bot_bindings') && c.method === 'POST');
    assert.strictEqual(bindingInsert.body.token_expires_at, null);
    assert.strictEqual(bindingInsert.body.role, 'owner');
  } finally { restore(); }
});

test('signupOwnerDirect: creates the account AND binds chat_id + last_active_at in one step (no link-tap needed)', async () => {
  const { calls, restore } = stubFetch((call) => {
    if (call.url.includes('/users') && call.method === 'GET') return [];
    if (call.url.includes('/users') && call.method === 'POST') return [{ id: 'u2', username: 'bot@x.com' }];
    if (call.url.includes('/bot_bindings') && call.method === 'POST') return [];
    if (call.url.includes('/bot_bindings') && call.method === 'GET') return [{ id: 'bind2', user_id: 'u2', chat_id: null }];
    if (call.url.includes('/bot_bindings') && call.method === 'PATCH') return [];
    return [];
  });
  try {
    const result = await signupOwnerDirect({ email: 'bot@x.com', password: 'correcthorsebattery1', chatId: 999 });
    assert.strictEqual(result.user.id, 'u2');
    const bindUpdate = calls.find(c => c.url.includes('/bot_bindings') && c.method === 'PATCH');
    assert.ok(bindUpdate, 'expected a PATCH to bot_bindings');
    assert.strictEqual(bindUpdate.body.chat_id, '999');
    assert.ok(bindUpdate.body.last_active_at, 'last_active_at must be stamped so the 30-day clock starts fresh');
    assert.ok(bindUpdate.body.bound_at);
  } finally { restore(); }
});

test('signupOwnerDirect: propagates signupOwner\'s validation error (e.g. duplicate email) without binding anything', async () => {
  const { calls, restore } = stubFetch((call) => {
    if (call.url.includes('/users') && call.method === 'GET') return [{ id: 'existing' }];
    return [];
  });
  try {
    await assert.rejects(
      signupOwnerDirect({ email: 'dupe@x.com', password: 'correcthorsebattery1', chatId: 1 }),
      /already exists/i
    );
    assert.strictEqual(calls.some(c => c.url.includes('/bot_bindings')), false, 'must never touch bot_bindings on a failed signup');
  } finally { restore(); }
});

test('reconnectBinding: rebinds an existing user\'s bot_bindings row to the new chat_id', async () => {
  const { calls, restore } = stubFetch((call) => {
    if (call.url.includes('/bot_bindings') && call.method === 'GET') return [{ id: 'bind3', user_id: 'u3', chat_id: '111' }];
    if (call.url.includes('/bot_bindings') && call.method === 'PATCH') return [];
    return [];
  });
  try {
    const ok = await reconnectBinding('u3', 222);
    assert.strictEqual(ok, true);
    const patch = calls.find(c => c.method === 'PATCH');
    assert.strictEqual(patch.body.chat_id, '222');
    assert.strictEqual(patch.body.active, true);
    assert.ok(patch.body.last_active_at);
  } finally { restore(); }
});

test('reconnectBinding: returns false (no crash) when the user has no bot_bindings row at all', async () => {
  const { restore } = stubFetch(() => []);
  try {
    const ok = await reconnectBinding('ghost-user', 1);
    assert.strictEqual(ok, false);
  } finally { restore(); }
});
