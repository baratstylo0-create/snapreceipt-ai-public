'use strict';
// sbInsertReturning (ADR-017): like sbInsert, but reads the inserted row back — needed
// to echo a DB-generated column (voucher_no, assigned by a trigger) to the caller.
const test = require('node:test');
const assert = require('node:assert');
const { sbInsertReturning } = require('../lib/supabase');

function stubFetch(respond) {
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opt) => {
    seen = { url, method: opt.method, headers: opt.headers, body: JSON.parse(opt.body) };
    return { text: async () => JSON.stringify(respond(seen)) };
  };
  return { restore: () => { global.fetch = realFetch; }, seen: () => seen };
}

test('sbInsertReturning sends Prefer: return=representation and returns the first inserted row', async () => {
  const stub = stubFetch(() => [{ id: 'abc', merchant: 'Shell', voucher_no: 'RC-2026-0001' }]);
  try {
    const row = await sbInsertReturning('expenses', { merchant: 'Shell' });
    assert.strictEqual(stub.seen().headers.Prefer, 'return=representation');
    assert.strictEqual(stub.seen().body.merchant, 'Shell');
    assert.ok(stub.seen().body.account_id, 'account_id is always injected');
    assert.deepStrictEqual(row, { id: 'abc', merchant: 'Shell', voucher_no: 'RC-2026-0001' });
  } finally { stub.restore(); }
});

test('sbInsertReturning returns null on an empty/unexpected response (never throws)', async () => {
  const stub = stubFetch(() => ([]));
  try {
    const row = await sbInsertReturning('expenses', { merchant: 'X' });
    assert.strictEqual(row, null);
  } finally { stub.restore(); }
});

test('sbInsertReturning returns null if the response is not an array (e.g. an error object)', async () => {
  const stub = stubFetch(() => ({ message: 'some pgrst error' }));
  try {
    const row = await sbInsertReturning('expenses', { merchant: 'X' });
    assert.strictEqual(row, null);
  } finally { stub.restore(); }
});
