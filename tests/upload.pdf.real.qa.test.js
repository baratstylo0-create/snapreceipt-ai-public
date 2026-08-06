'use strict';
// Tier-2 independent QA for the PDF branch of POST /api/upload (PR #40,
// feature/co-developer-p4-pdf-route). The KEY value here vs. the existing
// tests/upload.pdf.test.js (which injects a FAKE rasterizePdf) is that these
// tests exercise the REAL lib/pdf.js rasterizePdf THROUGH the HTTP route on
// real on-disk PDF fixtures. Only the Groq/DB boundaries are faked
// (runBatch / extractReceipts / assembleExpense / getFieldSpec) — rasterizePdf
// is NOT injected, so the real WASM PDFium render path runs.
//
// Charter items: render-bomb over HTTP (huge-mediabox -> 413), real reject
// paths (corrupt/encrypted/empty -> 422), real happy path pages reaching
// runBatch, sanitization/money-safety, mixed+cap, and no library-internal leaks.
// Does NOT edit routes/upload.js or lib/*.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mountUpload = require('../routes/upload');

const FIX = path.join(__dirname, 'fixtures', 'pdf');
const fixB64 = (name) => fs.readFileSync(path.join(FIX, name)).toString('base64');
const isPng = (b) => Buffer.isBuffer(b) && b.length > 8 &&
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

