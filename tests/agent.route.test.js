'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountAgent = require('../routes/agent');
const { cfg } = require('../lib/config');

function appWith(runAgentFake, extraDeps = {}) {
  const app = express();
  mountAgent(app, { runAgent: runAgentFake, chat: async () => ({ role: 'assistant', content: 'ok' }), ...extraDeps });
  return app;
}
async function post(app, body, headers = {}, path = '/api/agent') {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}
function postConfirm(app, body, headers = {}) {
  return post(app, body, headers, '/api/agent/confirm');
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

test('checkDash enforced: 401 without token, 200 with correct token when DASHBOARD_TOKEN set', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const app = appWith(async () => ({ answer: 'ok', toolCalls: [] }));
    const noKey = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(noKey.status, 401);
    const withKey = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer secret' });
    assert.equal(withKey.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('rejects a message whose content is not a string -> 400', async () => {
  const app = appWith(async () => ({ answer: 'x', toolCalls: [] }));
  const r = await post(app, { messages: [{ role: 'user', content: 42 }] });
  assert.equal(r.status, 400);
});

// --- ADR-019 Task 6: autoMode threading + proposal pass-through -------------------------------

test('autoMode:true in body -> deps.autoMode passed into runAgent is true', async () => {
  let seenDeps;
  const app = appWith(async (messages, deps) => { seenDeps = deps; return { answer: 'ok', toolCalls: [] }; });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }], autoMode: true });
  assert.equal(r.status, 200);
  assert.equal(seenDeps.autoMode, true);
});

test('autoMode omitted -> deps.autoMode passed into runAgent is false', async () => {
  let seenDeps;
  const app = appWith(async (messages, deps) => { seenDeps = deps; return { answer: 'ok', toolCalls: [] }; });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(seenDeps.autoMode, false);
});

test('autoMode:"true" (string, not boolean) -> resolves to false, never loose-truthy', async () => {
  let seenDeps;
  const app = appWith(async (messages, deps) => { seenDeps = deps; return { answer: 'ok', toolCalls: [] }; });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }], autoMode: 'true' });
  assert.equal(r.status, 200);
  assert.equal(seenDeps.autoMode, false);
});

test('autoMode:1 (truthy non-boolean) -> resolves to false', async () => {
  let seenDeps;
  const app = appWith(async (messages, deps) => { seenDeps = deps; return { answer: 'ok', toolCalls: [] }; });
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }], autoMode: 1 });
  assert.equal(r.status, 200);
  assert.equal(seenDeps.autoMode, false);
});

test('response includes proposal key when runAgent returns one', async () => {
  const proposal = { id: 'p_1', kind: 'edit', summary: 's', diff: {} };
  const app = appWith(async () => ({ answer: 'confirm?', toolCalls: [], proposal }));
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.proposal, proposal);
});

test('response omits proposal key entirely when runAgent returns none', async () => {
  const app = appWith(async () => ({ answer: 'ok', toolCalls: [] }));
  const r = await post(app, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal('proposal' in r.json, false);
});

// --- POST /api/agent/confirm -------------------------------------------------------------------

test('confirm: valid proposalId -> calls confirmProposal with it, returns its result verbatim', async () => {
  let seenId, seenDeps;
  const confirmProposalFake = async (id, deps) => { seenId = id; seenDeps = deps; return { ok: true, kind: 'edit', result: { id: 'e1' } }; };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, { proposalId: 'p_abc123' });
  assert.equal(r.status, 200);
  assert.equal(seenId, 'p_abc123');
  assert.ok(seenDeps.sbSelect && seenDeps.sbUpdate && seenDeps.sbSoftDelete && seenDeps.saveTemplate && seenDeps.getFieldSpec);
  assert.deepEqual(r.json, { ok: true, kind: 'edit', result: { id: 'e1' } });
});

test('confirm: missing proposalId -> 400, confirmProposal never called', async () => {
  let called = false;
  const confirmProposalFake = async () => { called = true; return { ok: true }; };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, {});
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'proposalId is required' });
  assert.equal(called, false);
});

test('confirm: non-string proposalId -> 400, confirmProposal never called', async () => {
  let called = false;
  const confirmProposalFake = async () => { called = true; return { ok: true }; };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, { proposalId: 12345 });
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('confirm: empty string proposalId -> 400, confirmProposal never called', async () => {
  let called = false;
  const confirmProposalFake = async () => { called = true; return { ok: true }; };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, { proposalId: '' });
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('confirm: oversized proposalId (5000 chars) is truncated, never crashes', async () => {
  let seenId;
  const huge = 'p_' + 'a'.repeat(5000);
  const confirmProposalFake = async (id) => { seenId = id; return { ok: false, error: 'That action is no longer available — ask me again.' }; };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, { proposalId: huge });
  assert.equal(r.status, 200);
  assert.ok(seenId.length <= 200, 'proposalId must be bounded before use');
  assert.equal(r.json.ok, false);
});

test('confirm: checkDash enforced same as /api/agent (401 without token, 200 with correct token)', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: async () => ({ ok: true }) });
    const noKey = await postConfirm(app, { proposalId: 'p_1' });
    assert.equal(noKey.status, 401);
    const withKey = await postConfirm(app, { proposalId: 'p_1' }, { Authorization: 'Bearer secret' });
    assert.equal(withKey.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('confirm: unexpected confirmProposal throw -> 502 JSON, no stack trace (defense in depth)', async () => {
  const confirmProposalFake = async () => { throw new Error('unexpected at internal/path.js:1'); };
  const app = appWith(async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake });
  const r = await postConfirm(app, { proposalId: 'p_1' });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/path.js'));
});

