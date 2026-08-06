'use strict';
// routes/review.js Phase 4 (ADR-021): business-mode staff-first review. A clerk's queue is
// branch-filtered and they decide own-branch rows (audited as decided_by_role:'clerk'); the admin
// can't originate on a clerk's branch until the valve opens, but overrides decided rows any time.
// Session lookup rides global.fetch; expenses reads/writes are namespace-stubbed on lib/supabase.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const mountReview = require('../routes/review');

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

function stubSession(session) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; } };
}

async function call(method, path, { token, body } = {}) {
  const app = express();
  mountReview(app);
  const srv = app.listen(0);
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

const future = () => new Date(Date.now() + 3600e3).toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };

test('review queue: clerk sees only their own branch\'s pending rows', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(CLERK_A);
    const orig = supabase.sbSelect;
    supabase.sbSelect = async () => ([
      { id: 'e1', status: 'needs_review', branch_id: 'bA' },
      { id: 'e2', status: 'needs_review', branch_id: 'bB' },
    ]);
    try {
      const { status, json } = await call('GET', '/api/review', { token: 't' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(json.map((e) => e.id), ['e1']);
    } finally { supabase.sbSelect = orig; s.restore(); }
  });
});

test('clerk decides an own-branch row; audit carries decided_by_role clerk', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(CLERK_A);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    let patch;
    supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review', branch_id: 'bA', created_at: daysAgo(1), anomaly: {} }]);
    supabase.sbUpdate = async (t, w, p) => { patch = p; return [{ id: 'e1', ...p }]; };
    try {
      const { status } = await call('POST', '/api/review/e1', { token: 't', body: { decision: 'approve' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(patch.status, 'approved');
      assert.strictEqual(patch.anomaly.review.decided_by_role, 'clerk');
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('clerk cannot decide another branch\'s row (403, no write)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(CLERK_A);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    let wrote = false;
    supabase.sbSelect = async () => ([{ id: 'e2', status: 'needs_review', branch_id: 'bB', created_at: daysAgo(1) }]);
    supabase.sbUpdate = async () => { wrote = true; return [{}]; };
    try {
      const { status } = await call('POST', '/api/review/e2', { token: 't', body: { decision: 'approve' } });
      assert.strictEqual(status, 403);
      assert.strictEqual(wrote, false);
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('admin blocked before the valve (403), allowed after it fires', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', ANOMALY_VALVE_DAYS: '7' }, async () => {
    const s = stubSession(ADMIN);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    supabase.sbUpdate = async (t, w, p) => [{ id: 'eX', ...p }];
    try {
      supabase.sbSelect = async () => ([{ id: 'eX', status: 'needs_review', branch_id: 'bA', created_at: daysAgo(2), anomaly: {} }]);
      const early = await call('POST', '/api/review/eX', { token: 't', body: { decision: 'reject' } });
      assert.strictEqual(early.status, 403, 'clerk decides first inside the valve window');

      supabase.sbSelect = async () => ([{ id: 'eX', status: 'needs_review', branch_id: 'bA', created_at: daysAgo(9), anomaly: {} }]);
      const late = await call('POST', '/api/review/eX', { token: 't', body: { decision: 'reject' } });
      assert.strictEqual(late.status, 200, 'valve open after 7 days');
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('admin overrides an already-decided row; audit carries overrode:true', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    let patch;
    supabase.sbSelect = async () => ([{ id: 'e1', status: 'approved', branch_id: 'bA', created_at: daysAgo(1), anomaly: { review: { decision: 'approve' } } }]);
    supabase.sbUpdate = async (t, w, p) => { patch = p; return [{ id: 'e1', ...p }]; };
    try {
      const { status } = await call('POST', '/api/review/e1', { token: 't', body: { decision: 'reject' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(patch.status, 'rejected');
      assert.strictEqual(patch.anomaly.review.decided_by_role, 'admin');
      assert.strictEqual(patch.anomaly.review.overrode, true);
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});
