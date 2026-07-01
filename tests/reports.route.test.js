'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');     // shared module object — stub its sbSelect
const mountReports = require('../routes/reports');
const { REPORT_ROW_LIMIT } = mountReports;

async function callReports(query = '') {
  const app = express();
  mountReports(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/reports' + query);
    return { status: r.status, body: await r.json() };
  } finally { server.close(); }
}

test('route: excludes rejected expenses from the query (status=neq.rejected)', async () => {
  // #5's admin review queue can set status='rejected' on a bad/duplicate expense.
  // It isn't soft-deleted, so it must be excluded at the query level or it silently
  // inflates money totals.
  const orig = supabase.sbSelect;
  let capturedOpts;
  supabase.sbSelect = async (table, opts) => { capturedOpts = opts; return []; };
  try {
    await callReports('?period=month');
    assert.match(capturedOpts.extra, /status=neq\.rejected/);
  } finally { supabase.sbSelect = orig; }
});

test('route: normal result → truncated:false + fetched_count', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => ([
    { expense_date: '2026-06-01', amount: 10, category: 'Food' },
    { expense_date: '2026-07-01', amount: 5, category: 'Food' },
  ]);
  try {
    const { status, body } = await callReports('?period=month');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.truncated, false);
    assert.strictEqual(body.fetched_count, 2);
    assert.strictEqual(body.total, 15);
  } finally { supabase.sbSelect = orig; }
});

test('route: at the row limit → truncated:true (money report never silently undercounts)', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => Array.from({ length: REPORT_ROW_LIMIT }, () => ({
    expense_date: '2026-06-01', amount: 1, category: 'Food',
  }));
  try {
    const { body } = await callReports('?period=month');
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(body.fetched_count, REPORT_ROW_LIMIT);
  } finally { supabase.sbSelect = orig; }
});

test('route: DB error → graceful 502, no crash, no internal leak', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('db down secret detail'); };
  try {
    const { status, body } = await callReports('?period=month');
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body, { error: 'report failed' });
  } finally { supabase.sbSelect = orig; }
});
