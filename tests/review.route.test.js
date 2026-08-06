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
  supabase.sbSelect = async () => ([{ id: 'e1', status: 'needs_review', anomaly: { reasons: [{ type: 'outlier' }] } }]);
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
  supabase.sbSelect = async () => ([{ id: 'e2', status: 'needs_review' }]);
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
  supabase.sbSelect = async () => ([{ id: 'e4', status: 'needs_review' }]);
  supabase.sbUpdate = async () => { throw new Error('db down'); };
  try {
    const { status, body } = await call('POST', '/api/review/e4', { decision: 'approve' });
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body, { error: 'review update failed' });
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

// --- status-machine integrity regression tests (QA §4.8) ---

test('POST on an already-rejected expense -> 409, no re-decision (no DB write)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e5', status: 'rejected' }]);
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status, body } = await call('POST', '/api/review/e5', { decision: 'approve' });
    assert.strictEqual(status, 409);
    assert.match(body.error, /not pending review/);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST on a never-flagged saved expense -> 409 (cannot jump straight to approved)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([{ id: 'e6', status: 'saved' }]);
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status } = await call('POST', '/api/review/e6', { decision: 'approve' });
    assert.strictEqual(status, 409);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('POST on a nonexistent id -> 404 (not a fabricated 200)', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  supabase.sbSelect = async () => ([]); // not found
  supabase.sbUpdate = async () => { throw new Error('must not write'); };
  try {
    const { status, body } = await call('POST', '/api/review/nope', { decision: 'approve' });
    assert.strictEqual(status, 404);
    assert.match(body.error, /not found/);
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});

test('pre-existing anomaly as an array does not silently drop the audit record', async () => {
  const os = supabase.sbSelect, ou = supabase.sbUpdate;
  let patch = null;
  supabase.sbSelect = async () => ([{ id: 'e7', status: 'needs_review', anomaly: [] }]); // array, not object
  supabase.sbUpdate = async (t, sel, p) => { patch = p; return [{ id: 'e7', ...p }]; };
  try {
    const { status } = await call('POST', '/api/review/e7', { decision: 'reject', note: 'n' });
    assert.strictEqual(status, 200);
    assert.strictEqual(Array.isArray(patch.anomaly), false);
    assert.strictEqual(patch.anomaly.review.decision, 'reject'); // audit survives serialization
  } finally { supabase.sbSelect = os; supabase.sbUpdate = ou; }
});
