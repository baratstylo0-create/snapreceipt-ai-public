'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountTemplates = require('../routes/templates');

// Spin up the route on an ephemeral port and hit it with real fetch (same shape
// as tests/smoke.test.js). Supabase calls (getFieldSpec/saveTemplate -> REST) are
// stubbed by URL so no network happens — but the test's OWN request to 127.0.0.1
// must pass through to the real server, so we only intercept non-local URLs.
function withServer(supabaseHandler, run) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
      return realFetch(url, opt); // the test's request to our own express app
    }
    return supabaseHandler(u, opt); // intercept Supabase REST
  };
  const app = express();
  mountTemplates(app);
  const server = app.listen(0);
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  return Promise.resolve(run(base))
    .finally(() => { server.close(); global.fetch = realFetch; });
}

// Supabase REST stub: GET field_templates -> [] (no stored template),
// POST/PATCH -> minimal empty body. hreq JSON-parses the text.
function emptyDb(_u, opt) {
  const method = (opt && opt.method) || 'GET';
  const body = method === 'GET' ? '[]' : '';
  return { text: async () => body };
}

test('GET /api/templates returns the DEFAULT FieldSpec when none stored', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates');
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.strictEqual(spec.updated_at, null);
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount', 'currency', 'category']);
  });
});

test('POST /api/templates with a text/csv body parses + stores + returns the FieldSpec', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Vendor,Purchase Date,Grand Total,GST',
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount', 'tax']);
    assert.strictEqual(spec.columns[0].label, 'Vendor'); // exact customer header preserved
  });
});

test('POST /api/templates accepts a JSON body { csv }', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount' }),
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount']);
  });
});

test('POST /api/templates rejects an empty body with 400 (no DB write attempted)', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: '   ',
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /provide CSV/i);
  });
});

test('POST /api/templates returns 400 (not 500) on an all-blank-header CSV', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: ',,,\nx,y,z',
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /parseTemplate/);
  });
});
