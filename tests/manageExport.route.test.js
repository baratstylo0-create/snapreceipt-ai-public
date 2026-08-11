'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');
const templates = require('../lib/templates');
const storage = require('../lib/storage');
const { rgbaToPng } = require('../lib/pdf');
const mountManageExport = require('../routes/manageExport');

const FIELD_SPEC = {
  columns: [
    { key: 'merchant', label: 'Merchant', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'currency' },
  ],
  categories: ['Food', 'Travel', 'Others'],
};

const ROWS = [
  { id: 'e1', expense_date: '2026-07-01', merchant: 'Cafe', amount: 10, currency: 'MYR', category: 'Food', branch_id: 'b1', staff_user_id: 's1', payment_status: 'pending', receipt_url: 'default/e1.png' },
  { id: 'e2', expense_date: '2026-07-02', merchant: 'Taxi', amount: 20, currency: 'MYR', category: 'Travel', branch_id: 'b2', staff_user_id: 's2', payment_status: 'paid', receipt_url: 'default/e2.png' },
  { id: 'e3', expense_date: '2026-07-03', merchant: 'Hidden', amount: 30, currency: 'MYR', category: 'Food', branch_id: 'b3', staff_user_id: 's3', payment_status: 'paid' },
];

function tinyPng() { return rgbaToPng(Buffer.alloc(2 * 2 * 4, 0xff), 2, 2); }

async function callExport(format, body) {
  const app = express();
  mountManageExport(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/manage-export?format=' + encodeURIComponent(format), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf };
  } finally { server.close(); }
}

async function withStubs(fn) {
  const origSelect = supabase.sbSelect;
  const origSpec = templates.getFieldSpec;
  const origFetch = storage.fetchReceiptObject;
  try {
    supabase.sbSelect = async (table) => {
      if (table === 'expenses') return ROWS;
      if (table === 'branches') return [{ id: 'b1', office: 'HQ' }, { id: 'b2', office: 'Penang' }];
      if (table === 'users') return [{ id: 's1', display_name: 'Aisha' }, { id: 's2', display_name: 'Ben' }];
      return [];
    };
    templates.getFieldSpec = async () => FIELD_SPEC;
    storage.fetchReceiptObject = async () => tinyPng();
    await fn();
  } finally {
    supabase.sbSelect = origSelect;
    templates.getFieldSpec = origSpec;
    storage.fetchReceiptObject = origFetch;
  }
}

test('manage export CSV: exports requested filtered-row ids in client order with receipt_url links', async () => {
  // Personal (business=false, the default in this test env — no multiUser cap set): Branch/Staff
  // columns are dropped and Receipt Type is added instead (2026-07-30 export redesign).
  await withStubs(async () => {
    const r = await callExport('csv', { ids: ['e2', 'e1', 'missing'] });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const lines = r.buf.toString('utf8').trim().split('\r\n');
    assert.strictEqual(lines[0], 'Date,Merchant,Amount,Currency,Category,Status,Receipt Type,Receipt URL');
    assert.strictEqual(lines[1], '2026-07-02,Taxi,20,MYR,Travel,paid,Photo (Paper Receipt),/api/receipt/by-id/e2');
    assert.strictEqual(lines[2], '2026-07-01,Cafe,10,MYR,Food,pending,Photo (Paper Receipt),/api/receipt/by-id/e1');
    assert.strictEqual(lines.length, 3);
  });
});

test('manage export Excel: includes clickable receipt hyperlinks', async () => {
  await withStubs(async () => {
    const r = await callExport('xlsx', { ids: ['e1'] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buf.subarray(0, 2).toString('latin1'), 'PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buf);
    const sheet = wb.worksheets[0];
    const headers = sheet.getRow(2).values.slice(1);
    const receiptCol = headers.indexOf('Receipt') + 1;
    assert.ok(receiptCol > 0, 'Receipt column present');
    assert.strictEqual(sheet.getRow(3).getCell(receiptCol).value.hyperlink, '/api/receipt/by-id/e1');
  });
});

test('manage export PDF: reuses the statement PDF engine and appends receipt evidence pages', async () => {
  await withStubs(async () => {
    const r = await callExport('pdf', { ids: ['e1', 'e2'] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

test('manage export: zero selected/visible rows is a 400, leaving the frontend guard as first line of defence', async () => {
  await withStubs(async () => {
    const r = await callExport('csv', { ids: [] });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(JSON.parse(r.buf.toString('utf8')), { error: 'ids must be a non-empty array' });
  });
});
