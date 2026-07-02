'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountUpload = require('../routes/upload');

// A tiny PdfError stand-in (matches lib/pdf.js: name 'PdfError', a stable .code).
class FakePdfError extends Error { constructor(code) { super(code); this.name = 'PdfError'; this.code = code; } }

const PNG = () => Buffer.from([0x89, 0x50, 0x4e, 0x47]); // stand-in rendered page bytes

// Base deps: fakes for every injected boundary. A PDF item is detected by the route
// via the %PDF- magic byte on the decoded buffer, then handed to rasterizePdf.
function appWith(over = {}) {
  const app = express();
  const calls = { rasterize: 0, runBatchImages: null };
  const deps = {
    rasterizePdf: async () => { calls.rasterize++; return { pages: [PNG(), PNG()], truncated: false }; },
    runBatch: async (images) => {
      calls.runBatchImages = images;
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', type: 'text' }] }),
    ...over,
  };
  mountUpload(app, deps);
  return { app, calls };
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
const pdfB64 = Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64');
const imgB64 = Buffer.from('fake-image-bytes').toString('base64');

test('a PDF item -> rasterizePdf -> runBatch(pages) -> 200 batch summary', async () => {
  const { app, calls } = appWith();
  const r = await post(app, { images: [pdfB64] });
  assert.equal(r.status, 200);
  assert.equal(calls.rasterize, 1);
  assert.equal(calls.runBatchImages.length, 2);      // the PDF's 2 rendered pages
  assert.equal(r.json.saved, 2);
});

test('a normal image item does NOT call rasterizePdf (existing image path)', async () => {
  const { app, calls } = appWith();
  const r = await post(app, { images: [imgB64] });
  assert.equal(r.status, 200);
  assert.equal(calls.rasterize, 0);
  assert.ok(Buffer.isBuffer(calls.runBatchImages[0]));
});

test('mixed batch: image + 2-page PDF -> runBatch receives 3 images', async () => {
  const { app, calls } = appWith();
  await post(app, { images: [imgB64, pdfB64] });
  assert.equal(calls.runBatchImages.length, 3);
  assert.ok(Buffer.isBuffer(calls.runBatchImages[0]));  // the image kept as-is
});

test('rasterizePdf truncated -> response surfaces pages_truncated', async () => {
  const { app } = appWith({ rasterizePdf: async () => ({ pages: [PNG()], truncated: true }) });
  const r = await post(app, { images: [pdfB64] });
  assert.equal(r.status, 200);
  assert.equal(r.json.pages_truncated, true);
});

test('oversized PDF (PdfError TOO_LARGE) -> 413, fixed sanitized message', async () => {
  const { app } = appWith({ rasterizePdf: async () => { throw new FakePdfError('TOO_LARGE'); } });
  const r = await post(app, { images: [pdfB64] });
  assert.equal(r.status, 413);
  assert.ok(!/TOO_LARGE/.test(JSON.stringify(r.json)), 'raw code not leaked');
  assert.ok(!JSON.stringify(r.json).includes('at '), 'no stack');
});

test('encrypted/corrupt PDF (PdfError) -> 422, no library internals leaked', async () => {
  for (const code of ['ENCRYPTED', 'CORRUPT', 'NOT_PDF', 'EMPTY']) {
    const { app } = appWith({
      rasterizePdf: async () => { const e = new FakePdfError(code); e.stack = 'SECRET at /srv/app/lib/pdf.js:99'; throw e; },
    });
    const r = await post(app, { images: [pdfB64] });
    assert.equal(r.status, 422, code);
    const body = JSON.stringify(r.json);
    assert.ok(!body.includes('SECRET') && !body.includes('/srv/app') && !body.includes(code), 'no internals leaked for ' + code);
  }
});

test('a non-PdfError thrown by rasterizePdf -> 502 (generic), no leak', async () => {
  const { app } = appWith({ rasterizePdf: async () => { throw new Error('kaboom at /srv/x.js:1'); } });
  const r = await post(app, { images: [pdfB64] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('/srv/x.js'));
});

test('combined page cap: expanded pages beyond MASS_MAX_IMAGES are bounded', async () => {
  // one PDF that renders 15 pages -> capped to 10, pages_truncated surfaced
  const many = Array.from({ length: 15 }, () => PNG());
  const { app, calls } = appWith({ rasterizePdf: async () => ({ pages: many, truncated: false }) });
  const r = await post(app, { images: [pdfB64] });
  assert.equal(r.status, 200);
  assert.equal(calls.runBatchImages.length, 10);
  assert.equal(r.json.pages_truncated, true);
});
