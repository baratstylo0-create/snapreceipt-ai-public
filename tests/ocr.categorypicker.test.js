'use strict';
// Pure-function tests for the category-picker's button/prompt building (Owner request
// 2026-07-03). No network — buildCategoryKeyboard/categoryPromptText are hermetic.
const test = require('node:test');
const assert = require('node:assert');
const { buildCategoryKeyboard, categoryPromptText, editCategoryKeyboard, datePromptText, duplicateRejectedText, buildDuplicateKeyboard, PENDING_CATEGORY } = require('../lib/ocr');
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

// --- editCategoryKeyboard (Owner request 2026-07-04): the single "Edit category" button
// attached to the normal "Expense Captured" reply. ---

test('editCategoryKeyboard: exactly one button, correct callback_data prefix', () => {
  const kb = editCategoryKeyboard('exp-5');
  const flat = kb.inline_keyboard.flat();
  assert.strictEqual(flat.length, 1);
  assert.strictEqual(flat[0].callback_data, 'catedit:exp-5');
  assert.match(flat[0].text, /Edit/i);
});

test('editCategoryKeyboard: callback_data stays well under Telegram\'s 64-byte limit for a real UUID', () => {
  const kb = editCategoryKeyboard('a'.repeat(36));
  assert.ok(Buffer.byteLength(kb.inline_keyboard[0][0].callback_data, 'utf8') <= 64);
});

// --- datePromptText (issue #149 part 2): the "I couldn't read the date clearly" ask,
// mirroring categoryPromptText's style/tone. ---

test('datePromptText: mentions the merchant and amount, and asks for DD/MM/YYYY', () => {
  const text = datePromptText({ merchant: 'Bonda KL', amount: 183.65, currency: 'MYR' });
  assert.match(text, /Bonda KL/);
  assert.match(text, /183\.65|183\.7|184/); // fmtMoney rounding-tolerant
  assert.match(text, /DD\/MM\/YYYY/);
});

test('datePromptText: does not throw on a missing merchant', () => {
  assert.doesNotThrow(() => datePromptText({ amount: 10, currency: 'USD' }));
});

// --- duplicateRejectedText / buildDuplicateKeyboard (issue #162 D13): the "rejected —
// duplicate" reply, referencing the EXISTING receipt, not a fresh one. ---

test('duplicateRejectedText: mentions the EXISTING receipt\'s merchant/amount/date', () => {
  const text = duplicateRejectedText({ id: 'exp-1', merchant: 'Bonda KL', amount: 183.65, currency: 'MYR', expense_date: '2026-07-01' });
  assert.match(text, /Bonda KL/);
  assert.match(text, /183\.65|183\.7|184/);
  assert.match(text, /2026-07-01/);
  assert.match(text, /duplicate/i);
});

test('duplicateRejectedText: does not throw when the existing row is missing a date', () => {
  assert.doesNotThrow(() => duplicateRejectedText({ merchant: 'X', amount: 10, currency: 'USD' }));
});

test('buildDuplicateKeyboard: View and Edit buttons, callback_data references the EXISTING id', () => {
  const kb = buildDuplicateKeyboard('exp-existing-1');
  const flat = kb.inline_keyboard.flat();
  assert.strictEqual(flat.length, 2);
  assert.strictEqual(flat[0].callback_data, 'dupview:exp-existing-1');
  assert.strictEqual(flat[1].callback_data, 'dupedit:exp-existing-1');
  assert.match(flat[0].text, /View/i);
  assert.match(flat[1].text, /Edit/i);
});

test('buildDuplicateKeyboard: callback_data stays well under Telegram\'s 64-byte limit for a real UUID', () => {
  const kb = buildDuplicateKeyboard('a'.repeat(36));
  for (const btn of kb.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64);
  }
});
