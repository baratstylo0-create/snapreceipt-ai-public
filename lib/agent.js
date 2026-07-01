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
