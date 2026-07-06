'use strict';
// routes/excel.js Phase 3 (ADR-021): business-mode export carries Branch + Staff columns (ids
// resolved to names), and a CLERK's export is scoped to their own branch. Session lookup rides
// global.fetch; the expenses/branches/users fetches are the namespace-stubbed supabase.sbSelect.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');
const templates = require('../lib/templates');
const mountExcel = require('../routes/excel');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function stubSession(session) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);
    if (u.includes('/sessions')) return { text: async () => JSON.stringify(session ? [session] : []) };
    return { text: async () => JSON.stringify([]) };
  };
  return { restore: () => { global.fetch = realFetch; } };
}

const FIELD_SPEC = { columns: [
  { key: 'merchant', label: 'Vendor', type: 'text' },
  { key: 'amount', label: 'Total', type: 'currency' },
] };
const EXPENSES = [
  { merchant: 'Cafe', amount: 10, expense_date: '2026-06-01', branch_id: 'bA', staff_user_id: 's1' },
  { merchant: 'Fuel', amount: 20, expense_date: '2026-06-02', branch_id: 'bB', staff_user_id: 's2' },
];
const BRANCHES = [{ id: 'bA', office: 'KL Branch' }, { id: 'bB', office: 'JB Branch' }];
const USERS = [{ id: 's1', display_name: 'Ravi' }, { id: 's2', display_name: 'Mei' }];
const future = () => new Date(Date.now() + 3600e3).toISOString();

function tableAwareSelect() {
  return async (table) => {
    if (table === 'expenses') return EXPENSES;
    if (table === 'branches') return BRANCHES;
    if (table === 'users') return USERS;
    return [];
  };
}

async function callExcel(token) {
  const app = express();
  mountExcel(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/excel', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { srv.close(); }
}

test('excel: admin business export appends Branch + Staff columns with resolved names', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession({ user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() });
    const origSel = supabase.sbSelect; const origSpec = templates.getFieldSpec;
    supabase.sbSelect = tableAwareSelect(); templates.getFieldSpec = async () => FIELD_SPEC;
    try {
      const { status, buf } = await callExcel('tok');
      assert.strictEqual(status, 200);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      const sheet = wb.worksheets[0];
      assert.deepStrictEqual(sheet.getRow(2).values.slice(1), ['Vendor', 'Total', 'Branch', 'Staff']);
      assert.deepStrictEqual(sheet.getRow(3).values.slice(1), ['Cafe', 10, 'KL Branch', 'Ravi']);
      assert.deepStrictEqual(sheet.getRow(4).values.slice(1), ['Fuel', 20, 'JB Branch', 'Mei']);
    } finally { supabase.sbSelect = origSel; templates.getFieldSpec = origSpec; s.restore(); }
  });
});

test('excel: clerk export is scoped to their own branch (other branch excluded)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession({ user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() });
    const origSel = supabase.sbSelect; const origSpec = templates.getFieldSpec;
    supabase.sbSelect = tableAwareSelect(); templates.getFieldSpec = async () => FIELD_SPEC;
    try {
      const { buf } = await callExcel('tok');
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      const sheet = wb.worksheets[0];
      // title + header + Cafe(bA) + total = 4 rows; Fuel(bB) is excluded by clerk scope
      assert.strictEqual(sheet.rowCount, 4);
      assert.strictEqual(sheet.getRow(3).getCell(1).value, 'Cafe');
      assert.strictEqual(sheet.getRow(3).getCell(3).value, 'KL Branch');
    } finally { supabase.sbSelect = origSel; templates.getFieldSpec = origSpec; s.restore(); }
  });
});
