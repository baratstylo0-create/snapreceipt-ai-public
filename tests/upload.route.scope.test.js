'use strict';
// routes/upload.js Phase 3 (ADR-021): in business mode the dashboard-upload path stamps the
// capturer's branch onto the per-image `meta` (from the session resolved by checkDash), so the
// shared ingestion (assembleExpense, lib/ocr.js — Barat) can persist branch_id/staff_user_id on
// each row. This test asserts MY half: the route forwards branch_id in the metas passed to
// runBatch. Personal mode leaves it absent (unchanged). The session lookup rides global.fetch.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountUpload = require('../routes/upload');

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
    const body = u.includes('/sessions') ? JSON.stringify(session ? [session] : []) : JSON.stringify([]);
    return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => Buffer.from(body) };
  };
  return { restore: () => { global.fetch = realFetch; } };
}

function appWith(deps) {
  const a = express();
  mountUpload(a, deps);
  return a;
}

async function postUpload(app, token) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ images: ['aGVsbG8='] }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

const ok = { images: 1, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };
const future = () => new Date(Date.now() + 3600e3).toISOString();

test('upload: clerk session stamps meta.branch_id onto the per-image metas', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession({ user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() });
    let metas;
    try {
      const app = appWith({
        runBatch: async (imgs, _spec, d) => { metas = d.metas; return ok; },
        extractReceipts: () => ({}),
        assembleExpense: async () => ({ expense: {}, flagged: false }),
        getFieldSpec: async () => ({ columns: [] }),
        uploadReceiptImage: async () => 'default/obj-1.jpg',
      });
      const { status } = await postUpload(app, 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(metas[0].branch_id, 'bA', 'capturer branch stamped for the ingestion to persist');
    } finally { s.restore(); }
  });
});

test('upload: clerk session with a company stamps meta.company_id too (ADR-023 Phase 8)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession({ user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', company_id: 'cA', expires_at: future() });
    let metas;
    try {
      const app = appWith({
        runBatch: async (imgs, _spec, d) => { metas = d.metas; return ok; },
        extractReceipts: () => ({}),
        assembleExpense: async () => ({ expense: {}, flagged: false }),
        getFieldSpec: async () => ({ columns: [] }),
        uploadReceiptImage: async () => 'default/obj-1.jpg',
      });
      const { status } = await postUpload(app, 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(metas[0].branch_id, 'bA');
      assert.strictEqual(metas[0].company_id, 'cA', 'company stamped beside branch for the ingestion to persist');
    } finally { s.restore(); }
  });
});

test('upload: clerk without a company leaves company_id absent (additive)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const s = stubSession({ user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() });
    let metas;
    try {
      const app = appWith({
        runBatch: async (imgs, _spec, d) => { metas = d.metas; return ok; },
        extractReceipts: () => ({}),
        assembleExpense: async () => ({ expense: {}, flagged: false }),
        getFieldSpec: async () => ({ columns: [] }),
        uploadReceiptImage: async () => 'default/obj-1.jpg',
      });
      const { status } = await postUpload(app, 'tok');
      assert.strictEqual(status, 200);
      assert.strictEqual(metas[0].branch_id, 'bA');
      assert.ok(!('company_id' in metas[0]), 'no company tagging when the session has none');
    } finally { s.restore(); }
  });
});

test('upload: personal mode leaves branch_id absent (unchanged)', async () => {
  let metas;
  const app = appWith({
    runBatch: async (imgs, _spec, d) => { metas = d.metas; return ok; },
    extractReceipts: () => ({}),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    getFieldSpec: async () => ({ columns: [] }),
    uploadReceiptImage: async () => null,
  });
  const { status } = await postUpload(app);
  assert.strictEqual(status, 200);
  assert.ok(!('branch_id' in metas[0]), 'no branch tagging on the personal product');
});
