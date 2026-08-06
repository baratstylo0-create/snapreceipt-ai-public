'use strict';
// #14 — regression tests locking the categorizer's untrusted-input handling (SOP §4.8).
// The LLM watchdog output and OCR line_items are untrusted; these pin the existing clamp
// so a future refactor can't silently reopen an injection/corruption path. Plus the new
// match_value length cap in categoryMemory.norm().
const test = require('node:test');
const assert = require('node:assert');
const { categorizeLineItems } = require('../lib/categorize');
const { norm } = require('../lib/categoryMemory');

const noMem = { merchant: new Map(), description: new Map() };
const stubLLM = arr => async () => JSON.stringify(arr);
const oneItem = { merchant: 'Shell', line_items: [{ description: 'Diesel fuel', amount: 50 }] };

// --- categoryMemory.norm() length cap (the one real new fix in #14) ---
test('norm() caps match_value at 200 chars (unbounded untrusted text -> bounded key)', () => {
  const key = norm('x'.repeat(5000));
  assert.strictEqual(key.length, 200);
});
test('norm() applies the cap identically so a truncated key still matches on read+write', () => {
  const long = 'ACME ' + 'y'.repeat(400);
  assert.strictEqual(norm(long), norm(long)); // deterministic
  assert.ok(norm(long).length <= 200);
});

// --- LLM confidence coercion: override only on a real finite value >= 0.75 ---
test('LLM confidence as the STRING "0.9" is honoured (finite) and overrides', async () => {
  const groqChat = stubLLM([{ i: 0, category: 'Office Supplies', confidence: '0.9' }]);
  const r = await categorizeLineItems(oneItem, null, { memory: noMem, groqChat });
  assert.strictEqual(r.items[0].category, 'Office Supplies');
  assert.strictEqual(r.items[0].source, 'llm');
});
test('LLM confidence null/missing does NOT override the base guess (flags instead)', async () => {
  for (const bad of [{ i: 0, category: 'Office Supplies', confidence: null }, { i: 0, category: 'Office Supplies' }]) {
    const r = await categorizeLineItems(oneItem, null, { memory: noMem, groqChat: stubLLM([bad]) });
    assert.notStrictEqual(r.items[0].category, 'Office Supplies', 'no finite confidence -> never overrides');
    assert.strictEqual(r.items[0].flagged, true);
  }
});

// --- LLM index bounds: out-of-range / negative / non-integer are ignored, no corruption ---
test('LLM index out-of-range / negative / non-integer is ignored (no crash, no corruption)', async () => {
  const groqChat = stubLLM([
    { i: 99, category: 'Travel', confidence: 0.99 },
    { i: -1, category: 'Travel', confidence: 0.99 },
    { i: 1.5, category: 'Travel', confidence: 0.99 },
    { i: 'x', category: 'Travel', confidence: 0.99 },
  ]);
  const r = await categorizeLineItems(oneItem, null, { memory: noMem, groqChat });
  assert.strictEqual(r.items.length, 1);
  assert.notStrictEqual(r.items[0].category, 'Travel', 'no valid index -> base guess preserved');
});

// --- LLM category as object/array is off-list -> dropped (anti-hallucination) ---
test('LLM category as an object/array is dropped, base decision preserved', async () => {
  for (const cat of [{ evil: 1 }, ['Travel'], 42]) {
    const r = await categorizeLineItems(oneItem, null, { memory: noMem, groqChat: stubLLM([{ i: 0, category: cat, confidence: 0.99 }]) });
    assert.strictEqual(r.items[0].source !== 'llm' || r.items[0].category === 'Fuel & Auto', true,
      'a non-string / off-list category can never be applied');
  }
});

// --- line_items not an array -> whole-receipt fallback, never a crash ---
test('line_items as a string/object falls back to whole-receipt (no crash)', async () => {
  for (const li of ['not-an-array', { a: 1 }, 123]) {
    const r = await categorizeLineItems({ merchant: 'Shell', amount: 40, line_items: li }, null, { useLLM: false, memory: noMem });
    assert.ok(r && typeof r.category === 'string', 'still returns a receipt-level category');
  }
});
