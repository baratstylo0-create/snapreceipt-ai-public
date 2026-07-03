'use strict';
// Tier-2 QA adversarial regressions for routes/upload.js (#7).
// Charter: hostile route input, auth boundary, sanitization completeness, resource sanity.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const mountUpload = require('../routes/upload');

// App WITHOUT a global error handler (route in isolation).
function appWith(over = {}) {
  const app = express();
  const deps = {
    runBatch: async () => ({ images: 1, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', type: 'text' }] }),
    ...over,
  };
  mountUpload(app, deps);
  return app;
}
// App WITH the exact global error handler from server.js (real-app parity).
function appWithGlobalHandler(over = {}) {
  const app = appWith(over);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err && (err.status || err.statusCode)) || 400;
    res.status(status < 500 ? status : 400).json({ error: 'invalid request' });
  });
  return app;
}
// Send a RAW string body (bypasses JSON.stringify so we can send malformed/hostile bytes).
async function postRaw(app, bodyStr, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: bodyStr,
    });
    return { status: r.status, text: await r.text() };
  } finally { srv.close(); }
}
async function post(app, body, headers = {}) { return postRaw(app, JSON.stringify(body), headers); }
const b64 = Buffer.from('fake-image-bytes').toString('base64');

// --- PROTOTYPE POLLUTION / HOSTILE BODY SHAPES -----------------------------

