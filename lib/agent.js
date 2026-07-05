'use strict';
/**
 * #9 Dashboard agent — transport-agnostic core.
 * The model may only request the read tools in TOOLS; the server validates every
 * tool name + args and clamps result sizes. Model output is untrusted (SOP §7.3).
 */
const { buildReport, toAmount, isISO } = require('./reports');
const { cfg } = require('./config');
const { KINDS, createProposal, consumeProposal, canAutoConfirm } = require('./agentProposals');
const { sanitizeExpensePatch } = require('./expenseValidation');
const { resolveDecision, canDecide, buildReviewAudit } = require('./reviewDecision');
const templates = require('./templates'); // namespace import so tests can stub getFieldSpec/saveTemplate

const MAX_ITERATIONS = 6;
const ROW_FETCH_LIMIT = 10000; // money reports must not silently undercount — mirrors routes/reports.js REPORT_ROW_LIMIT
const LIST_LIMIT_DEFAULT = 200, LIST_LIMIT_MAX = 500;
const TOP_LIMIT_DEFAULT = 10, TOP_LIMIT_MAX = 20;
const PERIODS = new Set(['day', 'week', 'month', 'year']);
// FieldSpec types accepted by proposeAddTemplateField (mirrors lib/templates VALID_TYPES).
const TEMPLATE_FIELD_TYPES = new Set(['text', 'date', 'number', 'currency', 'category']);

// Account scoping + soft-delete AND rejected-exclusion are enforced in the query itself,
// identical to routes/reports.js — a rejected expense (#5 review queue) must never count
// toward money totals, and the row cap must be spent on rows that matter, not rejected ones.
async function loadExpenses(sbSelect) {
  return sbSelect('expenses', { extra: 'deleted_at=is.null&status=neq.rejected', order: 'created_at.desc', limit: ROW_FETCH_LIMIT });
}
const notRejected = r => r && r.status !== 'rejected'; // defensive: the query already excludes rejected rows

