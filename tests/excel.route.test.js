'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');     // shared module object — stub its sbSelect
const templates = require('../lib/templates');   // shared module object — stub its getFieldSpec
const mountExcel = require('../routes/excel');
const { EXCEL_ROW_LIMIT } = mountExcel;

async function callExcel(query = '') {
  const app = express();
  mountExcel(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/excel' + query);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf };
  } finally { server.close(); }
}

const FIELD_SPEC = { columns: [
  { key: 'merchant', label: 'Vendor', type: 'text', required: true },
  { key: 'amount', label: 'Total', type: 'currency', required: true },
] };

test('route: excludes rejected expenses from the query (status=neq.rejected)', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  let capturedOpts;
  supabase.sbSelect = async (table, opts) => { capturedOpts = opts; return []; };
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    await callExcel();
    assert.match(capturedOpts.extra, /status=neq\.rejected/);
    assert.match(capturedOpts.extra, /deleted_at=is\.null/);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: returns a real, parseable .xlsx with the right headers and rows', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([
    { merchant: 'Cafe', amount: 12.5, expense_date: '2026-06-01', status: 'saved', deleted_at: null },
    { merchant: 'Fuel', amount: 40, expense_date: '2026-06-15', status: 'saved', deleted_at: null },
  ]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { status, headers, buf } = await callExcel('?period=month');
    assert.strictEqual(status, 200);
    assert.strictEqual(headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(headers.get('content-disposition'), /attachment; filename="expenses-.*\.xlsx"/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    assert.deepStrictEqual(sheet.getRow(1).values.slice(1), ['Vendor', 'Total']);
    assert.deepStrictEqual(sheet.getRow(2).values.slice(1), ['Cafe', 12.5]);
    assert.deepStrictEqual(sheet.getRow(3).values.slice(1), ['Fuel', 40]);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: from/to filters rows by expense_date, inclusive on both ends', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([
    { merchant: 'A', amount: 1, expense_date: '2026-05-31' },
    { merchant: 'B', amount: 2, expense_date: '2026-06-01' },
    { merchant: 'C', amount: 3, expense_date: '2026-06-30' },
    { merchant: 'D', amount: 4, expense_date: '2026-07-01' },
  ]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { buf } = await callExcel('?from=2026-06-01&to=2026-06-30');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    assert.strictEqual(sheet.rowCount, 3); // header + B + C only
    assert.strictEqual(sheet.getRow(2).getCell(1).value, 'B');
    assert.strictEqual(sheet.getRow(3).getCell(1).value, 'C');
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: an impossible from/to date (2026-13-45) is ignored, not applied as a filter bound', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ merchant: 'A', amount: 1, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { buf } = await callExcel('?from=2026-13-45');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.strictEqual(wb.worksheets[0].rowCount, 2); // header + the one row (filter was ignored, not applied as "always excluded")
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: at the row limit -> X-Truncated header set (money export never silently undercounts)', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => Array.from({ length: EXCEL_ROW_LIMIT }, () => ({
    merchant: 'Cafe', amount: 1, expense_date: '2026-06-01',
  }));
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { headers } = await callExcel();
    assert.strictEqual(headers.get('x-truncated'), 'true');
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: below the row limit -> no X-Truncated header', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ merchant: 'Cafe', amount: 1, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { headers } = await callExcel();
    assert.strictEqual(headers.get('x-truncated'), null);
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});

test('route: DB error -> graceful 502 JSON, no crash, no internal leak', async () => {
  const origSelect = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('db down secret detail'); };
  try {
    const { status, headers, buf } = await callExcel();
    assert.strictEqual(status, 502);
    assert.strictEqual(headers.get('access-control-allow-origin'), '*');
    assert.match(headers.get('content-type'), /json/);
    const body = JSON.parse(buf.toString('utf8'));
    assert.deepStrictEqual(body, { error: 'export failed' });
    assert.ok(!buf.toString('utf8').includes('secret detail'), 'must not leak the real error message');
  } finally { supabase.sbSelect = origSelect; }
});

test('route: an array-valued from param (?from=a&from=b) is safely ignored, not applied or crashed', async () => {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ merchant: 'A', amount: 1, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    // Express parses repeated params into an array; isISO must treat it as invalid -> no bound.
    const { status, buf } = await callExcel('?from=2026-01-01&from=2026-12-31');
    assert.strictEqual(status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.strictEqual(wb.worksheets[0].rowCount, 2); // header + the one row (array bound ignored, not applied)
  } finally { supabase.sbSelect = origSelect; templates.getFieldSpec = origSpec; }
});
