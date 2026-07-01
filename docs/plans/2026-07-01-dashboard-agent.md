# #9 Dashboard Agent Implementation Plan (Phase 1: read-only, write-ready)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless natural-language chat over the account's expenses, where the model may only request three allow-listed, server-validated read tools and answers from real query results — never fabricated numbers.

**Architecture:** A transport-agnostic core `lib/agent.js` exposes `runAgent(messages, deps)`. It runs a bounded native-tool-calling loop (Groq `tools`/`tool_calls`) over a registry of read tools, each a thin wrapper over existing account-scoped reads (`sbSelect` + `buildReport`). `routes/agent.js` is a thin HTTP adapter (`POST /api/agent`, `checkDash` auth, transcript caps). All model output is treated as untrusted; the server validates every tool name + args and clamps result sizes. Everything is dependency-injected so the whole loop is unit-testable with no network and no DB.

**Tech Stack:** Node 22, Express, `node:test`, Groq (qwen/qwen3.6-27b native function-calling). No new dependency.

---

## Cross-lane dependency (Barat — `lib/groq.js`)

The existing `groqChat` returns only `message.content` (a string) and doesn't forward `tools`. Native tool-calling needs the full message (with `tool_calls`). **Barat adds an additive function** (does NOT change `groqChat`, which ocr/bot/categorize depend on):

```js
// lib/groq.js — Barat's lane. Additive; leaves groqChat untouched.
// Returns the FULL assistant message: { role:'assistant', content:string|null, tool_calls?:[...] }
async function groqChatTools(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 1500, temperature = 0, tools, tool_choice } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const body = { model, messages, max_tokens, temperature };
      if (tools) body.tools = tools;
      if (tool_choice) body.tool_choice = tool_choice;
      const r = await hreq({ method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + cfg.GROQ_KEY, 'Content-Type': 'application/json' },
        body, json: true, timeout: 30000 });
      if (r && r.choices && r.choices[0]) return r.choices[0].message || { role: 'assistant', content: '' };
      if (r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error))) throw new Error('429');
      return { role: 'assistant', content: '' };
    } catch (e) { if (attempt === 3) throw e; await new Promise(s => setTimeout(s, 1000 * (attempt + 1))); }
  }
  return { role: 'assistant', content: '' };
}
module.exports = { groqChat, groqVision, groqChatTools, MODEL_ROUTES: cfg.MODEL_ROUTES };
```

**This plan does NOT block on Barat.** Tasks 1–5 inject `chat` and are fully built+tested with a fake. Task 6 wires the real `groqChatTools` into the route; if it isn't merged yet, the route is complete but its live path is dark until Barat's function lands. Flag it in the PR.

---

## File structure

- **Create** `lib/agent.js` — tool registry + `runAgent` loop (transport-agnostic, pure-ish, deps injected).
- **Create** `routes/agent.js` — `POST /api/agent`, `checkDash` auth, transcript caps, safe errors.
- **Create** `tests/agent.test.js` — hermetic unit tests for the registry + loop (fake chat + fake sbSelect).
- **Create** `tests/agent.route.test.js` — route tests (auth, caps, error shapes, updated-transcript return).
- **Modify** `server.js` — mount `routes/agent.js` (one require + one call, matching the existing pattern).
- **Modify** `tests/smoke.test.js` — add `lib/agent.js` + `routes/agent.js` to the "all modules import" list.
- **Modify** `.env.example` — add `AGENT_MODEL` + `AGENT_MAX_TOKENS`.
- **Modify** `docs/ARCHITECTURE.md` — add `lib/agent.js`/`routes/agent.js` to the module map (§3).

Reused unchanged: `lib/reports.js` (`buildReport`, `toAmount`, `isISO` — already exported at `lib/reports.js:86`), `lib/supabase.js` (`sbSelect`), `routes/expenses.js` (`checkDash`, exported at `routes/expenses.js:52`), `lib/config.js` (`cfg`).

**Constants (module-top in `lib/agent.js`):** `MAX_ITERATIONS = 6`, `LIST_LIMIT_DEFAULT = 200`, `LIST_LIMIT_MAX = 500`, `TOP_LIMIT_DEFAULT = 10`, `TOP_LIMIT_MAX = 20`. **Route constants (`routes/agent.js`):** `MAX_MESSAGES = 20`, `MAX_CHARS = 12000`.

