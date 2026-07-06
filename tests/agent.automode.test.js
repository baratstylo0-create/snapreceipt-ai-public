'use strict';
// ADR-019 (#9) Task 5 — runAgent forced-stop for pending proposals + server-side auto-mode dispatch.
// The store (agentProposals.canAutoConfirm) decides WHICH kinds may auto-confirm; this suite proves
// runAgent consults that gate at the right time and NEVER lets the model chain a second unconfirmed
// write. All deps are stubbed; no network, no DB.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { runAgent } = require('../lib/agent');
const proposals = require('../lib/agentProposals');
const { KINDS } = proposals;

beforeEach(() => proposals._reset());

// A scripted fake chat: yields queued assistant messages in order, recording each call's opts so we
// can assert tool_choice. Mirrors the harness in tests/agent.test.js.
function fakeChat(script) {
  let i = 0;
  const calls = [];
  const fn = async (messages, opts) => { calls.push({ messages, opts }); return script[i++]; };
  fn.calls = calls;
  return fn;
}

const ROW = { id: 'e1', merchant: 'Shell', expense_date: '2026-06-03', amount: 50, currency: 'USD', category: 'Others', status: 'saved' };
const REVIEW_ROW = { ...ROW, status: 'needs_review', anomaly: { flag: 'dup' } };

// Deps whose write helpers record calls (so we can assert they were / were not invoked).
function makeDeps(rowsById, extra = {}) {
  const writes = { update: [], softDelete: [], saveTemplate: [] };
  const base = {
    sbSelect: async (table, { eq = {} } = {}) => {
      if (eq.id != null) { const r = rowsById[eq.id]; return r ? [r] : []; }
      return Object.values(rowsById);
    },
    sbUpdate: async (table, { id }, patch) => { writes.update.push({ table, id, patch }); return [{ id, ...(rowsById[id] || {}), ...patch }]; },
    sbSoftDelete: async (table, { id }) => { writes.softDelete.push({ table, id }); },
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', label: 'Merchant', type: 'text', required: true }] }),
    saveTemplate: async (csv, o) => { writes.saveTemplate.push({ csv, o }); return { columns: [], csv }; },
    consumeProposal: (id) => proposals.consumeProposal(id),
  };
  return { deps: { ...base, ...extra }, writes };
}

const proposeCall = (id, name, args) => ({
  role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

// --- pending path: no autoMode / autoMode:false forces stop + surfaces proposal, no write ------

test('no autoMode passed + proposeEditExpense -> stops, returns pending proposal, NEVER writes', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'e1', changes: { category: 'Groceries' } }),
    { role: 'assistant', content: 'I propose changing the category — confirm?' },
    { role: 'assistant', content: 'SHOULD NEVER BE REACHED' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } }); // NOTE: deps has NO autoMode key
  const out = await runAgent([{ role: 'user', content: 'change it' }], { ...deps, chat });

  assert.ok(out.proposal, 'return value must carry the pending proposal');
  assert.equal(out.proposal.kind, KINDS.EDIT);
  assert.ok(out.proposal.id && out.proposal.summary && out.proposal.diff);
  assert.equal(out.answer, 'I propose changing the category — confirm?');
  // The loop stopped: exactly 2 chat calls (the propose turn + the forced final), NOT 3.
  assert.equal(chat.calls.length, 2);
  // The model's final chat() call must be forced to make no further tool call.
  assert.equal(chat.calls[1].opts.tool_choice, 'none');
  // NO write of any kind — confirmProposal was not called.
  assert.equal(writes.update.length + writes.softDelete.length + writes.saveTemplate.length, 0);
  assert.equal(proposals._size(), 1, 'the proposal is parked awaiting a human confirm');
});

test('autoMode:false explicitly + proposeEditExpense -> pending, no write (same as omitted)', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'e1', changes: { category: 'Groceries' } }),
    { role: 'assistant', content: 'Confirm this edit?' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'edit' }], { ...deps, chat, autoMode: false });
  assert.equal(out.proposal.kind, KINDS.EDIT);
  assert.equal(chat.calls[1].opts.tool_choice, 'none');
  assert.equal(writes.update.length, 0);
});

