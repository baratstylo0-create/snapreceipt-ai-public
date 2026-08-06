'use strict';
// #6 learning memory — stubs the supabase module object (namespace import makes this possible).
const test = require('node:test');
const assert = require('node:assert');
const supabase = require('../lib/supabase');
const { loadMemory, recordCorrection } = require('../lib/categoryMemory');

test('loadMemory buckets rows by match_type', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => ([
    { match_type: 'merchant', match_value: 'shell', category: 'Fuel & Auto', hit_count: 3 },
    { match_type: 'description', match_value: 'latte', category: 'Meals & Entertainment', hit_count: 2 },
  ]);
  try {
    const m = await loadMemory();
    assert.strictEqual(m.merchant.get('shell'), 'Fuel & Auto');
    assert.strictEqual(m.description.get('latte'), 'Meals & Entertainment');
  } finally { supabase.sbSelect = orig; }
});

test('loadMemory degrades gracefully when the table is missing (sbSelect -> [])', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => ([]);
  try {
    const m = await loadMemory();
    assert.strictEqual(m.merchant.size, 0);
    assert.strictEqual(m.description.size, 0);
  } finally { supabase.sbSelect = orig; }
});

// Issue #14 fix (2026-07-04): recordCorrection now calls the atomic
// upsert_category_correction Postgres function via sbRpc instead of a racy
// select-then-insert-or-update. The actual atomic increment is a DB-level guarantee
// (the SQL function itself, schema.sql) — these JS unit tests verify recordCorrection
// calls sbRpc with the right function name and args, and degrades gracefully.

test('recordCorrection upserts a merchant AND a description signal via sbRpc, scoped to the account', async () => {
  const calls = [];
  const or_ = supabase.sbRpc;
  supabase.sbRpc = async (fn, args) => { calls.push({ fn, args }); };
  try {
    await recordCorrection('Shell', 'Diesel fuel', 'Fuel & Auto');
    assert.strictEqual(calls.length, 2);
    assert.ok(calls.every(c => c.fn === 'upsert_category_correction'));
    assert.ok(calls.some(c => c.args.p_match_type === 'merchant' && c.args.p_match_value === 'shell'));
    assert.ok(calls.some(c => c.args.p_match_type === 'description' && c.args.p_match_value === 'diesel fuel'));
    assert.ok(calls.every(c => c.args.p_category === 'Fuel & Auto' && c.args.p_account));
  } finally { supabase.sbRpc = or_; }
});

test('recordCorrection with only a merchant (no description) makes exactly one RPC call', async () => {
  const calls = [];
  const or_ = supabase.sbRpc;
  supabase.sbRpc = async (fn, args) => { calls.push(args); };
  try {
    await recordCorrection('Shell', null, 'Fuel & Auto');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].p_match_type, 'merchant');
  } finally { supabase.sbRpc = or_; }
});

test('recordCorrection is best-effort: swallows DB/RPC errors (never throws)', async () => {
  const or_ = supabase.sbRpc;
  supabase.sbRpc = async () => { throw new Error('function or table does not exist yet'); };
  try {
    await assert.doesNotReject(() => recordCorrection('Shell', 'Diesel', 'Fuel & Auto'));
  } finally { supabase.sbRpc = or_; }
});

test('recordCorrection with no category is a no-op — sbRpc is never called', async () => {
  let touched = false;
  const or_ = supabase.sbRpc;
  supabase.sbRpc = async () => { touched = true; };
  try {
    await recordCorrection('Shell', 'Diesel', '');
    assert.strictEqual(touched, false);
  } finally { supabase.sbRpc = or_; }
});