// Fetch ONE expense by id, account-scoped (sbSelect injects account_id). Unlike loadExpenses
// this does NOT filter out soft-deleted rows: the propose/confirm write path must be able to
// SEE a soft-deleted row to report 'already deleted' rather than silently claiming 'not found'.
async function loadExpenseById(sbSelect, id) {
  if (typeof id !== 'string' || !id) return null;
  const rows = await sbSelect('expenses', { eq: { id } });
  return (Array.isArray(rows) && rows[0]) ? rows[0] : null;
}
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
  // --- ADR-019 write tools -------------------------------------------------
  // Each of these VALIDATES ONLY and returns a PENDING proposal — it NEVER writes to the DB.
  // The write happens later, and only via confirmProposal(), which re-validates fresh. A
  // proposal object is the "the model wants to do X" token; nothing is done until confirmed.
  // The return shape { proposal: { id, kind, summary, diff } } is deliberately DISTINCT from
  // the read tools' data returns so the loop/caller can detect that a proposal was produced.
  {
    name: 'proposeEditExpense', kind: 'edit', destructive: false,
    description: 'Propose an edit to a single expense (does NOT apply it — the user must confirm). '
      + 'Provide the expense id and only the fields to change.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the expense id to edit' },
        changes: { type: 'object', description: 'fields to change, e.g. { "category": "Meals & Entertainment" }' },
      },
      required: ['id', 'changes'],
    },
    validate(args) {
      args = args || {};
      if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
      if (!args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes)) {
        throw new Error('changes must be an object of fields to update');
      }
      const clean = sanitizeExpensePatch(args.changes); // EXACT same validation as PATCH /api/expenses
      if (!clean.ok) throw new Error(clean.error);
      if (!Object.keys(clean.body).length) throw new Error('no editable fields to update');
      return { id: args.id, patch: clean.body };
    },
    async run(a, { sbSelect }) {
      const row = await loadExpenseById(sbSelect, a.id);
      if (!row) return { error: 'expense not found' };
      if (row.deleted_at) return { error: 'expense is deleted' };
      const diff = {};
      for (const k of Object.keys(a.patch)) {
        const before = row[k] == null ? '(empty)' : String(row[k]);
        const after = a.patch[k] == null ? '(empty)' : String(a.patch[k]);
        diff[k] = before + ' → ' + after; // "before → after"
      }
      const fields = Object.keys(a.patch).join(', ');
      const summary = 'Edit ' + (row.merchant || 'expense') + ' — change ' + fields;
      const proposal = createProposal({ kind: KINDS.EDIT, args: { id: a.id, patch: a.patch }, summary, diff });
      if (proposal.error) return { error: proposal.error };
      return { proposal: { id: proposal.id, kind: proposal.kind, summary: proposal.summary, diff: proposal.diff } };
    },
  },
  {
    name: 'proposeDeleteExpense', kind: 'delete', destructive: true,
    description: 'Propose deleting (soft-delete) a single expense (does NOT delete it — the user must confirm).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the expense id to delete' } },
      required: ['id'],
    },
    validate(args) {
      args = args || {};
      if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
      return { id: args.id };
    },
    async run(a, { sbSelect }) {
      const row = await loadExpenseById(sbSelect, a.id);
      if (!row) return { error: 'expense not found' };
      if (row.deleted_at) return { error: 'already deleted' };
      const amount = row.amount == null ? '(no amount)' : String(row.amount);
      const currency = row.currency || cfg.DEFAULT_CURRENCY;
      const summary = 'Delete ' + (row.merchant || 'expense') + ' — ' + amount + ' ' + currency;
      const diff = { merchant: row.merchant || '(unknown)', amount: amount + ' ' + currency, expense_date: row.expense_date || '(no date)' };
      const proposal = createProposal({ kind: KINDS.DELETE, args: { id: a.id }, summary, diff });
      if (proposal.error) return { error: proposal.error };
      return { proposal: { id: proposal.id, kind: proposal.kind, summary: proposal.summary, diff: proposal.diff } };
    },
  },
  {
    name: 'proposeReviewDecision', kind: 'review-decision', destructive: false,
    description: 'Propose approving or rejecting an expense that is pending review (does NOT decide it — the user must confirm).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the expense id under review' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
        note: { type: 'string', description: 'optional reviewer note' },
      },
      required: ['id', 'decision'],
    },
    validate(args) {
      args = args || {};
      if (typeof args.id !== 'string' || !args.id) throw new Error('id is required');
      const resolved = resolveDecision(args.decision);
      if (!resolved.ok) throw new Error(resolved.error);
      const note = (typeof args.note === 'string' && args.note.trim() !== '') ? args.note.slice(0, 500) : null;
      return { id: args.id, decision: args.decision, status: resolved.status, note };
    },
    async run(a, { sbSelect }) {
      const row = await loadExpenseById(sbSelect, a.id);
      const decidable = canDecide(row); // 404 if missing, 409 if not needs_review
      if (!decidable.ok) return { error: decidable.error };
      const summary = (a.decision === 'approve' ? 'Approve ' : 'Reject ') + (row.merchant || 'expense')
        + (a.note ? ' — note: ' + a.note : '');
      const diff = { status: (row.status || '(none)') + ' → ' + a.status };
      if (a.note) diff.note = a.note;
      const proposal = createProposal({
        kind: KINDS.REVIEW_DECISION,
        args: { id: a.id, status: a.status, decision: a.decision, note: a.note },
        summary, diff,
      });
      if (proposal.error) return { error: proposal.error };
      return { proposal: { id: proposal.id, kind: proposal.kind, summary: proposal.summary, diff: proposal.diff } };
    },
  },
  {
    name: 'proposeAddTemplateField', kind: 'add-template-field', destructive: false,
    description: 'Propose adding a new field to the account\'s custom-field template (does NOT save it — the user must confirm).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the field label to add, e.g. "Payment Method"' },
        type: { type: 'string', enum: ['text', 'date', 'number', 'currency', 'category'], description: 'field type (default "text")' },
        required: { type: 'boolean', description: 'whether the field is required (default false)' },
      },
      required: ['name'],
    },
    validate(args) {
      args = args || {};
      if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('name is required');
      const type = (typeof args.type === 'string' && TEMPLATE_FIELD_TYPES.has(args.type)) ? args.type : 'text';
      const required = args.required === true;
      return { name: args.name.trim(), type, required };
    },
    async run(a, { sbSelect, getFieldSpec }) {
      const getSpec = getFieldSpec || templates.getFieldSpec;
      const spec = await getSpec();
      const cols = (spec && Array.isArray(spec.columns)) ? spec.columns : [];
      const nextHeaders = cols.map(c => c.label).concat([a.name]);
      // HONESTY CAVEAT (carried from the Manage visual-builder): a template is saved by re-parsing
      // its CSV header row, which only recovers a field's KEY/LABEL — the chosen type/required flags
      // do NOT round-trip through that save path (an unknown header becomes a free-text, optional
      // column). Say so plainly so the confirm card can't overpromise.
      const caveat = 'Note: saving re-parses the CSV header, so the type ("' + a.type + '") and required ('
        + a.required + ') settings may not be preserved — a new custom field is stored as optional free text.';
      const summary = 'Add template field "' + a.name + '" — ' + caveat;
      const diff = {
        columns: cols.map(c => c.label).join(', ') + '  →  ' + nextHeaders.join(', '),
        caveat,
      };
      const proposal = createProposal({
        kind: KINDS.ADD_TEMPLATE_FIELD,
        args: { name: a.name, type: a.type, required: a.required },
        summary, diff,
      });
      if (proposal.error) return { error: proposal.error };
      return { proposal: { id: proposal.id, kind: proposal.kind, summary: proposal.summary, diff: proposal.diff } };
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
  'relevant, say so plainly. All amounts from getReport/topMerchants are already in the account ' +
  'currency, ' + cfg.DEFAULT_CURRENCY + ' — always state amounts with this currency code (e.g. "' +
  cfg.DEFAULT_CURRENCY + ' 63.40"), never a currency symbol like $, since the account currency may ' +
  'not be USD. Be concise.';

function toolResult(id, name, payload) {
  return { role: 'tool', tool_call_id: id, name, content: JSON.stringify(payload) };
}

async function runAgent(messages, deps) {
  const { chat } = deps;
  const autoMode = deps && deps.autoMode === true; // NEW: opt-in, defaults false — reads are byte-identical when off
  const specs = buildToolSpecs();
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  // System prompt is owned here; the caller's transcript holds only user/assistant text turns.
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  const usedToolCalls = [];
  let iterations = 0;
  // A pending (non-auto-confirmable) proposal, once produced, forces the loop to stop after this
  // iteration and is surfaced in the return value so a human can confirm it before any second write.
  let pendingProposal = null;

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
      const out = { answer: (msg && msg.content) || '', toolCalls: usedToolCalls, iterations };
      if (pendingProposal) out.proposal = pendingProposal;
      return out;
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
        // Pass the FULL deps down: read tools only destructure { sbSelect }, propose tools only
        // destructure { sbSelect, getFieldSpec } — extra keys are harmless. confirmProposal (below)
        // needs the write helpers, so they must be present on the object we pass around.
        payload = await tool.run(clean, deps);
        usedToolCalls.push({ name: fn.name, args: clean });
      } catch (e) {
        payload = { error: e.message }; // fed back so the model can self-correct
      }

      // A propose* tool produced a pending proposal. Decide, in OUR code (never the model's), whether
      // it may auto-confirm — that gate is canAutoConfirm() in agentProposals, consulted here.
      if (payload && payload.proposal) {
        if (autoMode && canAutoConfirm(payload.proposal.kind)) {
          // Auto-confirm path (low-risk kinds only): execute now and feed the OUTCOME back to the
          // model. Do NOT stop the loop — the model may keep reasoning/calling more tools this turn.
          const confirmResult = await confirmProposal(payload.proposal.id, deps);
          payload = { autoConfirmed: true, ...confirmResult };
        } else if (!pendingProposal) {
          // Pending path: needs a human confirm click. Surface the FIRST such proposal, push the
          // proposal result to the model UNCHANGED (so it narrates it), and force the loop to stop.
          pendingProposal = {
            id: payload.proposal.id, kind: payload.proposal.kind,
            summary: payload.proposal.summary, diff: payload.proposal.diff,
          };
        }
        // A second non-auto pending proposal in the same batch is left as-is (v1: only the first is
        // surfaced/stopped on) — its result is still fed back so the model can mention it too.
      }

      // Only answer a call that has a valid id — a tool message with a null/undefined
      // tool_call_id would be rejected by the provider on the next turn.
      if (typeof c.id === 'string' && c.id) convo.push(toolResult(c.id, fn.name, payload));
    }

    // A pending proposal must interrupt the turn: the model's NEXT chat() call is its final one and
    // must not be able to queue a second tool call before a human sees this one. Same mechanism as
    // forceFinal (tool_choice:'none'), driven by re-entering the loop with forceFinal now true.
    if (pendingProposal) {
      const finalMsg = await chat(convo, { tools: specs, tool_choice: 'none' });
      if (finalMsg && typeof finalMsg === 'object') convo.push(finalMsg);
      return {
        answer: (finalMsg && finalMsg.content) || '',
        toolCalls: usedToolCalls,
        iterations: iterations + 1,
        proposal: pendingProposal,
      };
    }
  }
}

