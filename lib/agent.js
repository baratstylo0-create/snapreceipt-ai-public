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
];

function buildToolSpecs() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

module.exports = { TOOLS, buildToolSpecs, MAX_ITERATIONS, ROW_FETCH_LIMIT,
  LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX,
  _internals: { loadExpenses, notRejected, inRange, reqDate, toAmount } };
