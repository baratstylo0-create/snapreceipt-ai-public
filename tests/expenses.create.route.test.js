'use strict';
// routes/expenses.js — POST /api/expenses (QA 2026-07-14, Untitled document (2).md): "Enter
// manually" on the Upload page needs a way to CREATE a brand-new expense with no OCR/photo.
// No such endpoint existed before this (only PATCH an existing row) — this is genuinely new
// write surface, so it gets the same rigor as the PATCH endpoint: checkDash auth, a rate
// limiter, and server-side validation (reusing sanitizeExpensePatch, not reimplemented) plus
// its own required-field floor (merchant/date/amount/category all mandatory — a manual entry
// has no OCR to guess a category, so Owner directive: category must be a deliberate pick).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountExpenses = require('../routes/expenses');

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

function stubDb({ session, insertRow } = {}) {
  const realFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    const method = opt.method || 'GET';
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    if (u.includes('/expenses') && method === 'POST') {
      const body = opt.body ? JSON.parse(opt.body) : {};
      writes.push({ url: u, method, body });
      const row = insertRow ? insertRow(body) : { id: 'new-1', voucher_no: 'RC-2026-0099', ...body };
      return { text: async () => JSON.stringify([row]) };
    }
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; }, writes };
}

async function call(method, path, { token, body } = {}) {
  const app = express();
  mountExpenses(app);
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
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', company_id: 'co-1', expires_at: future() };
const ADMIN = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: 'bHQ', expires_at: future() };

const VALID_BODY = { merchant: 'Office Depot', expense_date: '2026-07-14', amount: 45.9, category: 'Office Supplies' };

// --- personal mode (no session gate) ------------------------------------------------------

test('POST /api/expenses: personal mode (no DASHBOARD_TOKEN) — creates the row, no branch stamp', async () => {
  await withEnv({ DASHBOARD_TOKEN: '', AUTH_REQUIRED: 'false' }, async () => {
    const s = stubDb({});
    try {
      const { status, json } = await call('POST', '/api/expenses', { body: VALID_BODY });
      assert.strictEqual(status, 201);
      assert.strictEqual(s.writes.length, 1);
      assert.strictEqual(s.writes[0].body.merchant, 'Office Depot');
      assert.strictEqual(s.writes[0].body.amount, 45.9);
      assert.strictEqual(s.writes[0].body.category, 'Office Supplies');
      assert.strictEqual('branch_id' in s.writes[0].body, false, 'personal mode never stamps a branch');
      assert.ok(json.merchant, 'echoes the created row');
    } finally { s.restore(); }
  });
});

// --- business mode: auth + branch/company stamping -----------------------------------------

test('POST /api/expenses: business mode — stamps branch_id + company_id from the session', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: CLERK_A });
    try {
      const { status } = await call('POST', '/api/expenses', { token: 't', body: VALID_BODY });
      assert.strictEqual(status, 201);
      assert.strictEqual(s.writes[0].body.branch_id, 'bA');
      assert.strictEqual(s.writes[0].body.company_id, 'co-1');
    } finally { s.restore(); }
  });
});

test('POST /api/expenses: business mode, no session bearer -> 401, nothing written', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: null });
    try {
      const { status } = await call('POST', '/api/expenses', { token: 'ghost', body: VALID_BODY });
      assert.strictEqual(status, 401);
      assert.strictEqual(s.writes.length, 0);
    } finally { s.restore(); }
  });
});

test('POST /api/expenses: admin in business mode also creates fine (no clerk-only restriction)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubDb({ session: ADMIN });
    try {
      const { status } = await call('POST', '/api/expenses', { token: 't', body: VALID_BODY });
      assert.strictEqual(status, 201);
      assert.strictEqual(s.writes[0].body.branch_id, 'bHQ');
    } finally { s.restore(); }
  });
});

// --- required-field floor (merchant/date/amount/category all mandatory) -------------------

