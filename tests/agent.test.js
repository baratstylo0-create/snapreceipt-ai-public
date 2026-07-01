'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS, buildToolSpecs } = require('../lib/agent');

const ROWS = [
  { merchant: 'Shell', expense_date: '2026-06-03', amount: 50, currency: 'USD', category: 'Fuel & Auto', status: 'saved' },
  { merchant: 'Tesco', expense_date: '2026-06-10', amount: 20, currency: 'USD', category: 'Groceries', status: 'saved' },
  { merchant: 'Ghost', expense_date: '2026-06-11', amount: 999, currency: 'USD', category: 'Fuel & Auto', status: 'rejected' },
];
const fakeSb = async () => ROWS;

test('getReport validates period and runs buildReport over account-scoped rows', async () => {
  const tool = TOOLS.find(t => t.name === 'getReport');
  assert.equal(tool.kind, 'read');
  const clean = tool.validate({ period: 'month' });
  const out = await tool.run(clean, { sbSelect: fakeSb });
  assert.equal(out.total, 70);        // rejected row excluded from money
  assert.equal(out.count, 2);
  assert.ok(Array.isArray(out.buckets));
});

test('getReport rejects a bad period and a non-ISO date', () => {
  const tool = TOOLS.find(t => t.name === 'getReport');
  assert.throws(() => tool.validate({ period: 'decade' }), /period/);
  assert.throws(() => tool.validate({ period: 'day', from: '2026-13-99' }), /date/);
});

test('buildToolSpecs emits one JSON-schema entry per registered tool', () => {
  const specs = buildToolSpecs();
  assert.equal(specs.length, TOOLS.length);
  assert.ok(specs.every(s => s.type === 'function' && s.function && s.function.name));
});
