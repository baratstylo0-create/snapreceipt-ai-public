'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { TOOLS, buildToolSpecs, runAgent } = require('../lib/agent');

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

test('listExpenses filters, projects (no ai_raw), excludes rejected, clamps limit', async () => {
  const tool = TOOLS.find(t => t.name === 'listExpenses');
  const clean = tool.validate({ category: 'Fuel & Auto', from: '2026-06-01', to: '2026-06-30', limit: 999999 });
  assert.equal(clean.limit, 500); // clamped to LIST_LIMIT_MAX
  const withRaw = [{ merchant: 'Shell', expense_date: '2026-06-03', amount: 50, currency: 'USD', category: 'Fuel & Auto', status: 'saved', remark: 'x', ai_raw: { secret: 1 } }];
  const out = await tool.run(clean, { sbSelect: async () => withRaw });
  assert.equal(out.length, 1);
  assert.equal(out[0].merchant, 'Shell');
  assert.equal('ai_raw' in out[0], false); // projection drops ai_raw
});

test('listExpenses defaults limit and rejects a non-ISO from', () => {
  const tool = TOOLS.find(t => t.name === 'listExpenses');
  assert.equal(tool.validate({}).limit, 200); // LIST_LIMIT_DEFAULT
  assert.throws(() => tool.validate({ from: 'yesterday' }), /date/);
});

test('topMerchants aggregates spend desc, excludes rejected, uses toAmount, clamps limit', async () => {
  const tool = TOOLS.find(t => t.name === 'topMerchants');
  const rows = [
    { merchant: 'Shell', expense_date: '2026-06-01', amount: 50, status: 'saved' },
    { merchant: 'Shell', expense_date: '2026-06-02', amount: '30', status: 'saved' }, // numeric string
    { merchant: 'Tesco', expense_date: '2026-06-02', amount: 20, status: 'saved' },
    { merchant: 'Bad', expense_date: '2026-06-02', amount: true, status: 'saved' },   // garbage -> ignored
    { merchant: 'Ghost', expense_date: '2026-06-02', amount: 999, status: 'rejected' },
  ];
  const clean = tool.validate({ limit: 100 });
  assert.equal(clean.limit, 20); // clamped to TOP_LIMIT_MAX
  const out = await tool.run(clean, { sbSelect: async () => rows });
  assert.deepEqual(out[0], { merchant: 'Shell', total: 80, count: 2 });
  assert.equal(out[1].merchant, 'Tesco');
  assert.equal(out.find(m => m.merchant === 'Bad'), undefined); // garbage amount contributed nothing
  assert.equal(out.find(m => m.merchant === 'Ghost'), undefined); // rejected excluded
});

// A scripted fake chat: yields queued responses in order. Each is a full assistant message.
function fakeChat(script) {
  let i = 0;
  const calls = [];
  const fn = async (messages, opts) => { calls.push({ messages, opts }); return script[i++]; };
  fn.calls = calls;
  return fn;
}
const deps = extra => ({ sbSelect: async () => [
  { merchant: 'Shell', expense_date: '2026-06-03', amount: 50, currency: 'USD', category: 'Fuel & Auto', status: 'saved' },
], ...extra });

test('runAgent returns a direct answer when the model makes no tool call', async () => {
  const chat = fakeChat([{ role: 'assistant', content: 'Hello!' }]);
  const out = await runAgent([{ role: 'user', content: 'hi' }], { ...deps(), chat });
  assert.equal(out.answer, 'Hello!');
  assert.equal(out.iterations, 1);
  // system prompt is prepended by runAgent, not required from the caller
  assert.equal(chat.calls[0].messages[0].role, 'system');
});

test('runAgent runs a requested tool then answers from the result', async () => {
  const chat = fakeChat([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'topMerchants', arguments: '{"limit":5}' } }] },
    { role: 'assistant', content: 'Your top merchant is Shell at $50.' },
  ]);
  const out = await runAgent([{ role: 'user', content: 'top merchant?' }], { ...deps(), chat });
  assert.equal(out.answer, 'Your top merchant is Shell at $50.');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'topMerchants');
  // second chat call must include a role:tool message carrying the result
  const secondMsgs = chat.calls[1].messages;
  assert.ok(secondMsgs.some(m => m.role === 'tool' && m.tool_call_id === 'c1'));
});

test('runAgent feeds a structured error back for an unknown tool (no throw)', async () => {
  const chat = fakeChat([
    { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'deleteEverything', arguments: '{}' } }] },
    { role: 'assistant', content: 'Sorry, I cannot do that.' },
  ]);
  const out = await runAgent([{ role: 'user', content: 'nuke it' }], { ...deps(), chat });
  assert.equal(out.answer, 'Sorry, I cannot do that.');
  const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /error/i);
});

test('runAgent feeds a structured error back for invalid args', async () => {
  const chat = fakeChat([
    { role: 'assistant', content: null, tool_calls: [{ id: 'y', type: 'function', function: { name: 'getReport', arguments: '{"period":"decade"}' } }] },
    { role: 'assistant', content: 'Let me try monthly instead.' },
  ]);
  const out = await runAgent([{ role: 'user', content: 'report' }], { ...deps(), chat });
  const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /error/i);
  assert.equal(out.answer, 'Let me try monthly instead.');
});

test('runAgent enforces the iteration cap and forces a final text answer', async () => {
  // Always request a tool; runAgent must stop at MAX_ITERATIONS and force tool_choice:none.
  const loopMsg = { role: 'assistant', content: null, tool_calls: [{ id: 'z', type: 'function', function: { name: 'getReport', arguments: '{"period":"month"}' } }] };
  const script = Array(6).fill(loopMsg).concat([{ role: 'assistant', content: 'Final summary.' }]);
  const chat = fakeChat(script);
  const out = await runAgent([{ role: 'user', content: 'loop' }], { ...deps(), chat });
  assert.equal(out.answer, 'Final summary.');
  assert.equal(out.iterations, 7);
  // the final (7th) call must have forced no more tools
  assert.equal(chat.calls[6].opts.tool_choice, 'none');
});

test('runAgent bad-JSON tool arguments -> error result, not a crash', async () => {
  const chat = fakeChat([
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'getReport', arguments: '{not json' } }] },
    { role: 'assistant', content: 'ok' },
  ]);
  const out = await runAgent([{ role: 'user', content: 'x' }], { ...deps(), chat });
  const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /error/i);
  assert.equal(out.answer, 'ok');
});
