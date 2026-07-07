'use strict';
// Issue #131 — req.scope threaded into the branch-partitioned sb* calls so a clerk's
// reads/writes are FILTERED/STAMPED by branch_id at the DB layer (defense-in-depth behind
// the existing in-memory clerkVisible/canTouchExpense guards). This asserts the wiring at the
// DB-URL level: a clerk session must produce a `/rest/v1/<table>?...branch_id=eq.<their branch>`
// query; an admin must NOT (sees all branches); personal mode (no multiUser) is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const mountExpenses = require('../routes/expenses');
const mountReports = require('../routes/reports');
const mountExcel = require('../routes/excel');
const mountReview = require('../routes/review');
const mountStatement = require('../routes/statement');
const mountSubmissions = require('../routes/submissions');

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

// Capture every PostgREST call; seed the session lookup. Returns { calls, restore }.
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

async function hit(mount, method, path, { token, body, deps } = {}) {
  const app = express();
  deps ? mount(app, deps) : mount(app);
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
const CLERK = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };

// helper: the FIRST request URL that hits <table> with <method>
const urlFor = (calls, table, method = 'GET') =>
  (calls.find((c) => c.method === method && new RegExp('/rest/v1/' + table + '\\b').test(c.url)) || {}).url || '';

// ---- routes/expenses.js -------------------------------------------------------

test('GET /api/expenses: clerk session filters the expenses query by branch_id at the DB layer', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [] } });
    try {
      await hit(mountExpenses, 'GET', '/api/expenses', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=eq\.bA/, 'clerk expenses read must be branch-filtered');
    } finally { stub.restore(); }
  });
});

test('GET /api/expenses: admin session applies NO branch filter (sees all branches)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'expenses:GET': () => [] } });
    try {
      await hit(mountExpenses, 'GET', '/api/expenses', { token: 't' });
      assert.doesNotMatch(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=/, 'admin sees all branches');
    } finally { stub.restore(); }
  });
});

test('GET /api/expenses: personal mode (no multiUser) is unchanged — no branch filter', async () => {
  const stub = stubDb({ handlers: { 'expenses:GET': () => [] } });
  try {
    await hit(mountExpenses, 'GET', '/api/expenses');
    assert.doesNotMatch(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=/);
  } finally { stub.restore(); }
});

test('PATCH /api/expenses/:id: clerk write is branch-filtered (cannot patch another branch)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [{ id: 'e1', branch_id: 'bA' }] } });
    try {
      await hit(mountExpenses, 'PATCH', '/api/expenses/e1', { token: 't', body: { category: 'Food' } });
      assert.match(urlFor(stub.calls, 'expenses', 'PATCH'), /branch_id=eq\.bA/, 'clerk PATCH must carry the branch filter');
    } finally { stub.restore(); }
  });
});

test('DELETE /api/expenses/:id: clerk soft-delete is branch-filtered', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [{ id: 'e1', branch_id: 'bA' }] } });
    try {
      await hit(mountExpenses, 'DELETE', '/api/expenses/e1', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'PATCH'), /branch_id=eq\.bA/, 'soft-delete is a PATCH; must carry the branch filter');
    } finally { stub.restore(); }
  });
});

// ---- routes/reports.js + routes/excel.js (expense reads) ----------------------

test('GET /api/reports: clerk expenses read is branch-filtered at the DB layer', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [] } });
    try {
      await hit(mountReports, 'GET', '/api/reports?period=month', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=eq\.bA/);
    } finally { stub.restore(); }
  });
});

test('GET /api/excel: clerk export is branch-filtered at the DB layer (was NOT before)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [] } });
    try {
      await hit(mountExcel, 'GET', '/api/excel', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=eq\.bA/);
    } finally { stub.restore(); }
  });
});

// ---- routes/review.js ---------------------------------------------------------

test('GET /api/review: clerk queue is branch-filtered at the DB layer', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'expenses:GET': () => [] } });
    try {
      await hit(mountReview, 'GET', '/api/review', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=eq\.bA/);
    } finally { stub.restore(); }
  });
});

// ---- routes/statement.js (petty_cash_floats / cash_in / expenses reads) -------

test('GET /api/statement: clerk reads are branch-filtered (belt-and-suspenders on the forced branch)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_PETTY_CASH: 'true' }, async () => {
    const stub = stubDb({ session: CLERK });
    try {
      await hit(mountStatement, 'GET', '/api/statement?period=2026-07&format=xlsx', { token: 't' });
      assert.match(urlFor(stub.calls, 'expenses', 'GET'), /branch_id=eq\.bA/);
      assert.match(urlFor(stub.calls, 'petty_cash_floats', 'GET'), /branch_id=eq\.bA/);
      assert.match(urlFor(stub.calls, 'cash_in', 'GET'), /branch_id=eq\.bA/);
    } finally { stub.restore(); }
  });
});

// ---- routes/submissions.js ----------------------------------------------------

test('GET /api/submissions: clerk is branch-filtered at the DB layer', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_BRANCH_SUBMISSION: 'true' }, async () => {
    const stub = stubDb({ session: CLERK, handlers: { 'submissions:GET': () => [] } });
    try {
      await hit(mountSubmissions, 'GET', '/api/submissions', { token: 't' });
      assert.match(urlFor(stub.calls, 'submissions', 'GET'), /branch_id=eq\.bA/);
    } finally { stub.restore(); }
  });
});
