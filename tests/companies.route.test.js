'use strict';
// routes/companies.js (ADR-023 Phase 8): admin company CRUD for the Group→Company→Branch→Staff
// dimension, flag-gated by capabilities.multiUser AND capabilities.companyDimension, role-guarded
// via req.scope (the scopeForUser bouncer), rate-limited (SEC-7). Supabase REST is stubbed at
// global.fetch (URLs carry '/rest/v1/'); the test's own probe to the Express server uses real fetch.
// Mirrors tests/branches.route.test.js exactly.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountCompanies = require('../routes/companies');

function app() {
  const a = express();
  mountCompanies(a);
  return a;
}

async function req(a, method, path, { token, body } = {}) {
  const srv = a.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
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

// Stub Supabase. `session` seeds the checkDash session lookup (→ req.scope). `handlers` maps
// '<table>:<METHOD>' → fn returning rows. Anything without '/rest/v1/' is the test's own probe.
function stubDb({ session, handlers = {} } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt); // the test's HTTP probe
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (table === 'sessions' && method === 'GET') return { text: async () => JSON.stringify(session ? [session] : []) };
    const key = table + ':' + method;
    if (handlers[key]) return { text: async () => JSON.stringify(handlers[key]({ url: u, body })) };
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{}]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}

const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', company_id: 'cA', expires_at: future() };
const ON = { CAP_MULTI_USER: 'true', CAP_COMPANY_DIMENSION: 'true' };

test('companies: multiUser OFF -> 404 (personal product has no companies)', async () => {
  await withEnv({ CAP_MULTI_USER: 'false', CAP_COMPANY_DIMENSION: 'true', ACCOUNT_TYPE: 'personal' }, async () => {
    const { status } = await req(app(), 'GET', '/api/companies');
    assert.strictEqual(status, 404);
  });
});

test('companies: companyDimension OFF -> 404 (gate requires the dimension flag too)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true', CAP_COMPANY_DIMENSION: 'false' }, async () => {
    const { status } = await req(app(), 'GET', '/api/companies');
    assert.strictEqual(status, 404);
  });
});

test('companies: no session -> 401', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: null });
    try {
      const { status } = await req(app(), 'GET', '/api/companies', { token: 'nope' });
      assert.strictEqual(status, 401);
    } finally { stub.restore(); }
  });
});

test('companies: admin GET lists active companies', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'companies:GET': () => [{ id: 'cA', name: 'Premala Sdn Bhd', active: true }] } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/companies', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.companies[0].name, 'Premala Sdn Bhd');
    } finally { stub.restore(); }
  });
});

test('companies: admin POST creates a company (name in the insert)', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status, json } = await req(app(), 'POST', '/api/companies', { token: 't', body: { name: 'Premala Sdn Bhd', currency: 'MYR' } });
      assert.strictEqual(status, 201);
      assert.strictEqual(json.company.name, 'Premala Sdn Bhd');
      const post = stub.calls.find((c) => c.method === 'POST' && /\/companies/.test(c.url));
      assert.strictEqual(post.body.name, 'Premala Sdn Bhd');
      assert.strictEqual(post.body.currency, 'MYR');
    } finally { stub.restore(); }
  });
});

test('companies: admin POST without a name -> 400', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN });
    try {
      const { status } = await req(app(), 'POST', '/api/companies', { token: 't', body: { currency: 'MYR' } });
      assert.strictEqual(status, 400);
      assert.strictEqual(stub.calls.some((c) => c.method === 'POST' && /\/companies/.test(c.url)), false, 'no write on a bad request');
    } finally { stub.restore(); }
  });
});

test('companies: clerk POST -> 403; clerk DELETE -> 403 (CRUD is admin-only)', async () => {
  await withEnv(ON, async () => {
    let stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'POST', '/api/companies', { token: 't', body: { name: 'X' } });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }

    stub = stubDb({ session: CLERK_A });
    try {
      const { status } = await req(app(), 'DELETE', '/api/companies/cA', { token: 't' });
      assert.strictEqual(status, 403);
    } finally { stub.restore(); }
  });
});

test('companies: admin DELETE soft-deletes when the company has no active branches', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'branches:GET': () => [] } });
    try {
      const { status, json } = await req(app(), 'DELETE', '/api/companies/cA', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.ok, true);
      assert.ok(stub.calls.some((c) => c.method === 'PATCH' && /\/companies\?/.test(c.url) && c.body.active === false), 'soft-delete flips active=false');
    } finally { stub.restore(); }
  });
});

test('companies: admin DELETE refused (409) while active branches remain', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: ADMIN, handlers: { 'branches:GET': () => [{ id: 'b1', company_id: 'cA', active: true }] } });
    try {
      const { status } = await req(app(), 'DELETE', '/api/companies/cA', { token: 't' });
      assert.strictEqual(status, 409);
      assert.strictEqual(stub.calls.some((c) => c.method === 'PATCH' && /\/companies\?/.test(c.url)), false, 'no soft-delete while branches are attached');
    } finally { stub.restore(); }
  });
});

test('companies: clerk GET is filtered to their own company', async () => {
  await withEnv(ON, async () => {
    const stub = stubDb({ session: CLERK_A, handlers: { 'companies:GET': ({ url }) => {
      // the route must scope the query to the clerk's own company id (cA)
      assert.match(url, /id=eq\.cA/, 'clerk company GET is hard-filtered to their own company');
      return [{ id: 'cA', name: 'Premala Sdn Bhd', active: true }];
    } } });
    try {
      const { status, json } = await req(app(), 'GET', '/api/companies', { token: 't' });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.companies.length, 1);
      assert.strictEqual(json.companies[0].id, 'cA');
    } finally { stub.restore(); }
  });
});
