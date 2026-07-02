'use strict';
// QA pass (adversarial) — GAPS in routes/review.js beyond review.route.test.js:
// checkDash auth enforcement (DASHBOARD_TOKEN set), GET DB-error 502, malformed
// bodies, inject-ish ids, and no stack/secret leak on error.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const { cfg } = require('../lib/config');
const mountReview = require('../routes/review');

async function call(method, path, { body, headers } = {}) {
  const app = express();
  mountReview(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const opts = { method, headers: { ...(headers || {}) } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const r = await fetch('http://127.0.0.1:' + port + path, opts);
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed, rawText: text };
  } finally { server.close(); }
}

// --- AUTH (checkDash): enforced only when DASHBOARD_TOKEN is set ---

test('AUTH: GET /api/review with NO key -> 401 when DASHBOARD_TOKEN set', async () => {
  const orig = cfg.DASHBOARD_TOKEN; cfg.DASHBOARD_TOKEN = 'secret-tok';
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('must not query when unauthorized'); };
  try {
    const { status, body } = await call('GET', '/api/review');
    assert.strictEqual(status, 401);
    assert.deepStrictEqual(body, { error: 'unauthorized' });
  } finally { cfg.DASHBOARD_TOKEN = orig; supabase.sbSelect = os; }
});

test('AUTH: wrong header -> 401; ?key= (even correct) -> 401; correct Bearer header -> 200', async () => {
  const orig = cfg.DASHBOARD_TOKEN; cfg.DASHBOARD_TOKEN = 'secret-tok';
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review' }]);
  try {
    const bad = await call('GET', '/api/review', { headers: { Authorization: 'Bearer nope' } });
    assert.strictEqual(bad.status, 401);
    // ?key= was dropped (Task J F2) — a correct token in the query no longer authorizes.
    const query = await call('GET', '/api/review?key=secret-tok');
    assert.strictEqual(query.status, 401);
    const goodHdr = await call('GET', '/api/review', { headers: { Authorization: 'Bearer secret-tok' } });
    assert.strictEqual(goodHdr.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = orig; supabase.sbSelect = os; }
});

test('AUTH: POST decision with NO key -> 401, no DB write', async () => {
  const orig = cfg.DASHBOARD_TOKEN; cfg.DASHBOARD_TOKEN = 'secret-tok';
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => { throw new Error('must not read'); };
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status } = await call('POST', '/api/review/e1', { body: { decision: 'approve' } });
    assert.strictEqual(status, 401);
  } finally { cfg.DASHBOARD_TOKEN = orig; supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('AUTH: with NO token configured, endpoints are open (no 401)', async () => {
  const orig = cfg.DASHBOARD_TOKEN; cfg.DASHBOARD_TOKEN = '';
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => ([]);
  try {
    const { status } = await call('GET', '/api/review');
    assert.strictEqual(status, 200);
  } finally { cfg.DASHBOARD_TOKEN = orig; supabase.sbSelect = os; }
});

// --- GET DB error -> 502 JSON, no stack leak ---

test('GET /api/review DB error -> 502 JSON, error text carries no stack/secret', async () => {
  const os = supabase.sbSelect;
  supabase.sbSelect = async () => { const e = new Error('postgres://user:pw@host connection refused at line 42'); throw e; };
  try {
    const { status, body, rawText } = await call('GET', '/api/review');
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body, { error: 'review load failed' });
    assert.ok(!/postgres:\/\/|connection refused|line 42|at Object|\.js:/.test(rawText), 'no internals leaked: ' + rawText);
  } finally { supabase.sbSelect = os; }
});

// --- Malformed bodies ---

test('POST with non-JSON body -> handled (400 range), no 5xx crash', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review' }]);
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status } = await call('POST', '/api/review/e1', { body: '{not valid json' });
    assert.ok(status >= 400 && status < 500, 'expected 4xx for malformed JSON, got ' + status);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST with empty body -> 400 (decision required)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review' }]);
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status, body } = await call('POST', '/api/review/e1', { body: {} });
    assert.strictEqual(status, 400);
    assert.match(body.error, /approve.*reject/);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST with decision as an object (type confusion) -> 400, no write', async () => {
  const ou = supabase.sbUpdate;
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status } = await call('POST', '/api/review/e1', { body: { decision: { approve: true } } });
    assert.strictEqual(status, 400);
  } finally { supabase.sbUpdate = ou; }
});

// --- Inject-ish / weird ids ---

test('POST with SQL-ish id is passed as a value to sbSelect eq (parameterised), not concatenated', async () => {
  let seenSel = null;
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async (t, o) => { seenSel = o; return []; }; // not found
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const injectId = "1' OR '1'='1";
    const { status } = await call('POST', '/api/review/' + encodeURIComponent(injectId), { body: { decision: 'approve' } });
    assert.strictEqual(status, 404); // treated as a literal id that doesn't exist
    assert.strictEqual(seenSel.eq.id, injectId); // exact value handed to the query layer, unescaped-into-SQL
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST decision DB error surfaces 502 with generic message (no stack leak)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review' }]);
  supabase.sbUpdate = async () => { throw new Error('SB_KEY=sk_live_secret leaked; at /srv/app/lib/x.js:9'); };
  try {
    const { status, body, rawText } = await call('POST', '/api/review/e1', { body: { decision: 'approve' } });
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body, { error: 'review update failed' });
    assert.ok(!/SB_KEY|sk_live|\.js:/.test(rawText), 'no secret/stack leaked: ' + rawText);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST note is coerced+truncated to 500 chars (no unbounded storage)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  let patch = null;
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review' }]);
  supabase.sbUpdate = async (t, s, p) => { patch = p; return [{ id: 'e1', ...p }]; };
  try {
    const { status } = await call('POST', '/api/review/e1', { body: { decision: 'reject', note: 'x'.repeat(5000) } });
    assert.strictEqual(status, 200);
    assert.strictEqual(patch.anomaly.review.note.length, 500);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});
