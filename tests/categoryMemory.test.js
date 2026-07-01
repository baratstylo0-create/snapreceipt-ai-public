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

test('recordCorrection upserts a merchant AND a description signal', async () => {
  const calls = [];
  const os = supabase.sbSelect, oi = supabase.sbInsert, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([]);
  supabase.sbInsert = async (t, row) => { calls.push(row.match_type); };
  supabase.sbUpdate = async () => ([]);
  try {
    await recordCorrection('Shell', 'Diesel fuel', 'Fuel & Auto');
    assert.ok(calls.includes('merchant'));
    assert.ok(calls.includes('description'));
  } finally { supabase.sbSelect = os; supabase.sbInsert = oi; supabase.sbUpdate = ou; }
});

test('recordCorrection increments hit_count when a signal already exists', async () => {
  let patched = null;
  const os = supabase.sbSelect, oi = supabase.sbInsert, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'x1', hit_count: 4 }]);
  supabase.sbUpdate = async (t, sel, patch) => { patched = patch; return []; };
  supabase.sbInsert = async () => { throw new Error('should not insert when a row exists'); };
  try {
    await recordCorrection('Shell', null, 'Fuel & Auto');
    assert.strictEqual(patched.hit_count, 5);
    assert.strictEqual(patched.category, 'Fuel & Auto');
  } finally { supabase.sbSelect = os; supabase.sbInsert = oi; supabase.sbUpdate = ou; }
});

test('recordCorrection is best-effort: swallows DB errors (never throws)', async () => {
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('db down'); };
  try {
    await recordCorrection('Shell', 'Diesel', 'Fuel & Auto');
    assert.ok(true);
  } finally { supabase.sbSelect = os; }
});

test('recordCorrection with no category is a no-op', async () => {
  let touched = false;
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => { touched = true; return []; };
  try {
    await recordCorrection('Shell', 'Diesel', '');
    assert.strictEqual(touched, false);
  } finally { supabase.sbSelect = os; }
});
