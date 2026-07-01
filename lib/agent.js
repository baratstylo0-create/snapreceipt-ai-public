'use strict';
/**
 * #9 Dashboard agent — transport-agnostic core.
 * The model may only request the read tools in TOOLS; the server validates every
 * tool name + args and clamps result sizes. Model output is untrusted (SOP §7.3).
 */
const { buildReport, toAmount, isISO } = require('./reports');

const MAX_ITERATIONS = 6;
const ROW_FETCH_LIMIT = 10000; // money reports must not silently undercount — mirrors routes/reports.js REPORT_ROW_LIMIT
const LIST_LIMIT_DEFAULT = 200, LIST_LIMIT_MAX = 500;
const TOP_LIMIT_DEFAULT = 10, TOP_LIMIT_MAX = 20;
const PERIODS = new Set(['day', 'week', 'month', 'year']);

// Account scoping + soft-delete AND rejected-exclusion are enforced in the query itself,
// identical to routes/reports.js — a rejected expense (#5 review queue) must never count
// toward money totals, and the row cap must be spent on rows that matter, not rejected ones.
async function loadExpenses(sbSelect) {
  return sbSelect('expenses', { extra: 'deleted_at=is.null&status=neq.rejected', order: 'created_at.desc', limit: ROW_FETCH_LIMIT });
}
const notRejected = r => r && r.status !== 'rejected'; // defensive: the query already excludes rejected rows
function inRange(dateStr, from, to) {
  if (!dateStr) return !from && !to;
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
      const fetched = await loadExpenses(sbSelect);
      const rows = fetched.filter(notRejected); // notRejected = defensive; query already excludes rejected
      const report = buildReport(rows, a.period, { from: a.from, to: a.to });
      return { ...report, fetched_count: fetched.length, truncated: fetched.length >= ROW_FETCH_LIMIT };
    },
  },
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
      const fetched = await loadExpenses(sbSelect);
      let rows = fetched.filter(notRejected);
      if (a.status) rows = rows.filter(r => r.status === a.status);
      if (a.category) rows = rows.filter(r => r.category === a.category);
      if (a.merchant) rows = rows.filter(r => (r.merchant || '').toLowerCase().includes(a.merchant.toLowerCase()));
      rows = rows.filter(r => inRange(r.expense_date, a.from, a.to));
      const items = rows.slice(0, a.limit).map(r => ({
        merchant: r.merchant, expense_date: r.expense_date, amount: r.amount,
        currency: r.currency, category: r.category, status: r.status, remark: r.remark,
      }));
      // Surface the DB-fetch cap so the model (told "never invent numbers") knows the listing
      // may be partial — same money-safety signal getReport carries. `truncated` reflects the
      // raw 10000-row loadExpenses cap, NOT the per-tool `limit` (a deliberate, documented clamp).
      return { items, fetched_count: fetched.length, truncated: fetched.length >= ROW_FETCH_LIMIT };
    },
  },
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
      const fetched = await loadExpenses(sbSelect);
      const rows = fetched.filter(notRejected).filter(r => inRange(r.expense_date, a.from, a.to));
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
      const items = [...by.values()].sort((x, y) => y.total - x.total).slice(0, a.limit);
      // Surface the DB-fetch cap: past 10000 rows a merchant's true total could be undercounted
      // with no signal. `truncated` reflects the raw loadExpenses cap, not the per-tool limit.
      return { items, fetched_count: fetched.length, truncated: fetched.length >= ROW_FETCH_LIMIT };
    },
  },
];

function buildToolSpecs() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

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
    if (msg && typeof msg === 'object') convo.push(msg); // never store a null/garbage turn
    const calls = (msg && msg.tool_calls) || [];
    if (forceFinal || calls.length === 0) {
      return { answer: (msg && msg.content) || '', toolCalls: usedToolCalls, iterations };
    }
    for (const call of calls) {
      const c = call || {};
      const fn = c.function || {};
      let payload;
      try {
        if (typeof c.id !== 'string' || !c.id) throw new Error('malformed tool call: missing id');
        const tool = byName.get(fn.name);
        if (!tool) throw new Error('unknown tool: ' + fn.name);
        let args = {};
        if (fn.arguments) { try { args = JSON.parse(fn.arguments); } catch { throw new Error('arguments were not valid JSON'); } }
        const clean = tool.validate(args);
        payload = await tool.run(clean, { sbSelect });
        usedToolCalls.push({ name: fn.name, args: clean });
      } catch (e) {
        payload = { error: e.message }; // fed back so the model can self-correct
      }
      // Only answer a call that has a valid id — a tool message with a null/undefined
      // tool_call_id would be rejected by the provider on the next turn.
      if (typeof c.id === 'string' && c.id) convo.push(toolResult(c.id, fn.name, payload));
    }
  }
}

module.exports = { TOOLS, buildToolSpecs, runAgent, MAX_ITERATIONS, ROW_FETCH_LIMIT,
  LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX,
  _internals: { loadExpenses, notRejected, inRange, reqDate, toAmount } };