// App wired with the REAL rasterizePdf (NOT injected). Everything downstream of
// rasterize is faked so no Groq/DB is touched. `calls` captures what runBatch saw.
function appReal(over = {}) {
  const app = express();
  const calls = { runBatchImages: null, runBatchCount: 0 };
  const deps = {
    runBatch: async (images) => {
      calls.runBatchImages = images;
      calls.runBatchCount++;
      return { images: images.length, receipts: images.length, saved: images.length, failed: [], flagged: [], truncated_images: [] };
    },
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', type: 'text' }] }),
    // rasterizePdf intentionally omitted -> route falls back to real pdf.rasterizePdf
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

// Anything that would betray library internals / typed error codes / stack frames.
function assertNoLeak(json) {
  const body = JSON.stringify(json);
  for (const needle of ['TOO_LARGE', 'NOT_PDF', 'CORRUPT', 'ENCRYPTED', 'EMPTY',
    'PdfError', 'pdfium', 'PDFium', '@hyzyla', 'lib/pdf', 'lib\\pdf', '.js:', ' at ', 'Password']) {
    assert.ok(!body.includes(needle), 'response leaked internal token: ' + needle + ' -> ' + body);
  }
}

// ---------------------------------------------------------------------------
// 1. Real render-bomb over HTTP (the headline)
// ---------------------------------------------------------------------------
test('REAL huge-mediabox.pdf over HTTP -> 413, fixed message, no OOM/500/leak', async () => {
  const { app, calls } = appReal();
  const t0 = Date.now();
  const r = await post(app, { images: [fixB64('huge-mediabox.pdf')] });
  const dt = Date.now() - t0;
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'a PDF was too large to process');
  assert.equal(calls.runBatchCount, 0, 'runBatch must NOT run on a rejected render-bomb (no money rows)');
  assertNoLeak(r.json);
  // If the pre-render pixel guard failed, pdfium would attempt a ~1.7e9-px alloc:
  // either OOM (process death) or many seconds. A fast, clean 413 proves the guard.
  assert.ok(dt < 4000, 'render-bomb reject must be fast (pre-render guard), took ' + dt + 'ms');
});

// ---------------------------------------------------------------------------
// 2. Real reject paths -> 422 (for those that reach rasterize), no leak
// ---------------------------------------------------------------------------
for (const name of ['corrupt.pdf', 'encrypted.pdf', 'zero-page.pdf']) {
  test('REAL ' + name + ' over HTTP -> 422, fixed message, no library internals', async () => {
    const { app, calls } = appReal();
    const r = await post(app, { images: [fixB64(name)] });
    assert.equal(r.status, 422, name + ' should be a 422 client reject');
    assert.equal(typeof r.json.error, 'string');
    assert.equal(calls.runBatchCount, 0, 'a rejected PDF must not reach runBatch');
    assertNoLeak(r.json);
  });
}

test('REAL encrypted.pdf -> exact fixed password message (not the pdfium "Password required" text)', async () => {
  const { app } = appReal();
  const r = await post(app, { images: [fixB64('encrypted.pdf')] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'a PDF is password-protected; please remove the password and resend');
});

// not-a-pdf.bin has NO %PDF- magic -> the route treats it as an IMAGE (rasterize
// NOT invoked). Verify it does not crash and flows straight to runBatch as a buffer.
test('REAL not-a-pdf.bin (no %PDF magic) -> IMAGE path, rasterize skipped, 200', async () => {
  const { app, calls } = appReal();
  const r = await post(app, { images: [fixB64('not-a-pdf.bin')] });
  assert.equal(r.status, 200);
  assert.equal(calls.runBatchCount, 1);
  assert.equal(calls.runBatchImages.length, 1);
  assert.ok(Buffer.isBuffer(calls.runBatchImages[0]), 'non-PDF bytes passed through as a raw buffer');
  assert.ok(!isPng(calls.runBatchImages[0]), 'not rasterized (still the raw non-PDF bytes)');
});

test('REAL eleven-page.pdf over HTTP -> 200, capped to MASS_MAX_IMAGES pages, pages_truncated', async () => {
  const { app, calls } = appReal();
  const r = await post(app, { images: [fixB64('eleven-page.pdf')] });
  assert.equal(r.status, 200);
  assert.equal(r.json.pages_truncated, true);
  const cap = Number(process.env.MASS_MAX_IMAGES) || 10;
  assert.equal(calls.runBatchImages.length, cap, 'expanded pages must be capped to MASS_MAX_IMAGES');
  assert.ok(calls.runBatchImages.every(isPng), 'all capped pages are real PNG buffers');
});

// ---------------------------------------------------------------------------
// 3. Real happy path -> the RIGHT number of real PNG page buffers reach runBatch
// ---------------------------------------------------------------------------
for (const [name, expectPages] of [['one-page.pdf', 1], ['three-page.pdf', 3], ['scanned.pdf', 1]]) {
  test('REAL ' + name + ' over HTTP -> ' + expectPages + ' PNG page buffer(s) reach runBatch -> 200', async () => {
    const { app, calls } = appReal();
    const r = await post(app, { images: [fixB64(name)] });
    assert.equal(r.status, 200);
    assert.equal(calls.runBatchCount, 1);
    assert.equal(calls.runBatchImages.length, expectPages, name + ' should render ' + expectPages + ' page(s)');
    assert.ok(calls.runBatchImages.every(Buffer.isBuffer), 'pages must be Buffers');
    assert.ok(calls.runBatchImages.every(isPng), 'each page buffer must carry PNG magic bytes');
    assert.equal(r.json.saved, expectPages);
    assert.ok(!('pages_truncated' in r.json), 'no truncation flag for an un-truncated PDF');
  });
}

// ---------------------------------------------------------------------------
// 4. Sanitization & money-safety — real render path, fake runBatch plants a secret
// ---------------------------------------------------------------------------
test('money-safety: secret in failed[].reason is stripped; flagged/saved pass through (real render)', async () => {
  const SECRET = 'TypeError at /srv/app/lib/secret.js:42 ECONNREFUSED 10.0.0.9:443';
  const { app } = appReal({
    runBatch: async (images) => ({
      images: images.length, receipts: 3, saved: 2,
      failed: [
        { image_index: 0, reason: SECRET },
        { image_index: 1, receipt_index: 1, reason: SECRET },
      ],
      flagged: [{ image_index: 2, receipt_index: 0 }],
      truncated_images: [],
    }),
  });
  const r = await post(app, { images: [fixB64('three-page.pdf')] });
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('TypeError') && !body.includes('ECONNREFUSED') && !body.includes('/srv/app'),
    'raw failure text must never reach the client');
  assert.equal(r.json.failed[0].reason, 'could not read image');   // image-level
  assert.equal(r.json.failed[1].reason, 'could not save receipt'); // receipt-level
  assert.equal(r.json.saved, 2, 'saved count passes through');
  assert.equal(r.json.receipts, 3, 'receipts count passes through');
  assert.deepEqual(r.json.flagged, [{ image_index: 2, receipt_index: 0 }], 'flagged summary passes through');
});

// ---------------------------------------------------------------------------
// 5. Mixed batch + combined cap (real render)
// ---------------------------------------------------------------------------
test('mixed image + real 3-page PDF -> runBatch gets image (raw) + 3 PNG pages, in order', async () => {
  const imgB64 = Buffer.from('fake-image-bytes').toString('base64');
  const { app, calls } = appReal();
  const r = await post(app, { images: [imgB64, fixB64('three-page.pdf')] });
  assert.equal(r.status, 200);
  assert.equal(calls.runBatchImages.length, 4);            // 1 image + 3 pages
  assert.ok(Buffer.isBuffer(calls.runBatchImages[0]) && !isPng(calls.runBatchImages[0]), 'image kept as-is, first');
  assert.equal(calls.runBatchImages[0].toString(), 'fake-image-bytes');
  assert.ok(calls.runBatchImages.slice(1).every(isPng), 'the 3 trailing buffers are rendered PNG pages');
});

test('two real PDFs (3-page + 11-page) expanding past MASS_MAX_IMAGES -> capped + pages_truncated', async () => {
  const cap = Number(process.env.MASS_MAX_IMAGES) || 10;
  const { app, calls } = appReal();
  // 3 pages + up-to-10 pages from the 11-page fixture (rasterize already truncates
  // that one to 10). Combined = 13 > cap -> route bounds to `cap` and flags truncated.
  const r = await post(app, { images: [fixB64('three-page.pdf'), fixB64('eleven-page.pdf')] });
  assert.equal(r.status, 200);
  assert.equal(calls.runBatchImages.length, cap, 'combined expansion bounded to MASS_MAX_IMAGES');
  assert.equal(r.json.pages_truncated, true);
  assert.ok(calls.runBatchImages.every(isPng), 'all delivered pages are real PNG buffers');
});

// ---------------------------------------------------------------------------
// 6. Auth still gates the real-render route + input-validation precedes render
// ---------------------------------------------------------------------------
test('checkDash gates the PDF route: 401 without token, 200 with token (real render)', async () => {
  const { cfg } = require('../lib/config');
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const { app } = appReal();
    const noKey = await post(app, { images: [fixB64('one-page.pdf')] });
    assert.equal(noKey.status, 401);
    const withKey = await post(app, { images: [fixB64('one-page.pdf')] }, { Authorization: 'Bearer secret' });
    assert.equal(withKey.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('too-many-images 413 fires BEFORE any PDF render (real path, runBatch not called)', async () => {
  const { app, calls } = appReal();
  const many = Array.from({ length: 11 }, () => fixB64('one-page.pdf'));
  const r = await post(app, { images: many });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too many images (max ' + (Number(process.env.MASS_MAX_IMAGES) || 10) + ')');
  assert.equal(calls.runBatchCount, 0);
});
