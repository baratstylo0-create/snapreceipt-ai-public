'use strict';
// sbInsertReturning (ADR-017): like sbInsert, but reads the inserted row back — needed
// to echo a DB-generated column (voucher_no, assigned by a trigger) to the caller.
const test = require('node:test');
const assert = require('node:assert');
const { sbInsertReturning, sbRpc } = require('../lib/supabase');

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

// --- sbRpc (issue #14): calls a Postgres function via PostgREST's /rpc/<fn> endpoint.
// Unlike the table helpers, does NOT auto-inject account_id — the caller supplies exactly
// the args its target function declares (e.g. `p_account`, function-specific naming). ---

test('sbRpc POSTs the args as-is to /rpc/<fnName>, with NO account_id auto-injected', async () => {
  const stub = stubFetch(() => ({ id: 'row1', hit_count: 2 }));
  try {
    const result = await sbRpc('upsert_category_correction', { p_account: 'default', p_match_type: 'merchant', p_match_value: 'shell', p_category: 'Fuel & Auto' });
    assert.match(stub.seen().url, /\/rpc\/upsert_category_correction$/);
    assert.deepStrictEqual(stub.seen().body, { p_account: 'default', p_match_type: 'merchant', p_match_value: 'shell', p_category: 'Fuel & Auto' });
    assert.ok(!('account_id' in stub.seen().body), 'sbRpc must not auto-inject a generic account_id key');
    assert.deepStrictEqual(result, { id: 'row1', hit_count: 2 });
  } finally { stub.restore(); }
});

test('sbRpc defaults to an empty args object when none is given', async () => {
  const stub = stubFetch(() => ({ ok: true }));
  try {
    await sbRpc('some_fn');
    assert.deepStrictEqual(stub.seen().body, {});
  } finally { stub.restore(); }
});