// Quote a single CSV field for a header line (RFC-4180-ish): wrap in quotes and double any
// embedded quote if it contains a comma, quote, or newline. Mirrors what an exported CSV looks
// like, so saveTemplate()'s parser recovers the intended labels.
function csvHeaderField(label) {
  const s = String(label);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// confirmProposal(proposalId, deps) — the EXECUTE step (ADR-019). Single-use: consumes the
// pending proposal, RE-VALIDATES fresh against the current row (it may have changed since the
// propose call), then writes via the SAME helpers the dashboard routes use. Never throws — any
// failure returns a safe { ok:false, error } with no internals leaked (SOP §7.2).
async function confirmProposal(proposalId, deps) {
  const d = deps || {};
  const sbSelect = d.sbSelect;
  const sbUpdate = d.sbUpdate;
  const sbSoftDelete = d.sbSoftDelete;
  const saveTemplate = d.saveTemplate || templates.saveTemplate;
  const getFieldSpec = d.getFieldSpec || templates.getFieldSpec;
  const consume = d.consumeProposal || consumeProposal;

  try {
    const proposal = consume(proposalId);
    if (!proposal) return { ok: false, error: 'That action is no longer available — ask me again.' };

    if (proposal.kind === KINDS.EDIT) {
      const { id, patch } = proposal.args || {};
      // Re-validate the patch fresh (the allow-list/type rules are the security boundary).
      const clean = sanitizeExpensePatch(patch);
      if (!clean.ok || !Object.keys(clean.body).length) return { ok: false, error: 'This edit is no longer valid.' };
      const row = await loadExpenseById(sbSelect, id);
      if (!row) return { ok: false, error: 'That expense no longer exists.' };
      if (row.deleted_at) return { ok: false, error: 'That expense has been deleted.' };
      const rows = await sbUpdate('expenses', { id }, clean.body);
      return { ok: true, kind: proposal.kind, result: (rows && rows[0]) || { ok: true } };
    }

    if (proposal.kind === KINDS.DELETE) {
      const { id } = proposal.args || {};
      const row = await loadExpenseById(sbSelect, id);
      if (!row) return { ok: false, error: 'That expense no longer exists.' };
      if (row.deleted_at) return { ok: false, error: 'That expense has already been deleted.' };
      await sbSoftDelete('expenses', { id });
      return { ok: true, kind: proposal.kind, result: { ok: true } };
    }

    if (proposal.kind === KINDS.REVIEW_DECISION) {
      const { id, status, decision, note } = proposal.args || {};
      const resolved = resolveDecision(decision);
      if (!resolved.ok) return { ok: false, error: 'This review decision is no longer valid.' };
      const row = await loadExpenseById(sbSelect, id);
      const decidable = canDecide(row); // re-check: the row may no longer be needs_review
      if (!decidable.ok) return { ok: false, error: decidable.error };
      const anomaly = buildReviewAudit(row.anomaly, decision, note);
      const rows = await sbUpdate('expenses', { id }, { status: status || resolved.status, anomaly });
      return { ok: true, kind: proposal.kind, result: (rows && rows[0]) || { ok: true, status: status || resolved.status } };
    }

    if (proposal.kind === KINDS.ADD_TEMPLATE_FIELD) {
      const { name } = proposal.args || {};
      if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: 'This template field is no longer valid.' };
      // Reuse the dashboard's own save path: build the CSV header (current labels + the new
      // field) and hand it to saveTemplate() — exactly what POST /api/templates does.
      const spec = await getFieldSpec();
      const cols = (spec && Array.isArray(spec.columns)) ? spec.columns : [];
      const header = cols.map(c => c.label).concat([name.trim()]).map(csvHeaderField).join(',');
      const saved = await saveTemplate(header, { name: 'default' });
      return { ok: true, kind: proposal.kind, result: saved || { ok: true } };
    }

    return { ok: false, error: 'Unknown action.' };
  } catch (_e) {
    // Never leak internals (SOP §7.2). The specific error is server-side only.
    return { ok: false, error: 'That action could not be completed.' };
  }
}

module.exports = { TOOLS, buildToolSpecs, runAgent, confirmProposal, MAX_ITERATIONS, ROW_FETCH_LIMIT,
  LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX,
  _internals: { loadExpenses, loadExpenseById, notRejected, inRange, reqDate, toAmount, csvHeaderField } };
