'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');       // shared module object — stub its sbSelect
const mountMetrics = require('../routes/metrics');
const { METRICS_ROW_LIMIT } = mountMetrics;

async function callMetrics(query = '') {
  const app = express();
  mountMetrics(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/metrics' + query);
    return { status: r.status, body: await r.json() };
  } finally { server.close(); }
}

// sbSelect is called twice (expenses, then category_corrections). Route helper to stub both.
function stubSelect(handlers) {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async (table, opts) => handlers(table, opts);
  return () => { supabase.sbSelect = orig; };
}

test('route: window is built on created_at (throughput), not expense_date', async () => {
  let expensesOpts;
  const restore = stubSelect((table, opts) => {
    if (table === 'expenses') { expensesOpts = opts; return []; }
    return []; // corrections
  });
  try {
    await callMetrics('?from=2026-07-01&to=2026-07-31');
    assert.match(expensesOpts.extra, /created_at=gte\.2026-07-01/);
    assert.match(expensesOpts.extra, /created_at=lte\.2026-07-31/);
    assert.match(expensesOpts.extra, /deleted_at=is\.null/);
  } finally { restore(); }
});

test('route: bad date params are ignored (no injection into the filter)', async () => {
  let expensesOpts;
  const restore = stubSelect((table, opts) => { if (table === 'expenses') expensesOpts = opts; return []; });
  try {
    await callMetrics('?from=not-a-date&to=' + encodeURIComponent('2026-07-01;drop'));
    assert.doesNotMatch(expensesOpts.extra, /not-a-date/);
    assert.doesNotMatch(expensesOpts.extra, /drop/);
  } finally { restore(); }
});

test('route: normal result → 200 with metrics shape + fetched_count/truncated', async () => {
  const restore = stubSelect((table) => {
    if (table === 'expenses') return [
      { status: 'saved', confidence: { amount: 'high' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', deleted_at: null },
      { status: 'needs_review', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', deleted_at: null },
    ];
    return [{ category: 'Food', hit_count: 4 }];
  });
  try {
    const { status, body } = await callMetrics('?from=2026-07-01&to=2026-07-31');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.client.receiptsProcessed, 2);
    assert.strictEqual(body.client.noEditCount, 1);
    assert.deepStrictEqual(body.internal.mostCorrectedCategories, [{ category: 'Food', count: 4 }]);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.fetched_count, 2);
  } finally { restore(); }
});

test('route: corrections fetch failure degrades gracefully (still 200, empty list)', async () => {
  const restore = stubSelect((table) => {
    if (table === 'expenses') return [{ status: 'saved', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', deleted_at: null }];
    throw new Error('corrections table unreachable');
  });
  try {
    const { status, body } = await callMetrics('');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.internal.mostCorrectedCategories, []);
  } finally { restore(); }
});

test('route: at the row limit → truncated:true', async () => {
  const restore = stubSelect((table) => {
    if (table === 'expenses') return Array.from({ length: METRICS_ROW_LIMIT }, () => ({
      status: 'saved', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z', deleted_at: null,
    }));
    return [];
  });
  try {
    const { body } = await callMetrics('');
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(body.fetched_count, METRICS_ROW_LIMIT);
  } finally { restore(); }
});

test('route: DB error on expenses → graceful 502, no internal leak', async () => {
  const restore = stubSelect((table) => { if (table === 'expenses') throw new Error('boom'); return []; });
  try {
    const { status, body } = await callMetrics('');
    assert.strictEqual(status, 502);
    assert.strictEqual(body.error, 'metrics failed');
    assert.doesNotMatch(JSON.stringify(body), /boom/);
  } finally { restore(); }
});