---

### Task 1: `lib/agent.js` — registry scaffold + `getReport` tool

**Files:**
- Create: `lib/agent.js`
- Test: `tests/agent.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent.test.js`
Expected: FAIL — "Cannot find module '../lib/agent'".

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';
/**
 * #9 Dashboard agent — transport-agnostic core.
 * The model may only request the read tools in TOOLS; the server validates every
 * tool name + args and clamps result sizes. Model output is untrusted (SOP §7.3).
 */
const { buildReport, toAmount, isISO } = require('./reports');

const MAX_ITERATIONS = 6;
const LIST_LIMIT_DEFAULT = 200, LIST_LIMIT_MAX = 500;
const TOP_LIMIT_DEFAULT = 10, TOP_LIMIT_MAX = 20;
const PERIODS = new Set(['day', 'week', 'month', 'year']);

// Account scoping + soft-delete exclusion are inherited from this single read shape,
// identical to routes/expenses.js / routes/reports.js — never a raw client filter.
async function loadExpenses(sbSelect) {
  return sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 2000 });
}
const notRejected = r => r && r.status !== 'rejected';
function inRange(dateStr, from, to) {
  if (!dateStr) return !from && !to ? true : false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}
function reqDate(args, key) {
  if (args[key] == null) return undefined;
  if (typeof args[key] !== 'string' || !isISO(args[key])) throw new Error('invalid date: ' + key);
  return args[key];
}

const TOOLS = [
  {
    name: 'getReport', kind: 'read', destructive: false,
    description: 'Totals and per-category breakdown of expenses, bucketed by day/week/month/year.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        from: { type: 'string', description: 'ISO date YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'ISO date YYYY-MM-DD, inclusive' },
      },
      required: ['period'],
    },
    validate(args) {
      args = args || {};
      if (typeof args.period !== 'string' || !PERIODS.has(args.period)) throw new Error('invalid period');
      return { period: args.period, from: reqDate(args, 'from'), to: reqDate(args, 'to') };
    },
    async run(a, { sbSelect }) {
      const rows = (await loadExpenses(sbSelect)).filter(notRejected);
      return buildReport(rows, a.period, { from: a.from, to: a.to });
    },
  },
];

function buildToolSpecs() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