// --- branch-scope wiring (2026-07-09, independent-review finding #1: CRITICAL) --------------
// writeDeps used to be built ONCE at mount time, so req.scope (per-request, set by
// checkDashSession in business mode) never reached lib/agent.js's sbSelect/sbUpdate/
// sbSoftDelete calls — a branch clerk's Agent chat could read AND write every other branch's
// expenses. These tests prove the fix: a real per-request req.scope must reach the underlying
// DB helper calls exactly as ordinary routes (routes/expenses.js) already do it.

function appWithScope(scope, runAgentFake, extraDeps = {}) {
  const app = express();
  // Simulates checkDashSession's business-mode path (real session lookup is out of scope for
  // this route-only test — the wiring under test is "does req.scope reach the DB helpers",
  // not session resolution itself, which lib/auth.js already covers).
  app.use((req, res, next) => { req.scope = scope; next(); });
  mountAgent(app, { runAgent: runAgentFake, chat: async () => ({ role: 'assistant', content: 'ok' }), ...extraDeps });
  return app;
}

test('POST /api/agent: a branch-A clerk session -> the sbSelect deps.runAgent receives is scoped to branch A', async () => {
  let seenScope;
  const scope = { account_id: 'acct1', role: 'clerk', branch_id: 'bA' };
  const sbSelectSpy = async (table, opts) => { seenScope = opts && opts.scope; return []; };
  const runAgentFake = async (messages, deps) => { await deps.sbSelect('expenses', { extra: 'x' }); return { answer: 'ok', toolCalls: [] }; };
  const app = appWithScope(scope, runAgentFake, { sbSelect: sbSelectSpy });
  const r = await post(app, { messages: [{ role: 'user', content: 'list expenses' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(seenScope, scope, 'the real req.scope must reach sbSelect — this is the whole branch-isolation guarantee');
});

test('POST /api/agent: sbUpdate/sbSoftDelete deps.runAgent receives are also scoped', async () => {
  let seenUpdateScope, seenDeleteScope;
  const scope = { account_id: 'acct1', role: 'clerk', branch_id: 'bA' };
  const sbUpdateSpy = async (table, key) => { seenUpdateScope = key && key.scope; return [{}]; };
  const sbSoftDeleteSpy = async (table, key) => { seenDeleteScope = key && key.scope; };
  const runAgentFake = async (messages, deps) => {
    await deps.sbUpdate('expenses', { id: 'e1' }, { amount: 1 });
    await deps.sbSoftDelete('expenses', { id: 'e1' });
    return { answer: 'ok', toolCalls: [] };
  };
  const app = appWithScope(scope, runAgentFake, { sbUpdate: sbUpdateSpy, sbSoftDelete: sbSoftDeleteSpy });
  const r = await post(app, { messages: [{ role: 'user', content: 'edit' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(seenUpdateScope, scope);
  assert.deepEqual(seenDeleteScope, scope);
});

test('POST /api/agent: a caller-supplied opts.scope inside a tool call can never override the trusted req.scope', async () => {
  // Mirrors lib/supabase.js's stampScope contract: trusted scope always wins, applied AFTER
  // any caller-provided options — so a malicious/buggy tool call can't smuggle a different
  // branch via its own opts.
  let seenScope;
  const trueScope = { account_id: 'acct1', role: 'clerk', branch_id: 'bA' };
  const sbSelectSpy = async (table, opts) => { seenScope = opts && opts.scope; return []; };
  const runAgentFake = async (messages, deps) => {
    await deps.sbSelect('expenses', { scope: { account_id: 'acct1', role: 'admin', branch_id: 'bB' } }); // attempted override
    return { answer: 'ok', toolCalls: [] };
  };
  const app = appWithScope(trueScope, runAgentFake, { sbSelect: sbSelectSpy });
  await post(app, { messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(seenScope, trueScope, 'the trusted req.scope must win over anything a tool call tries to pass');
});

test('POST /api/agent/confirm: confirmProposal receives scope-wrapped sbUpdate/sbSoftDelete too', async () => {
  let seenScope;
  const scope = { account_id: 'acct1', role: 'clerk', branch_id: 'bA' };
  const sbUpdateSpy = async (table, key) => { seenScope = key && key.scope; return [{}]; };
  const confirmProposalFake = async (id, deps) => { await deps.sbUpdate('expenses', { id: 'e1' }, {}); return { ok: true }; };
  const app = appWithScope(scope, async () => ({ answer: 'x' }), { confirmProposal: confirmProposalFake, sbUpdate: sbUpdateSpy });
  const r = await postConfirm(app, { proposalId: 'p_1' });
  assert.equal(r.status, 200);
  assert.deepEqual(seenScope, scope);
});

test('POST /api/agent: personal/static-token mode (no req.scope set) -> scope: undefined reaches sbSelect (byte-identical prior behavior)', async () => {
  let seenOpts;
  const sbSelectSpy = async (table, opts) => { seenOpts = opts; return []; };
  const runAgentFake = async (messages, deps) => { await deps.sbSelect('expenses', {}); return { answer: 'ok', toolCalls: [] }; };
  const app = appWith(runAgentFake, { sbSelect: sbSelectSpy }); // no req.scope middleware — the original appWith()
  await post(app, { messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(seenOpts.scope, undefined);
});
