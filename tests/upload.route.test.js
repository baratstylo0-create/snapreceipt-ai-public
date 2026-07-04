'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const mountUpload = require('../routes/upload');

// Base deps: fake runBatch + dummy extractReceipts (present => not the 503 path) + fake getFieldSpec.
function appWith(over = {}) {
  const app = express();
  const deps = {
    runBatch: async () => ({ images: 1, receipts: 2, saved: 2, failed: [], flagged: [], truncated_images: [] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    uploadReceiptImage: async () => null, // hermetic default (no real Storage); overridden per-test
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', type: 'text' }] }),
    ...over,
  };
  mountUpload(app, deps);
  return app;
}
async function post(app, body, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}
const b64 = Buffer.from('fake-image-bytes').toString('base64');

test('happy path -> 200 + summary', async () => {
  const app = appWith();
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 200);
  assert.equal(r.json.saved, 2);
});

test('runBatch receives decoded Buffers', async () => {
  let got;
  const app = appWith({
    runBatch: async (images) => { got = images; return { images: 1, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; },
  });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 200);
  assert.ok(Buffer.isBuffer(got[0]));
  assert.equal(got[0].toString(), 'fake-image-bytes');
});

test('data-URI prefix stripped before decode', async () => {
  let got;
  const app = appWith({
    runBatch: async (images) => { got = images; return { images: 1, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; },
  });
  const r = await post(app, { images: ['data:image/png;base64,' + b64] });
  assert.equal(r.status, 200);
  assert.ok(Buffer.isBuffer(got[0]));
  assert.equal(got[0].toString(), 'fake-image-bytes');
});

test('non-array / empty / non-string element -> 400, no stack', async () => {
  const app = appWith();
  for (const body of [{ images: 'x' }, { images: [] }, { images: [123] }, { nope: 1 }]) {
    const r = await post(app, body);
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.json).includes('at '));
  }
});

test('too many images -> 413 (runBatch not called)', async () => {
  let called = false;
  const app = appWith({ runBatch: async () => { called = true; return { images: 0, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; } });
  const many = Array.from({ length: 11 }, () => b64);
  const r = await post(app, { images: many });
  assert.equal(r.status, 413);
  assert.equal(called, false);
});

test('extractReceipts unavailable -> 503', async () => {
  const app = appWith({ extractReceipts: undefined });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 503);
});

test('checkDash enforced: 401 without token, 200 with token', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const app = appWith();
    const noKey = await post(app, { images: [b64] });
    assert.equal(noKey.status, 401);
    const withKey = await post(app, { images: [b64] }, { Authorization: 'Bearer secret' });
    assert.equal(withKey.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('runBatch throws -> 502 JSON, no stack', async () => {
  const app = appWith({ runBatch: async () => { throw new Error('kaboom at internal/x.js:1'); } });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/x.js'));
});

test('getFieldSpec throws -> 502 JSON', async () => {
  const app = appWith({ getFieldSpec: async () => { throw new Error('spec load failed at internal/y.js:1'); } });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/y.js'));
});

test('ADR-018: each image is uploaded to Storage; its object path rides per-image to runBatch as receipt_url', async () => {
  const uploaded = [];
  let batchDeps;
  const app = appWith({
    uploadReceiptImage: async (buf) => { uploaded.push(buf.toString()); return 'default/obj-' + uploaded.length + '.jpg'; },
    runBatch: async (images, _spec, d) => { batchDeps = d; return { images: images.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; },
  });
  const r = await post(app, { images: [b64, b64] });
  assert.equal(r.status, 200);
  assert.equal(uploaded.length, 2, 'both images uploaded to Storage');
  assert.equal(batchDeps.metas[0].receipt_url, 'default/obj-1.jpg');
  assert.equal(batchDeps.metas[1].receipt_url, 'default/obj-2.jpg');
  assert.equal(batchDeps.metas[0].repName, 'Dashboard', 'shared meta fields preserved per image');
});

test('ADR-018 fail-safe: a failed upload (null) leaves receipt_url null; the row still uploads', async () => {
  let batchDeps;
  const app = appWith({
    uploadReceiptImage: async () => null, // storage hiccup — never throws
    runBatch: async (images, _spec, d) => { batchDeps = d; return { images: images.length, receipts: 1, saved: 1, failed: [], flagged: [], truncated_images: [] }; },
  });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 200);
  assert.equal(r.json.saved, 1);
  assert.equal(batchDeps.metas[0].receipt_url, null);
});

test('failed[].reason sanitized: raw error text never reaches the client', async () => {
  const app = appWith({ runBatch: async () => ({
    images: 2, receipts: 1, saved: 0,
    failed: [
      { image_index: 0, reason: "TypeError: Cannot destructure property 'expense' at /srv/app/lib/x.js:12" },
      { image_index: 1, receipt_index: 2, reason: 'connect ECONNREFUSED 10.0.0.5:443' },
    ],
    flagged: [], truncated_images: [],
  }) });
  const r = await post(app, { images: [b64, b64] });
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('TypeError') && !body.includes('ECONNREFUSED') && !body.includes('/srv/app'));
  assert.equal(r.json.failed[0].reason, 'could not read image');       // image-level (no receipt_index)
  assert.deepEqual({ i: r.json.failed[1].image_index, j: r.json.failed[1].receipt_index, rr: r.json.failed[1].reason },
                   { i: 1, j: 2, rr: 'could not save receipt' });      // receipt-level
});