test('POST /api/expenses: missing/empty merchant -> 400, nothing written', async () => {
  const s = stubDb({});
  try {
    for (const bad of [undefined, '', '   ', 123, null]) {
      const { status } = await call('POST', '/api/expenses', { body: { ...VALID_BODY, merchant: bad } });
      assert.strictEqual(status, 400, 'merchant=' + JSON.stringify(bad) + ' must be rejected');
    }
    assert.strictEqual(s.writes.length, 0);
  } finally { s.restore(); }
});

test('POST /api/expenses: malformed/missing expense_date -> 400', async () => {
  const s = stubDb({});
  try {
    for (const bad of [undefined, '', '14/07/2026', '2026-13-01', 'not a date']) {
      const { status } = await call('POST', '/api/expenses', { body: { ...VALID_BODY, expense_date: bad } });
      assert.strictEqual(status, 400, 'expense_date=' + JSON.stringify(bad) + ' must be rejected');
    }
  } finally { s.restore(); }
});

test('POST /api/expenses: amount must be a finite number > 0', async () => {
  const s = stubDb({});
  try {
    for (const bad of [undefined, 0, -5, 'abc', null, NaN, Infinity]) {
      const { status } = await call('POST', '/api/expenses', { body: { ...VALID_BODY, amount: bad } });
      assert.strictEqual(status, 400, 'amount=' + JSON.stringify(bad) + ' must be rejected');
    }
  } finally { s.restore(); }
});

test('POST /api/expenses: missing/empty category -> 400 (Owner directive: must be a deliberate pick)', async () => {
  const s = stubDb({});
  try {
    for (const bad of [undefined, '', '   ', 42]) {
      const { status } = await call('POST', '/api/expenses', { body: { ...VALID_BODY, category: bad } });
      assert.strictEqual(status, 400, 'category=' + JSON.stringify(bad) + ' must be rejected');
    }
  } finally { s.restore(); }
});

// --- allow-list still applies (reuses sanitizeExpensePatch, unknown/spoofed fields dropped) -

test('POST /api/expenses: unknown/spoofed fields (account_id, id, voucher_no, branch_id) never survive client input', async () => {
  const s = stubDb({});
  try {
    const { status } = await call('POST', '/api/expenses', {
      body: { ...VALID_BODY, account_id: 'other-tenant', id: 'spoofed-id', voucher_no: 'RC-FAKE', branch_id: 'evil-branch', status: 'approved' },
    });
    assert.strictEqual(status, 201);
    // account_id is ALWAYS server-stamped (stampScope, lib/supabase.js) — the real value, not
    // the client's spoofed one. That's the actual security property: never that the key is
    // absent, but that it can never be attacker-controlled.
    assert.notStrictEqual(s.writes[0].body.account_id, 'other-tenant');
    assert.strictEqual(s.writes[0].body.id, undefined);
    assert.strictEqual(s.writes[0].body.voucher_no, undefined);
    assert.strictEqual(s.writes[0].body.branch_id, undefined, 'personal mode — branch_id never comes from the client body');
  } finally { s.restore(); }
});

test('POST /api/expenses: optional fields (currency, remark) pass through when valid', async () => {
  const s = stubDb({});
  try {
    const { status } = await call('POST', '/api/expenses', {
      body: { ...VALID_BODY, currency: 'MYR', remark: 'reimbursable' },
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(s.writes[0].body.currency, 'MYR');
    assert.strictEqual(s.writes[0].body.remark, 'reimbursable');
  } finally { s.restore(); }
});

test('POST /api/expenses: a saved manual entry status defaults to "saved" (no OCR/anomaly pass)', async () => {
  const s = stubDb({});
  try {
    await call('POST', '/api/expenses', { body: VALID_BODY });
    assert.strictEqual(s.writes[0].body.status, 'saved');
  } finally { s.restore(); }
});

test('POST /api/expenses: DB failure -> 502, no internals leaked', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url);
    throw new Error('ECONNREFUSED 10.0.0.5 internal detail');
  };
  try {
    const { status, json } = await call('POST', '/api/expenses', { body: VALID_BODY });
    assert.strictEqual(status, 502);
    assert.ok(!JSON.stringify(json).includes('10.0.0.5'));
  } finally { global.fetch = realFetch; }
});
