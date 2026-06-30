'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normaliseExpenseCategory } = require('../lib/categorize');

test('maps keywords to the canonical category set', () => {
  assert.strictEqual(normaliseExpenseCategory('Uber ride'), 'Petrol');
  assert.strictEqual(normaliseExpenseCategory('Lunch at cafe'), 'Food');
  assert.strictEqual(normaliseExpenseCategory('Adobe subscription'), 'Software');
  assert.strictEqual(normaliseExpenseCategory('spare parts'), 'Inventory');
  assert.strictEqual(normaliseExpenseCategory('mystery'), 'Others');
  assert.strictEqual(normaliseExpenseCategory(''), 'Others');
});
