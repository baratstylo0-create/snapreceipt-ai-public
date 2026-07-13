'use strict';
// routes/submissions.js (ADR-022 Phase 7): the "Send to Admin" branch hand-off.
// Flag-gated by capabilities.branchSubmission (AND multiUser); clerk submits their OWN branch's
// period (server forces the branch from req.scope — a body branch_id is ignored); a re-submit
// UPDATES the existing (branch, period) row, never duplicates; reversible via PATCH 'withdrawn';
// admin reads all, clerk reads own. Same stub harness as tests/branches.route.test.js.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountSubmissions = require('../routes/submissions');

function app(deps) {
  const a = express();
  mountSubmissions(a, deps);
  return a;
}

async function req(a, method, path, { token, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function stubDb({ session, handlers = {} } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (table === 'sessions' && method === 'GET') return { text: async () => JSON.stringify(session ? [session] : []) };
    const key = table + ':' + method;
    if (handlers[key]) return { text: async () => JSON.stringify(handlers[key]({ url: u, body })) };
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{ id: 'patched', ...body }]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };

const ON = { CAP_MULTI_USER: 'true', CAP_BRANCH_SUBMISSION: 'true' };

test('submissions: branchSubmission flag OFF -> 404 (even with multiUser ON)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_BRANCH_SUBMISSION: 'false' }, async () => {
    const { status } = await req(app(), 'GET', '/api/submissions');
    assert.strictEqual(status, 404);
  });
});

test('submissions: multiUser OFF -> 404 (personal product has no hand-off)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', ACCOUNT_TYPE: 'personal', CAP_BRANCH_SUBMISSION: 'true' }, async () => {
    const { status } = await req(app(), 'POST', '/api/submissions', { body: { period: '2026-07' } });
    assert.strictEqual(status, 404);
  });
});

test('submissions: clerk POST submits their OWN branch (body branch_id ignored) -> 201', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A, handlers: { 'submissions:GET': () => [] } });
    try {
      const { status, json } = await req(app(), 'POST', '/api/submissions',
        { token: 't', body: { period: '2026-07', note: 'July run', branch_id: 'bEVIL' } });
      assert.strictEqual(status, 201);
      const post = stub.calls.find((c) => c.method === 'POST' && /\/submissions/.test(c.url));
      assert.ok(post, 'a submissions row was inserted');
      assert.strictEqual(post.body.branch_id, 'bA', 'branch comes from the session scope, never the body');
      assert.strictEqual(post.body.submitted_by, 'uc');
      assert.strictEqual(post.body.status, 'submitted');
      assert.strictEqual(post.body.period, '2026-07');
      assert.ok(json.submission, 'echoes the created submission');
    } finally { stub.restore(); }
  });
});

// --- C5 follow-up: a SUBMIT (POST, either branch) fires the fire-and-forget admin ping;
// a WITHDRAW (PATCH) never does. notifySubmissionReady itself is unit-tested in
// tests/bot.submissionping.test.js — this only proves the route CALLS it, with the right
// args, from both success branches, and never lets it affect the response. ------------------

test('submissions: a NEW submission (insert, 201) fires the admin ping with branch_id + period', async () => {
  await withEnv(ON, async () => {
    const pinged = [];
    const stub = stubDb({ session: CLERK_A, handlers: { 'submissions:GET': () => [] } });
    try {
      const { status } = await req(
        app({ notifySubmissionReady: async (branchId, period) => { pinged.push({ branchId, period }); } }),
        'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } },
      );
      assert.strictEqual(status, 201);
      assert.deepStrictEqual(pinged, [{ branchId: 'bA', period: '2026-07' }]);
    } finally { stub.restore(); }
  });
});

test('submissions: a RE-submit (update, 200) ALSO fires the admin ping', async () => {
  await withEnv(ON, async () => {
    const existing = { id: 'sub1', branch_id: 'bA', period: '2026-07', status: 'withdrawn' };
    const pinged = [];
    const stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [existing],
      'submissions:PATCH': ({ body }) => [{ ...existing, ...body }],
    } });
    try {
      const { status } = await req(
        app({ notifySubmissionReady: async (branchId, period) => { pinged.push({ branchId, period }); } }),
        'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } },
      );
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(pinged, [{ branchId: 'bA', period: '2026-07' }]);
    } finally { stub.restore(); }
  });
});

test('submissions: a SLOW ping never delays the response (fire-and-forget, not awaited)', async () => {
  await withEnv(ON, async () => {
    let resolvePing;
    const pingStarted = new Promise((resolve) => { resolvePing = resolve; });
    const stub = stubDb({ session: CLERK_A, handlers: { 'submissions:GET': () => [] } });
    try {
      const start = Date.now();
      const { status } = await req(
        app({ notifySubmissionReady: async () => { resolvePing(); return new Promise(() => {}); } }), // never resolves
        'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } },
      );
      assert.strictEqual(status, 201);
      assert.ok(Date.now() - start < 2000, 'the response must not wait on the ping promise');
      await pingStarted; // confirm it was actually invoked, just not awaited
    } finally { stub.restore(); }
  });
});

test('submissions: a ping that REJECTS never surfaces as a failed submission', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A, handlers: { 'submissions:GET': () => [] } });
    try {
      const { status } = await req(
        app({ notifySubmissionReady: async () => { throw new Error('telegram down'); } }),
        'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } },
      );
      assert.strictEqual(status, 201, 'a rejected ping promise must never turn a successful submit into a failure');
    } finally { stub.restore(); }
  });
});

