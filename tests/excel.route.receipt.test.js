'use strict';
// routes/excel.js Phase 3 (ADR-018): the export embeds the receipt image for rows with a stored
// receipt_url, fetching bytes from storage at export time and hyperlinking to the authed serve
// route. Not flag-gated — this test runs in the personal product. Storage + supabase + templates
// are namespace-stubbed; no network.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');
const templates = require('../lib/templates');
const storage = require('../lib/storage');
const mountExcel = require('../routes/excel');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const FIELD_SPEC = { columns: [
  { key: 'merchant', label: 'Vendor', type: 'text' },
  { key: 'amount', label: 'Total', type: 'currency' },
] };

async function callExcel() {
  const app = express();
  mountExcel(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/excel');
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { srv.close(); }
}

test('excel: a row with a stored receipt gets a Receipt column + an embedded image', async () => {
  const origSel = supabase.sbSelect; const origSpec = templates.getFieldSpec; const origFetch = storage.fetchReceiptObject;
  supabase.sbSelect = async () => ([{ id: 'e1', merchant: 'Cafe', amount: 10, expense_date: '2026-06-01', receipt_url: 'default/abc.png' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  storage.fetchReceiptObject = async () => PNG;
  try {
    const { status, buf } = await callExcel();
    assert.strictEqual(status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    const header = [];
    for (let i = 1; i <= sheet.columnCount; i++) header.push(sheet.getRow(2).getCell(i).value);
    assert.strictEqual(header.at(-1), 'Receipt');
    assert.strictEqual(sheet.getImages().length, 1, 'thumbnail embedded');
  } finally { supabase.sbSelect = origSel; templates.getFieldSpec = origSpec; storage.fetchReceiptObject = origFetch; }
});

test('excel: rows without a receipt_url get no Receipt column (unchanged export)', async () => {
  const origSel = supabase.sbSelect; const origSpec = templates.getFieldSpec;
  supabase.sbSelect = async () => ([{ id: 'e1', merchant: 'Cafe', amount: 10, expense_date: '2026-06-01' }]);
  templates.getFieldSpec = async () => FIELD_SPEC;
  try {
    const { buf } = await callExcel();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    const header = [];
    for (let i = 1; i <= sheet.columnCount; i++) header.push(sheet.getRow(2).getCell(i).value);
    assert.ok(!header.includes('Receipt'));
    assert.strictEqual(sheet.getImages().length, 0);
  } finally { supabase.sbSelect = origSel; templates.getFieldSpec = origSpec; }
});
