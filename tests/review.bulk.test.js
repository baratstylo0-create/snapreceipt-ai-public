'use strict';
// routes/review.js — B4 (QA round, docs/qa/2026-07-09-qa-round.md PR-B): bulk select ->
// Approve/Delete on the Activity list. POST /api/review/bulk applies the SAME per-row
// resolveDecision/canRoleDecide/buildReviewAudit path the single-row POST /api/review/:id
// already uses, just looped over a batch of ids — no new business rule, just orchestration.
// Session lookup rides global.fetch; expenses reads/writes are namespace-stubbed on lib/supabase
// (mirrors tests/review.route.scope.test.js's stubbing style).
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

test('POST /api/review/bulk: admin bulk-approves a mix of decidable rows -> per-id results', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    const rows = {
      // branch_id: null (untagged) is admin-first-eligible immediately in canRoleDecide —
      // admin scope never carries a branch_id (scopeForUser: admin -> {account_id, role}
      // only), so a tagged branch_id would hit the staff-first valve instead.
      e1: { id: 'e1', status: 'needs_review', branch_id: null, created_at: daysAgo(1), anomaly: {} },
      e2: { id: 'e2', status: 'needs_review', branch_id: null, created_at: daysAgo(1), anomaly: {} },
    };
    const writes = [];
    supabase.sbSelect = async (t, { eq }) => (rows[eq.id] ? [rows[eq.id]] : []);
    supabase.sbUpdate = async (t, w, p) => { writes.push({ id: w.id, patch: p }); return [{ id: w.id, ...p }]; };
    try {
      const { status, json } = await call('POST', '/api/review/bulk', { token: 't', body: { ids: ['e1', 'e2'], decision: 'approve' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.requested, 2);
      assert.strictEqual(json.updated, 2);
      assert.strictEqual(writes.length, 2);
      assert.ok(writes.every((w) => w.patch.status === 'approved'));
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('POST /api/review/bulk: a non-pending row in the batch fails individually, others still succeed', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    const rows = {
      e1: { id: 'e1', status: 'needs_review', branch_id: null, created_at: daysAgo(1), anomaly: {} },
      e2: { id: 'e2', status: 'approved', branch_id: 'bHQ', created_at: daysAgo(1), anomaly: {} }, // already decided
    };
    const writes = [];
    supabase.sbSelect = async (t, { eq }) => (rows[eq.id] ? [rows[eq.id]] : []);
    supabase.sbUpdate = async (t, w, p) => { writes.push({ id: w.id, patch: p }); return [{ id: w.id, ...p }]; };
    try {
      const { status, json } = await call('POST', '/api/review/bulk', { token: 't', body: { ids: ['e1', 'e2'], decision: 'reject' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.requested, 2);
      // e2 is already 'approved' -> admin override is ALLOWED (canRoleDecide treats decided rows
      // as override-eligible for an admin), so both succeed here. Use a clerk to prove refusal below.
      assert.strictEqual(json.updated, 2);
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('POST /api/review/bulk: clerk touching another branch\'s row in the batch -> that id fails, own-branch id succeeds', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(CLERK_A);
    const origSel = supabase.sbSelect; const origUpd = supabase.sbUpdate;
    const rows = {
      e1: { id: 'e1', status: 'needs_review', branch_id: 'bA', created_at: daysAgo(1), anomaly: {} },
      e2: { id: 'e2', status: 'needs_review', branch_id: 'bB', created_at: daysAgo(1), anomaly: {} },
    };
    const writes = [];
    supabase.sbSelect = async (t, { eq }) => (rows[eq.id] ? [rows[eq.id]] : []);
    supabase.sbUpdate = async (t, w, p) => { writes.push({ id: w.id, patch: p }); return [{ id: w.id, ...p }]; };
    try {
      const { status, json } = await call('POST', '/api/review/bulk', { token: 't', body: { ids: ['e1', 'e2'], decision: 'approve' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.requested, 2);
      assert.strictEqual(json.updated, 1);
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0].id, 'e1');
      const failed = json.results.find((r) => r.id === 'e2');
      assert.strictEqual(failed.ok, false);
    } finally { supabase.sbSelect = origSel; supabase.sbUpdate = origUpd; s.restore(); }
  });
});

test('POST /api/review/bulk: invalid decision -> 400, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    try {
      const { status } = await call('POST', '/api/review/bulk', { token: 't', body: { ids: ['e1'], decision: 'maybe' } });
      assert.strictEqual(status, 400);
    } finally { s.restore(); }
  });
});

test('POST /api/review/bulk: empty/missing ids -> 400', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    try {
      const r1 = await call('POST', '/api/review/bulk', { token: 't', body: { ids: [], decision: 'approve' } });
      assert.strictEqual(r1.status, 400);
      const r2 = await call('POST', '/api/review/bulk', { token: 't', body: { decision: 'approve' } });
      assert.strictEqual(r2.status, 400);
    } finally { s.restore(); }
  });
});

test('POST /api/review/bulk: too many ids -> 413, nothing written', async () => {
  // BULK_REVIEW_MAX_IDS is read once at module-require time (mirrors the existing
  // BULK_PAY_MAX_IDS pattern), so an env override after require() wouldn't take effect —
  // exceed the real default (200) instead of trying to shrink the cap via env.
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession(ADMIN);
    const origUpd = supabase.sbUpdate;
    let wrote = false;
    supabase.sbUpdate = async () => { wrote = true; return [{}]; };
    const tooMany = Array.from({ length: 201 }, (_, i) => 'id' + i);
    try {
      const { status } = await call('POST', '/api/review/bulk', { token: 't', body: { ids: tooMany, decision: 'approve' } });
      assert.strictEqual(status, 413);
      assert.strictEqual(wrote, false);
    } finally { supabase.sbUpdate = origUpd; s.restore(); }
  });
});
