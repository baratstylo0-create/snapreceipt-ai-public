'use strict';
// routes/reports.js Phase 3 (ADR-021): business-mode scoping + master-view grouping. A clerk's
// report is HARD-filtered to their own branch (they can't drill into another via ?branch=); an
// admin can group by branch/staff and drill into any branch. Both the session lookup and the
// expenses fetch go through global.fetch (URLs carry '/rest/v1/'); the test's own probe is
// delegated to the real fetch.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountReports = require('../routes/reports');

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

function stub({ session, expenses = [] }) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt); // the test's HTTP probe
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses')) return { text: async () => JSON.stringify(expenses) };
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; } };
}

async function callReports(query, token) {
  const app = express();
  mountReports(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/reports' + query, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const TWO_BRANCHES = [
  { expense_date: '2026-07-01', amount: 100, category: 'Food', branch_id: 'bA', staff_user_id: 's1' },
  { expense_date: '2026-07-02', amount: 40, category: 'Food', branch_id: 'bA', staff_user_id: 's2' },
  { expense_date: '2026-07-03', amount: 30, category: 'Food', branch_id: 'bB', staff_user_id: 's3' },
];
const TWO_COMPANIES = [
  { expense_date: '2026-07-01', amount: 100, category: 'Food', company_id: 'cA', branch_id: 'bA' },
  { expense_date: '2026-07-02', amount: 40, category: 'Food', company_id: 'cA', branch_id: 'bA' },
  { expense_date: '2026-07-03', amount: 30, category: 'Food', company_id: 'cB', branch_id: 'bB' },
];

test('reports: clerk is hard-scoped to their own branch (cannot see or drill others)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stub({ session: { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() }, expenses: TWO_BRANCHES });
    try {
      // even though the clerk asks for branch bB, scope forces bA
      const { status, body } = await callReports('?period=month&branch=bB', 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.total, 140, 'only branch bA rows (100+40), branch bB excluded');
    } finally { s.restore(); }
  });
});

test('reports: admin groupBy=branch returns per-branch groups that sum to the total', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stub({ session: { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() }, expenses: TWO_BRANCHES });
    try {
      const { status, body } = await callReports('?period=month&groupBy=branch', 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.total, 170);
      const byKey = Object.fromEntries(body.groups.map((g) => [g.key, g.total]));
      assert.deepStrictEqual(byKey, { bA: 140, bB: 30 });
      assert.strictEqual(body.groups.reduce((sum, g) => sum + g.total, 0), body.total);
    } finally { s.restore(); }
  });
});

test('reports: admin groupBy=company returns per-company groups that sum to the total (ADR-023)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stub({ session: { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() }, expenses: TWO_COMPANIES });
    try {
      const { status, body } = await callReports('?period=month&groupBy=company', 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.total, 170);
      const byKey = Object.fromEntries(body.groups.map((g) => [g.key, g.total]));
      assert.deepStrictEqual(byKey, { cA: 140, cB: 30 });
    } finally { s.restore(); }
  });
});

test('reports: admin can drill into a specific company via ?company=', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stub({ session: { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() }, expenses: TWO_COMPANIES });
    try {
      const { body } = await callReports('?period=month&company=cB', 'tok');
      assert.strictEqual(body.total, 30, 'only company cB');
    } finally { s.restore(); }
  });
});

test('reports: admin can drill into a specific branch via ?branch=', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stub({ session: { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() }, expenses: TWO_BRANCHES });
    try {
      const { body } = await callReports('?period=month&branch=bB', 'tok');
      assert.strictEqual(body.total, 30, 'only branch bB');
    } finally { s.restore(); }
  });
});
