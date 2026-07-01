'use strict';
// #5 admin review route — stubs the supabase module object (namespace import enables this).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const mountReview = require('../routes/review');

async function call(method, path, body) {
  const app = express();
  mountReview(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, body
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  } finally { server.close(); }
}

test('GET /api/review lists needs_review expenses', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async (table, { eq } = {}) => {
    assert.strictEqual(eq.status, 'needs_review');
    return [{ id: 'e1', merchant: 'Shop', status: 'needs_review' }];
  };
  try {
    const { status, body } = await call('GET', '/api/review');
    assert.strictEqual(status, 200);
    assert.strictEqual(body[0].id, 'e1');
  } finally { supabase.sbSelect = orig; }
});

test('POST approve -> status approved + audit in anomaly', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  let patch = null;
  supabase.sbSelect = async () => ([{ id: 'e1', anomaly: { reasons: [{ type: 'outlier' }] } }]);
  supabase.sbUpdate = async (t, sel, p) => { patch = p; return [{ id: 'e1', ...p }]; };
  try {
    const { status, body } = await call('POST', '/api/review/e1', { decision: 'approve' });
    assert.strictEqual(status, 200);
    assert.strictEqual(patch.status, 'approved');
    assert.strictEqual(patch.anomaly.review.decision, 'approve');
    assert.strictEqual(body.status, 'approved');
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST reject -> status rejected + note recorded', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  let patch = null;
  supabase.sbSelect = async () => ([{ id: 'e2' }]);
  supabase.sbUpdate = async (t, sel, p) => { patch = p; return [{ id: 'e2', ...p }]; };
  try {
    const { status } = await call('POST', '/api/review/e2', { decision: 'reject', note: 'not a business expense' });
    assert.strictEqual(status, 200);
    assert.strictEqual(patch.status, 'rejected');
    assert.strictEqual(patch.anomaly.review.note, 'not a business expense');
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST invalid decision -> 400 (no DB write)', async () => {
  const ou = supabase.sbUpdate;
  supabase.sbUpdate = async () => { throw new Error('should not be called'); };
  try {
    const { status, body } = await call('POST', '/api/review/e3', { decision: 'maybe' });
    assert.strictEqual(status, 400);
    assert.match(body.error, /approve.*reject/);
  } finally { supabase.sbUpdate = ou; }
});

test('POST DB error -> 502', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e4' }]);
  supabase.sbUpdate = async () => { throw new Error('db down'); };
  try {
    const { status, body } = await call('POST', '/api/review/e4', { decision: 'approve' });
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body, { error: 'review update failed' });
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});