test('images only on __proto__ (prototype pollution) -> 400, runBatch not called', async () => {
  let called = false;
  const app = appWith({ runBatch: async () => { called = true; return { saved: 0, failed: [] }; } });
  const r = await postRaw(app, JSON.stringify({ '__proto__': { images: [b64] } }));
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test('constructor.prototype pollution shape -> 400', async () => {
  const app = appWith();
  const r = await postRaw(app, JSON.stringify({ constructor: { prototype: { images: [b64] } } }));
  assert.equal(r.status, 400);
});

test('array-of-arrays images -> 400 (non-string element)', async () => {
  const app = appWith();
  const r = await post(app, { images: [[b64]] });
  assert.equal(r.status, 400);
});

test('images:[null] -> 400', async () => {
  const app = appWith();
  const r = await post(app, { images: [null] });
  assert.equal(r.status, 400);
});

test('sparse array [ , "x" ] -> 400 (hole reads as undefined, not a string)', async () => {
  const app = appWith();
  const r = await postRaw(app, '{"images":[null,"' + b64 + '"]}'); // JSON has no holes; null models the hole
  assert.equal(r.status, 400);
});

test('images key present but value is an object -> 400', async () => {
  const app = appWith();
  const r = await post(app, { images: { 0: b64, length: 1 } });
  assert.equal(r.status, 400);
});

test('duplicate JSON keys (last wins, non-array) -> 400', async () => {
  const app = appWith();
  const r = await postRaw(app, '{"images":["' + b64 + '"],"images":123}');
  assert.equal(r.status, 400);
});

test('no request body at all -> 400, never crashes', async () => {
  const srv = appWith().listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/upload', { method: 'POST' });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

// --- SANITIZATION / STACK-LEAK COMPLETENESS --------------------------------

// The route's own try/catch does NOT run for malformed JSON (body-parser throws first).
// In isolation this leaks a stack trace + file paths. This test documents that the
// route MUST be mounted behind the global error handler (as server.js does).
test('malformed JSON in isolation leaks a stack (documents need for global handler)', async () => {
  const app = appWith();
  const r = await postRaw(app, '{bad json');
  // Isolation exposes the raw body-parser stack — this is why server.js has a global handler.
  assert.ok(r.text.includes('SyntaxError') || r.text.includes('at '),
    'without the global handler, malformed JSON leaks internals (mount behind it in prod)');
});

// Real-app parity: WITH server.js's global handler, malformed JSON is sanitized to 400.
test('malformed JSON behind global handler -> 400, NO stack/path leak', async () => {
  const app = appWithGlobalHandler();
  const r = await postRaw(app, '{bad json');
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes('SyntaxError'));
  assert.ok(!r.text.includes('body-parser'));
  assert.ok(!r.text.includes('.js:'));
  assert.ok(!r.text.includes('at '));
});

// Oversized body (> 10mb) behind the global handler -> 413, no leak, runBatch not called.
test('oversized body behind global handler -> 413, no stack leak, runBatch not called', async () => {
  let called = false;
  const app = appWithGlobalHandler({ runBatch: async () => { called = true; return { saved: 0, failed: [] }; } });
  const huge = JSON.stringify({ images: ['A'.repeat(11 * 1024 * 1024)] });
  const r = await postRaw(app, huge);
  assert.equal(r.status, 413);
  assert.ok(!r.text.includes('.js:'));
  assert.equal(called, false);
});

// 502 path must not leak the underlying error.
test('runBatch throws with a path in the message -> 502, no path leak', async () => {
  const app = appWith({ runBatch: async () => { throw new Error('ENOENT /srv/app/secret/lib/x.js:1'); } });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes('/srv/app'));
  assert.ok(!r.text.includes('.js:'));
});

// --- AUTH BOUNDARY ---------------------------------------------------------

test('checkDash: query ?key= is REJECTED -> 401 (header-only auth, Task J F2)', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const srv = appWith().listen(0);
    const { port } = srv.address();
    try {
      // A correct token in the query string no longer authorizes — only the Bearer header does.
      const r = await fetch('http://127.0.0.1:' + port + '/api/upload?key=secret', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: [b64] }),
      });
      assert.equal(r.status, 401);
    } finally { srv.close(); }
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('checkDash: header case-trick "bearer secret" (lowercase scheme) is REJECTED -> 401', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    const app = appWith();
    const r = await post(app, { images: [b64] }, { Authorization: 'bearer secret' });
    assert.equal(r.status, 401); // exact-match 'Bearer ' + token; lowercase must not pass
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('checkDash: wrong token -> 401, runBatch not called', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    let called = false;
    const app = appWith({ runBatch: async () => { called = true; return { saved: 0, failed: [] }; } });
    const r = await post(app, { images: [b64] }, { Authorization: 'Bearer wrong' });
    assert.equal(r.status, 401);
    assert.equal(called, false);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('checkDash: token unset (empty) -> open access, 200 even with no auth header', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = '';
  try {
    const app = appWith();
    const r = await post(app, { images: [b64] });
    assert.equal(r.status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

// --- RESOURCE SANITY WITHIN AUTH -------------------------------------------

// 10 images x ~1MB base64 under the 10mb cap: synchronous decode must not be pathological.
test('10 x ~1MB base64 images decode within the cap without pathological slowdown', async () => {
  let gotLen = 0;
  const app = appWith({ runBatch: async (imgs) => { gotLen = imgs.length; return { images: imgs.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; } });
  const oneMb = Buffer.alloc(700 * 1024, 0x41).toString('base64'); // ~933KB base64
  const images = Array.from({ length: 10 }, () => oneMb);
  const t = Date.now();
  const r = await post(app, { images });
  const ms = Date.now() - t;
  assert.equal(r.status, 200);
  assert.equal(gotLen, 10);
  assert.ok(ms < 5000, 'decode of 10x~1MB should be well under 5s, was ' + ms + 'ms');
});

// data-URI trick inputs are decoded leniently (never a per-string 400 / never a crash).
test('data-URI tricks (data:;base64, / double-prefix / uppercase DATA:) never crash -> 200', async () => {
  let bufs;
  const app = appWith({ runBatch: async (imgs) => { bufs = imgs; return { images: imgs.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; } });
  const tricks = ['data:;base64,' + b64, 'data:image/png;base64,data:image/png;base64,' + b64, 'DATA:image/png;base64,' + b64];
  const r = await post(app, { images: tricks });
  assert.equal(r.status, 200);
  assert.ok(bufs.every(Buffer.isBuffer));
  assert.equal(bufs.length, 3);
});