module.exports = { TOOLS, buildToolSpecs, MAX_ITERATIONS,
  LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX,
  _internals: { loadExpenses, notRejected, inRange, reqDate, toAmount } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent.js tests/agent.test.js
git commit -m "feat(agent): tool registry + getReport read tool (#9)"
```

---

### Task 2: `listExpenses` tool (filter + projection + limit clamp)

**Files:**
- Modify: `lib/agent.js` (add to `TOOLS`)
- Test: `tests/agent.test.js` (append)

- [ ] **Step 1: Write the failing test** (append)

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'validate')` (tool not found).

- [ ] **Step 3: Add the tool to `TOOLS`** (insert after `getReport`)

```js
  {
    name: 'listExpenses', kind: 'read', destructive: false,
    description: 'List individual expenses, optionally filtered by date range, category, merchant, or status.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive' },
        to: { type: 'string', description: 'ISO date, inclusive' },
        category: { type: 'string' },
        merchant: { type: 'string', description: 'case-insensitive substring match' },
        status: { type: 'string' },
        limit: { type: 'integer', description: 'max rows (server caps at 500)' },
      },
    },
    validate(args) {
      args = args || {};
      const str = v => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
      let limit = Number(args.limit);
      limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;
      return { from: reqDate(args, 'from'), to: reqDate(args, 'to'),
        category: str(args.category), merchant: str(args.merchant), status: str(args.status), limit };
    },
    async run(a, { sbSelect }) {
      let rows = (await loadExpenses(sbSelect)).filter(notRejected);
      if (a.status) rows = rows.filter(r => r.status === a.status);
      if (a.category) rows = rows.filter(r => r.category === a.category);
      if (a.merchant) rows = rows.filter(r => (r.merchant || '').toLowerCase().includes(a.merchant.toLowerCase()));
      rows = rows.filter(r => inRange(r.expense_date, a.from, a.to));
      return rows.slice(0, a.limit).map(r => ({
        merchant: r.merchant, expense_date: r.expense_date, amount: r.amount,
        currency: r.currency, category: r.category, status: r.status, remark: r.remark,
      }));
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent.js tests/agent.test.js
git commit -m "feat(agent): listExpenses read tool with projection + limit clamp (#9)"
```

---

### Task 3: `topMerchants` tool (aggregate + limit clamp)

**Files:**
- Modify: `lib/agent.js` (add to `TOOLS`)
- Test: `tests/agent.test.js` (append)

- [ ] **Step 1: Write the failing test** (append)

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent.test.js`
Expected: FAIL — tool not found.

- [ ] **Step 3: Add the tool to `TOOLS`**

```js
  {
    name: 'topMerchants', kind: 'read', destructive: false,
    description: 'Merchants ranked by total spend (highest first), optionally within a date range.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive' },
        to: { type: 'string', description: 'ISO date, inclusive' },
        limit: { type: 'integer', description: 'max merchants (server caps at 20)' },
      },
    },
    validate(args) {
      args = args || {};
      let limit = Number(args.limit);
      limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), TOP_LIMIT_MAX) : TOP_LIMIT_DEFAULT;
      return { from: reqDate(args, 'from'), to: reqDate(args, 'to'), limit };
    },
    async run(a, { sbSelect }) {
      const rows = (await loadExpenses(sbSelect)).filter(notRejected).filter(r => inRange(r.expense_date, a.from, a.to));
      const by = new Map();
      for (const r of rows) {
        const amt = toAmount(r.amount);
        if (amt == null) continue; // never fabricate money (SOP / #8 rule)
        const m = r.merchant || 'Unknown';
        const cur = by.get(m) || { merchant: m, total: 0, count: 0 };
        cur.total = Math.round((cur.total + amt + Number.EPSILON) * 100) / 100;
        cur.count += 1;
        by.set(m, cur);
      }
      return [...by.values()].sort((x, y) => y.total - x.total).slice(0, a.limit);
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent.js tests/agent.test.js
git commit -m "feat(agent): topMerchants read tool with aggregation + clamp (#9)"
```

---

### Task 4: `runAgent` — the bounded tool-calling loop

**Files:**
- Modify: `lib/agent.js` (add `runAgent` + export)
- Test: `tests/agent.test.js` (append)

- [ ] **Step 1: Write the failing test** (append)

```js
const { runAgent } = require('../lib/agent');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent.test.js`
Expected: FAIL — `runAgent is not a function`.

- [ ] **Step 3: Implement `runAgent`** (add before `module.exports`; add `runAgent` to exports)

```js
const SYSTEM_PROMPT =
  'You are the expense assistant for a receipt-analysis app. Answer ONLY using the provided tools ' +
  'and the data they return. Never invent numbers, merchants, or dates. If the tools return nothing ' +
  'relevant, say so plainly. All amounts are already in the account currency. Be concise.';

function toolResult(id, name, payload) {
  return { role: 'tool', tool_call_id: id, name, content: JSON.stringify(payload) };
}

async function runAgent(messages, deps) {
  const { chat, sbSelect } = deps;
  const specs = buildToolSpecs();
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  // System prompt is owned here; the caller's transcript holds only user/assistant text turns.
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  const usedToolCalls = [];
  let iterations = 0;

  while (true) {
    iterations += 1;
    const forceFinal = iterations >= MAX_ITERATIONS + 1;
    const msg = await chat(convo, {
      tools: specs,
      tool_choice: forceFinal ? 'none' : 'auto',
    });
    convo.push(msg);
    const calls = (msg && msg.tool_calls) || [];
    if (forceFinal || calls.length === 0) {
      return { answer: (msg && msg.content) || '', toolCalls: usedToolCalls, iterations };
    }
    for (const call of calls) {
      const fn = call.function || {};
      const tool = byName.get(fn.name);
      let payload;
      try {
        if (!tool) throw new Error('unknown tool: ' + fn.name);
        let args = {};
        if (fn.arguments) { try { args = JSON.parse(fn.arguments); } catch { throw new Error('arguments were not valid JSON'); } }
        const clean = tool.validate(args);
        payload = await tool.run(clean, { sbSelect });
        usedToolCalls.push({ name: fn.name, args: clean });
      } catch (e) {
        payload = { error: e.message }; // fed back so the model can self-correct
      }
      convo.push(toolResult(call.id, fn.name, payload));
    }
  }
}
```

Update exports:

```js
module.exports = { TOOLS, buildToolSpecs, runAgent, MAX_ITERATIONS,
  LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX,
  _internals: { loadExpenses, notRejected, inRange, reqDate, toAmount } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent.test.js`
Expected: PASS (all agent unit tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agent.js tests/agent.test.js
git commit -m "feat(agent): bounded native tool-calling loop with self-correct + iteration cap (#9)"
```

---

### Task 5: `routes/agent.js` — HTTP adapter + mount

**Files:**
- Create: `routes/agent.js`
- Modify: `server.js` (mount)
- Modify: `tests/smoke.test.js` (import list)
- Test: `tests/agent.route.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountAgent = require('../routes/agent');

function appWith(runAgentFake) {
  const app = express();
  mountAgent(app, { runAgent: runAgentFake, chat: async () => ({ role: 'assistant', content: 'ok' }) });
  return app;
}
async function post(app, body, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

test('happy path returns answer + updated transcript', async () => {
  const app = appWith(async () => ({ answer: 'Spent $70.', toolCalls: [], iterations: 1 }));
  const r = await post(app, { messages: [{ role: 'user', content: 'total?' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.answer, 'Spent $70.');
  const last = r.json.messages[r.json.messages.length - 1];
  assert.deepEqual(last, { role: 'assistant', content: 'Spent $70.' });
});

test('malformed body -> 400, no stack trace', async () => {
  const app = appWith(async () => ({ answer: 'x' }));
  const r = await post(app, { nope: true });
  assert.equal(r.status, 400);
  assert.ok(!JSON.stringify(r.json).includes('at ')); // no stack frames leaked
});

test('transcript too many messages -> 413 (runAgent not called)', async () => {
  let called = false;
  const app = appWith(async () => { called = true; return { answer: 'x' }; });
  const big = { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' })) };
  const r = await post(app, big);
  assert.equal(r.status, 413);
  assert.equal(called, false);
});

test('transcript too many chars -> 413', async () => {
  const app = appWith(async () => ({ answer: 'x' }));
  const r = await post(app, { messages: [{ role: 'user', content: 'a'.repeat(12001) }] });
  assert.equal(r.status, 413);
});

test('runAgent failure -> 502 JSON, no stack trace', async () => {
  const app = appWith(async () => { throw new Error('groq down at internal/path.js:1'); });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/path.js'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent.route.test.js`
Expected: FAIL — "Cannot find module '../routes/agent'".

- [ ] **Step 3: Implement `routes/agent.js`**

```js
'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { checkDash } = require('./expenses');
const { runAgent: realRunAgent } = require('../lib/agent');
const { groqChatTools } = require('../lib/groq');

const MAX_MESSAGES = 20, MAX_CHARS = 12000;
const AGENT_MODEL = process.env.AGENT_MODEL || 'qwen/qwen3.6-27b';
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 1500;
const ALLOWED_ROLES = new Set(['user', 'assistant']);

// deps injected in tests; default to the real modules in production.
module.exports = function mountAgent(app, deps = {}) {
  const runAgent = deps.runAgent || realRunAgent;
  // The chat adapter binds model/token config onto Barat's tool-calling client.
  const chat = deps.chat || ((messages, opts) => groqChatTools(messages, { model: AGENT_MODEL, max_tokens: AGENT_MAX_TOKENS, temperature: 0, ...opts }));

  app.post('/api/agent', checkDash, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const messages = req.body && req.body.messages;
      if (!Array.isArray(messages) || messages.some(m => !m || !ALLOWED_ROLES.has(m.role) || typeof m.content !== 'string')) {
        return res.status(400).json({ error: 'messages must be an array of {role:user|assistant, content:string}' });
      }
      if (messages.length > MAX_MESSAGES) return res.status(413).json({ error: 'conversation too long (max ' + MAX_MESSAGES + ' messages)' });
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      if (chars > MAX_CHARS) return res.status(413).json({ error: 'conversation too long (max ' + MAX_CHARS + ' chars)' });

      const { sbSelect } = require('../lib/supabase');
      const out = await runAgent(messages, { chat, sbSelect });
      const updated = messages.concat([{ role: 'assistant', content: out.answer }]);
      res.json({ answer: out.answer, messages: updated, toolCalls: out.toolCalls || [] });
    } catch (e) {
      console.error('[api/agent]', e.message);
      res.status(502).json({ error: 'agent failed' });
    }
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent.route.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount + smoke**

In `server.js`, add with the other route requires/mounts (after `mountReview`):

```js
const mountAgent = require('./routes/agent');   // #9 dashboard agent
// ...
mountAgent(app);
```

In `tests/smoke.test.js`, add `'../lib/agent'` and `'../routes/agent'` to the module-import list.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all previous tests + new agent tests PASS. (Note: `routes/agent.js` requires `lib/groq`'s `groqChatTools` — if Barat's additive export isn't merged yet, `require` still succeeds only once it exists; until then keep the require lazy or land Task-6 note. See cross-lane section.)

- [ ] **Step 7: Commit**

```bash
git add routes/agent.js server.js tests/agent.route.test.js tests/smoke.test.js
git commit -m "feat(agent): POST /api/agent route with auth + transcript caps + safe errors (#9)"
```

---

### Task 6: Docs + env

**Files:**
- Modify: `.env.example`, `docs/ARCHITECTURE.md`, `docs/WORKLOG.md`, `docs/STATUS.md`

- [ ] **Step 1: `.env.example`** — add:

```
# #9 dashboard agent (native tool-calling; Barat-verified qwen)
AGENT_MODEL=qwen/qwen3.6-27b
AGENT_MAX_TOKENS=1500
```

- [ ] **Step 2: `docs/ARCHITECTURE.md`** — add `lib/agent.js` (`runAgent`, read-only tool registry, transport-agnostic) and `routes/agent.js` (`POST /api/agent`) to the §3 module map.

- [ ] **Step 3: `docs/WORKLOG.md`** — prepend a J1 entry (files, what changed, Tier-2, cross-lane `groqChatTools` dependency on Barat, tests count, what's next = #9b write-mode).

- [ ] **Step 4: `docs/STATUS.md`** — mark #9 agent built/in-review; note #9b (agentic write) as the next queued item.

- [ ] **Step 5: Commit + push + PR**

```bash
git add .env.example docs/ARCHITECTURE.md docs/WORKLOG.md docs/STATUS.md
git commit -m "docs(agent): architecture map + env + worklog for #9 dashboard agent"
git push -u origin feature/jeevan-p4-agent
gh pr create --base main --title "feat(#9): dashboard agent — constrained tool-calling, read-only (Phase 1)" --body "..."
```

---

## Definition of Done
- `runAgent` frozen interface; 3 read tools with server-side validation + limit clamps; iteration cap forces a final answer; unknown-tool/invalid-args self-correct via structured error results.
- Route: `checkDash` auth; transcript caps (20 msgs / 12k chars → 413); malformed body → 400; upstream failure → 502; no stack-trace leak; returns updated transcript.
- No new dependency; env-driven model id; account scoping + soft-delete + rejected-exclusion inherited from the shared read shape.
- All tests green (`npm test`). Docs (ARCHITECTURE/WORKLOG/STATUS/.env.example) updated.
- **Cross-lane:** Barat's additive `groqChatTools` in `lib/groq.js` merged (or flagged in the PR as the one dark path until it lands).
- PR → **independent Tier-2 QA** (AI prompt boundary) before merge, same bar as #8/#13/#19/#22.

## Self-review notes
- Spec coverage: 3 tools ✓ (T1–3), loop+caps+self-correct ✓ (T4), route auth/caps/errors/transcript ✓ (T5), env/model-id/docs ✓ (T6), guardrail clamps ✓ (T2/T3 validate), stateless (system prompt owned by runAgent, client holds user/assistant only) ✓ (T4/T5), write-ready registry (`kind`/`destructive`) ✓ (T1). Forward-compat (write tools/confirm/Telegram) intentionally NOT built — documented in spec.
- Type consistency: tool shape `{name,kind,destructive,description,parameters,validate,run}` used identically across T1–4; `run(clean, {sbSelect})`; `chat(messages,{tools,tool_choice,...})` returns full assistant message; `runAgent -> {answer,toolCalls,iterations}`; route returns `{answer,messages,toolCalls}`. Consistent.
- Placeholder scan: PR `--body "..."` in T6 Step 5 is the only fill-at-time-of-PR item (standard). No code placeholders.