// --- auto-confirm path: autoMode:true + auto-confirmable kinds execute, no stop ----------------

test('autoMode:true + proposeEditExpense (edit) -> auto-confirms, no stop, no surfaced proposal', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'e1', changes: { category: 'Groceries' } }),
    { role: 'assistant', content: 'Done — I changed the category to Groceries.' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'set category to groceries' }], { ...deps, chat, autoMode: true });

  assert.equal(writes.update.length, 1, 'confirmProposal executed the edit');
  assert.deepEqual(writes.update[0], { table: 'expenses', id: 'e1', patch: { category: 'Groceries' } });
  assert.equal('proposal' in out, false, 'no pending proposal surfaced when auto-confirmed');
  assert.equal(out.answer, 'Done — I changed the category to Groceries.');
  // NOT force-stopped: the propose turn used auto (allowing more tools), only the natural
  // no-tool-call final turn ended it. tool_choice on the propose turn must be 'auto', not 'none'.
  assert.equal(chat.calls[0].opts.tool_choice, 'auto');
  // The tool result fed back reflects the executed outcome, not the pending-proposal shape.
  const toolMsg = chat.calls[1].messages.find(m => m.role === 'tool');
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.autoConfirmed, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, KINDS.EDIT);
  assert.equal('proposal' in parsed, false);
  assert.equal(proposals._size(), 0, 'proposal consumed by auto-confirm');
});

test('autoMode:true + proposeReviewDecision (review-decision) -> auto-confirms like edit', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeReviewDecision', { id: 'e1', decision: 'approve', note: 'ok' }),
    { role: 'assistant', content: 'Approved.' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...REVIEW_ROW } });
  const out = await runAgent([{ role: 'user', content: 'approve it' }], { ...deps, chat, autoMode: true });
  assert.equal(writes.update.length, 1, 'review decision written via confirmProposal');
  assert.equal(writes.update[0].patch.status, 'approved');
  assert.equal('proposal' in out, false);
  const parsed = JSON.parse(chat.calls[1].messages.find(m => m.role === 'tool').content);
  assert.equal(parsed.autoConfirmed, true);
  assert.equal(parsed.kind, KINDS.REVIEW_DECISION);
});

test('autoMode:true can auto-confirm then continue: a second (read) tool call runs same turn', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'e1', changes: { category: 'Groceries' } }),
    proposeCall('c2', 'topMerchants', { limit: 3 }), // model keeps going after the auto-confirmed edit
    { role: 'assistant', content: 'Edited and here are your top merchants.' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'edit then show top' }], { ...deps, chat, autoMode: true });
  assert.equal(writes.update.length, 1);
  assert.equal(out.toolCalls.length, 2);
  assert.equal(out.toolCalls[1].name, 'topMerchants');
  assert.equal('proposal' in out, false);
});

// --- delete / add-template-field: NEVER auto-confirm even under autoMode:true ------------------

test('autoMode:true + proposeDeleteExpense (delete) -> STILL pending, no write, confirm NOT called', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeDeleteExpense', { id: 'e1' }),
    { role: 'assistant', content: 'This will delete the Shell expense — confirm?' },
    { role: 'assistant', content: 'SHOULD NEVER BE REACHED' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'delete it' }], { ...deps, chat, autoMode: true });
  assert.ok(out.proposal, 'delete must surface a pending proposal even in auto-mode');
  assert.equal(out.proposal.kind, KINDS.DELETE);
  assert.equal(chat.calls.length, 2, 'stopped: propose turn + forced final only');
  assert.equal(chat.calls[1].opts.tool_choice, 'none');
  assert.equal(writes.softDelete.length, 0, 'confirmProposal must NOT have been auto-called');
  assert.equal(proposals._size(), 1);
});

test('autoMode:true + proposeAddTemplateField (add-template-field) -> STILL pending, no write', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeAddTemplateField', { name: 'Payment Method' }),
    { role: 'assistant', content: 'I propose adding a "Payment Method" field — confirm?' },
  ]);
  const { deps, writes } = makeDeps({});
  const out = await runAgent([{ role: 'user', content: 'add a field' }], { ...deps, chat, autoMode: true });
  assert.equal(out.proposal.kind, KINDS.ADD_TEMPLATE_FIELD);
  assert.equal(chat.calls[1].opts.tool_choice, 'none');
  assert.equal(writes.saveTemplate.length, 0);
});

