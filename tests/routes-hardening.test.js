'use strict';
// P6 hardening (§4.4 rate limiting, §4.5 CORS) — proves lib/ratelimit.js is WIRED into
// a co-developer's routes (not a re-test of the limiter itself; that's tests/ratelimit.test.js)
// and that Access-Control-Allow-Origin reflects DASHBOARD_ORIGIN when set.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');

function post(app, path, body, headers = {}) {
  return withServer(app, (base) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
  }));
}
function get(app, path, headers = {}) {
  return withServer(app, (base) => fetch(base + path, { headers }));
}
async function withServer(app, fn) {
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { const r = await fn(base); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; }
  finally { srv.close(); }
}

test('POST /api/agent is rate limited: past its configured max -> 429', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  const savedMax = process.env.AGENT_RATE_MAX;
  cfg.DASHBOARD_TOKEN = '';
  process.env.AGENT_RATE_MAX = '2';
  try {
    delete require.cache[require.resolve('../routes/agent')];
    const mountAgent = require('../routes/agent');
    const app = express();
    mountAgent(app, { runAgent: async () => ({ answer: 'ok', toolCalls: [] }) });
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await post(app, '/api/agent', body)).status);
    assert.ok(results.includes(429), 'expected at least one 429 once the limit is exceeded: ' + results);
  } finally {
    cfg.DASHBOARD_TOKEN = savedToken;
    if (savedMax === undefined) delete process.env.AGENT_RATE_MAX; else process.env.AGENT_RATE_MAX = savedMax;
    delete require.cache[require.resolve('../routes/agent')];
  }
});

test('POST /api/upload is rate limited: past its configured max -> 429', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  const savedMax = process.env.UPLOAD_RATE_MAX;
  cfg.DASHBOARD_TOKEN = '';
  process.env.UPLOAD_RATE_MAX = '2';
  try {
    delete require.cache[require.resolve('../routes/upload')];
    const mountUpload = require('../routes/upload');
    const app = express();
    mountUpload(app, {
      runBatch: async () => ({ images: 1, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }),
      extractReceipts: async () => ({ receipts: [], truncated: false }),
      assembleExpense: async () => ({ expense: {}, flagged: false }),
      getFieldSpec: async () => ({ columns: [] }),
    });
    const b64 = Buffer.from('x').toString('base64');
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await post(app, '/api/upload', { images: [b64] })).status);
    assert.ok(results.includes(429), 'expected at least one 429: ' + results);
  } finally {
    cfg.DASHBOARD_TOKEN = savedToken;
    if (savedMax === undefined) delete process.env.UPLOAD_RATE_MAX; else process.env.UPLOAD_RATE_MAX = savedMax;
    delete require.cache[require.resolve('../routes/upload')];
  }
});

test('CORS: Access-Control-Allow-Origin reflects DASHBOARD_ORIGIN when set (expenses route)', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  const savedOrigin = process.env.DASHBOARD_ORIGIN;
  cfg.DASHBOARD_TOKEN = '';
  process.env.DASHBOARD_ORIGIN = 'https://dash.example.com';
  try {
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../routes/expenses')];
    const { cfg: freshCfg } = require('../lib/config');
    freshCfg.DASHBOARD_TOKEN = '';
    const mountExpenses = require('../routes/expenses');
    const supabase = require('../lib/supabase');
    const origSel = supabase.sbSelect;
    supabase.sbSelect = async () => [];
    const app = express();
    mountExpenses(app);
    const { headers } = await get(app, '/api/expenses');
    assert.strictEqual(headers.get('access-control-allow-origin'), 'https://dash.example.com');
    supabase.sbSelect = origSel;
  } finally {
    cfg.DASHBOARD_TOKEN = savedToken;
    if (savedOrigin === undefined) delete process.env.DASHBOARD_ORIGIN; else process.env.DASHBOARD_ORIGIN = savedOrigin;
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../routes/expenses')];
    require('../lib/config'); // restore a fresh cfg for subsequent test files
  }
});

test('CORS: Access-Control-Allow-Origin falls back to * when DASHBOARD_ORIGIN is unset (dev-permissive)', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  const savedOrigin = process.env.DASHBOARD_ORIGIN;
  cfg.DASHBOARD_TOKEN = '';
  delete process.env.DASHBOARD_ORIGIN;
  try {
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../routes/expenses')];
    const { cfg: freshCfg } = require('../lib/config');
    freshCfg.DASHBOARD_TOKEN = '';
    const mountExpenses = require('../routes/expenses');
    const supabase = require('../lib/supabase');
    const origSel = supabase.sbSelect;
    supabase.sbSelect = async () => [];
    const app = express();
    mountExpenses(app);
    const { headers } = await get(app, '/api/expenses');
    assert.strictEqual(headers.get('access-control-allow-origin'), '*');
    supabase.sbSelect = origSel;
  } finally {
    cfg.DASHBOARD_TOKEN = savedToken;
    if (savedOrigin === undefined) delete process.env.DASHBOARD_ORIGIN; else process.env.DASHBOARD_ORIGIN = savedOrigin;
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../routes/expenses')];
    require('../lib/config');
  }
});