test('submissions: re-submit for the same (branch, period) UPDATES, never duplicates', async () => {
  await withEnv(ON, async () => {
    const existing = { id: 'sub1', branch_id: 'bA', period: '2026-07', status: 'withdrawn' };
    const stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [existing],
      'submissions:PATCH': ({ body }) => [{ ...existing, ...body }],
    } });
    try {
      const { status, json } = await req(app(), 'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } });
      assert.strictEqual(status, 200, 're-submit is an update, not a create');
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST' && /\/submissions/.test(c.url)), false, 'no second insert');
      const patch = stub.calls.find((c) => c.method === 'PATCH' && /\/submissions/.test(c.url));
      assert.ok(patch);
      assert.strictEqual(patch.body.status, 'submitted', 're-submit flips it back to submitted');
      assert.ok(patch.body.submitted_at, 'timestamp bumped');
      assert.strictEqual(json.submission.status, 'submitted');
    } finally { stub.restore(); }
  });
});

test('submissions: admin POST -> 403 (the hand-off is clerk -> admin, not admin -> self)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status } = await req(app(), 'POST', '/api/submissions', { token: 't', body: { period: '2026-07' } });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('submissions: bad/missing period -> 400 (server-side validation, SEC-5)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A });
    try {
      for (const period of [undefined, '', 'July', '2026-13', '2026-7', '2026-07-01']) {
        const { status } = await req(app(), 'POST', '/api/submissions', { token: 't', body: { period } });
        assert.strictEqual(status, 400, 'period ' + JSON.stringify(period) + ' must be rejected');
      }
    } finally { stub.restore(); }
  });
});

test('submissions: GET — admin sees ALL branches, clerk is forced to their own', async () => {
  await withEnv(ON, async () => {
    let stub = stubDb({ session: ADMIN, handlers: {
      'submissions:GET': () => [{ id: 's1', branch_id: 'bA', period: '2026-07' }, { id: 's2', branch_id: 'bB', period: '2026-07' }],
    } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/submissions?period=2026-07', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.submissions.length, 2);
      const getCall = stub.calls.find((c) => c.method === 'GET' && /\/submissions/.test(c.url));
      assert.ok(!/branch_id=eq\./.test(getCall.url), 'admin query carries no branch filter');
      assert.match(getCall.url, /period=eq\.2026-07/);
    } finally { stub.restore(); }

    stub = stubDb({ session: CLERK_A, handlers: { 'submissions:GET': () => [{ id: 's1', branch_id: 'bA', period: '2026-07' }] } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/submissions', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.submissions.length, 1);
      const getCall = stub.calls.find((c) => c.method === 'GET' && /\/submissions/.test(c.url));
      assert.match(getCall.url, /branch_id=eq\.bA/, 'clerk query is hard-filtered to their branch');
    } finally { stub.restore(); }
  });
});

test('submissions: PATCH withdraw — clerk own branch OK; another branch 403; bad status 400', async () => {
  await withEnv(ON, async () => {
    // own branch → withdrawn
    let stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [{ id: 'sub1', branch_id: 'bA', period: '2026-07', status: 'submitted' }],
      'submissions:PATCH': ({ body }) => [{ id: 'sub1', branch_id: 'bA', period: '2026-07', ...body }],
    } });
    try {
      const { status, json } = await req(app(), 'PATCH', '/api/submissions/sub1', { token: 't', body: { status: 'withdrawn' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.submission.status, 'withdrawn');
    } finally { stub.restore(); }

    // someone else's branch → 403, and no write happened
    stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [{ id: 'sub2', branch_id: 'bB', period: '2026-07', status: 'submitted' }],
    } });
    try {
      const { status } = await req(app(), 'PATCH', '/api/submissions/sub2', { token: 't', body: { status: 'withdrawn' } });
      assert.strictEqual(status, 403);
      assert.strictEqual(stub.calls.some((c) => c.method === 'PATCH' && /\/submissions/.test(c.url)), false);
    } finally { stub.restore(); }

    // garbage status → 400
    stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [{ id: 'sub1', branch_id: 'bA', period: '2026-07', status: 'submitted' }],
    } });
    try {
      const { status } = await req(app(), 'PATCH', '/api/submissions/sub1', { token: 't', body: { status: 'shredded' } });
      assert.strictEqual(status, 400);
    } finally { stub.restore(); }
  });
});

test('submissions: PATCH (withdraw OR re-submit-via-status) never fires the admin ping — POST only', async () => {
  await withEnv(ON, async () => {
    const pinged = [];
    const stub = stubDb({ session: CLERK_A, handlers: {
      'submissions:GET': () => [{ id: 'sub1', branch_id: 'bA', period: '2026-07', status: 'submitted' }],
      'submissions:PATCH': ({ body }) => [{ id: 'sub1', branch_id: 'bA', period: '2026-07', ...body }],
    } });
    try {
      const a = app({ notifySubmissionReady: async (branchId, period) => { pinged.push({ branchId, period }); } });
      await req(a, 'PATCH', '/api/submissions/sub1', { token: 't', body: { status: 'withdrawn' } });
      await req(a, 'PATCH', '/api/submissions/sub1', { token: 't', body: { status: 'submitted' } });
      assert.strictEqual(pinged.length, 0, 'PATCH must never trigger the admin ping, regardless of the resulting status');
    } finally { stub.restore(); }
  });
});

test('submissions: no session in business mode -> 401', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: null });
    try {
      const { status } = await req(app(), 'GET', '/api/submissions', { token: 'ghost' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});
