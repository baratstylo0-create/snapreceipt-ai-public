'use strict';
// Pure-function tests for the category-picker's button/prompt building (Owner request
// 2026-07-03). No network — buildCategoryKeyboard/categoryPromptText are hermetic.
const test = require('node:test');
const assert = require('node:assert');
const { buildCategoryKeyboard, categoryPromptText, PENDING_CATEGORY } = require('../lib/ocr');
const { CATEGORIES } = require('../lib/categorize');

test('buildCategoryKeyboard: every real category gets a button, Others is always last on its own row', () => {
  const kb = buildCategoryKeyboard('exp-1', CATEGORIES);
  const flat = kb.inline_keyboard.flat();
  const realCount = CATEGORIES.filter(c => c !== 'Others').length;
  assert.strictEqual(flat.length, realCount + 1, 'one button per real category, plus one Others button');
  const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
  assert.strictEqual(lastRow.length, 1, 'Others sits alone on the final row');
  assert.match(lastRow[0].text, /Others/i);
  assert.strictEqual(lastRow[0].callback_data, 'catpick:exp-1:others');
});

test('buildCategoryKeyboard: callback_data uses a short index, never the category text itself', () => {
  const kb = buildCategoryKeyboard('exp-2', CATEGORIES);
  const flat = kb.inline_keyboard.flat();
  for (const btn of flat) {
    if (btn.callback_data === 'catpick:exp-2:others') continue;
    assert.match(btn.callback_data, /^catpick:exp-2:\d+$/, 'category buttons encode an index, not the name: ' + btn.callback_data);
  }
});

test('buildCategoryKeyboard: every callback_data stays comfortably under Telegram\'s 64-byte limit', () => {
  const longId = 'a'.repeat(36); // a real Supabase UUID is 36 chars
  const kb = buildCategoryKeyboard(longId, CATEGORIES);
  for (const btn of kb.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, btn.callback_data + ' exceeds 64 bytes');
  }
});

test('buildCategoryKeyboard: the index resolves back to the correct category name (round-trip)', () => {
  const kb = buildCategoryKeyboard('exp-3', CATEGORIES);
  for (const btn of kb.inline_keyboard.flat()) {
    if (btn.callback_data.endsWith(':others')) continue;
    const idx = Number(btn.callback_data.split(':')[2]);
    assert.strictEqual(CATEGORIES[idx], btn.text, 'the index must resolve back to the exact category shown on the button');
  }
});

test('buildCategoryKeyboard: falls back to the default CATEGORIES list when none is given', () => {
  const kb = buildCategoryKeyboard('exp-4', null);
  assert.ok(kb.inline_keyboard.flat().length > 1);
});

test('categoryPromptText: mentions the merchant and amount, never the pending sentinel', () => {
  const text = categoryPromptText({ merchant: 'Bonda KL', amount: 183.65, currency: 'MYR' });
  assert.match(text, /Bonda KL/);
  assert.match(text, /183\.65|183\.7|184/); // fmtMoney rounding-tolerant
  assert.ok(!text.includes(PENDING_CATEGORY), 'the internal sentinel must never leak into the user-facing prompt');
});

test('categoryPromptText: does not throw on a missing merchant', () => {
  assert.doesNotThrow(() => categoryPromptText({ amount: 10, currency: 'USD' }));
});
