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
  assert.equal(out.truncated, false);
  assert.equal(out.fetched_count, 3);   // fakeSb returns 3 rows
});

test('getReport fetches with rejected excluded at the query level and the money-report row cap', async () => {
  const tool = TOOLS.find(t => t.name === 'getReport');
  let captured;
  const spySb = async (table, opts) => { captured = { table, opts }; return []; };
  await tool.run(tool.validate({ period: 'month' }), { sbSelect: spySb });
  assert.equal(captured.table, 'expenses');
  assert.match(captured.opts.extra, /status=neq\.rejected/);
  assert.match(captured.opts.extra, /deleted_at=is\.null/);
  assert.equal(captured.opts.limit, 10000);
});

test('getReport flags truncated when the row cap is hit', async () => {
  const tool = TOOLS.find(t => t.name === 'getReport');
  const many = Array.from({ length: 10000 }, (_, i) => ({ merchant: 'M', expense_date: '2026-06-01', amount: 1, status: 'saved' }));
  const out = await tool.run(tool.validate({ period: 'month' }), { sbSelect: async () => many });
  assert.equal(out.truncated, true);
  assert.equal(out.fetched_count, 10000);
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