// --- auto-confirm failure feeds back but does NOT stop ------------------------------------------

test('autoMode:true: confirmProposal returning {ok:false} feeds the failure back, loop continues', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'e1', changes: { category: 'Groceries' } }),
    { role: 'assistant', content: 'Sorry, that edit could not be applied.' },
  ]);
  // sbUpdate throws -> confirmProposal catches it and returns { ok:false }, never throws.
  const { deps } = makeDeps({ e1: { ...ROW } }, {
    sbUpdate: async () => { throw new Error('SECRET db failure'); },
  });
  const out = await runAgent([{ role: 'user', content: 'edit' }], { ...deps, chat, autoMode: true });
  assert.equal('proposal' in out, false, 'a failed auto-confirm does not surface a pending proposal');
  assert.equal(chat.calls[0].opts.tool_choice, 'auto', 'not force-stopped on a confirm failure');
  const parsed = JSON.parse(chat.calls[1].messages.find(m => m.role === 'tool').content);
  assert.equal(parsed.autoConfirmed, true);
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(parsed.error, /SECRET/); // no internals leaked
});

// --- multiple pending proposals in one batch: only the FIRST is surfaced/stopped on ------------

test('two non-auto pending proposals in one turn -> only the FIRST is surfaced; still no crash', async () => {
  const chat = fakeChat([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'proposeDeleteExpense', arguments: JSON.stringify({ id: 'e1' }) } },
      { id: 'c2', type: 'function', function: { name: 'proposeDeleteExpense', arguments: JSON.stringify({ id: 'e2' }) } },
    ] },
    { role: 'assistant', content: 'I can delete these — confirm the first?' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW }, e2: { ...ROW, id: 'e2', merchant: 'Tesco' } });
  const out = await runAgent([{ role: 'user', content: 'delete both' }], { ...deps, chat, autoMode: true });
  assert.ok(out.proposal, 'the first pending proposal is surfaced');
  assert.equal(out.proposal.kind, KINDS.DELETE);
  assert.equal(chat.calls[1].opts.tool_choice, 'none');
  assert.equal(writes.softDelete.length, 0, 'neither delete auto-executed');
  // Both tool calls were executed (each produced a proposal) and each got a tool result.
  const toolMsgs = chat.calls[1].messages.filter(m => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
});

// --- read-only + {error} paths remain unchanged -------------------------------------------------

test('autoMode:true + a plain read tool (no proposal) behaves exactly as before, no stop', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'topMerchants', { limit: 5 }),
    { role: 'assistant', content: 'Top merchant: Shell.' },
  ]);
  const { deps } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'top merchant' }], { ...deps, chat, autoMode: true });
  assert.equal(out.answer, 'Top merchant: Shell.');
  assert.equal('proposal' in out, false);
  assert.equal(chat.calls[0].opts.tool_choice, 'auto'); // never forced to none by a read
  assert.equal(out.toolCalls.length, 1);
});

test('a tool call producing an {error} (not a proposal) does not stop the loop', async () => {
  const chat = fakeChat([
    proposeCall('c1', 'proposeEditExpense', { id: 'ghost', changes: { category: 'Others' } }), // row missing -> {error}
    proposeCall('c2', 'topMerchants', { limit: 3 }), // model recovers and keeps going
    { role: 'assistant', content: 'That expense was not found; here are top merchants instead.' },
  ]);
  const { deps, writes } = makeDeps({ e1: { ...ROW } });
  const out = await runAgent([{ role: 'user', content: 'edit ghost' }], { ...deps, chat, autoMode: true });
  assert.equal('proposal' in out, false, 'an {error} is not a proposal');
  assert.equal(out.toolCalls.length, 2, 'loop continued past the error to the next tool');
  const firstTool = JSON.parse(chat.calls[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1').content);
  assert.match(firstTool.error, /not found/);
  assert.equal(writes.update.length, 0);
});
