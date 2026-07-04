'use strict';
// Task A §4.2: the security-headers middleware must set a strict CSP and the
// hardening headers on EVERY response, plus Cache-Control: no-store on data-
// bearing paths (/api/*, /receipt). Written TDD first. Two layers of proof:
//  1) unit — call the middleware with a fake req/res and assert res.set() calls,
//  2) integration — mount it on a real express app and assert response headers.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const securityHeaders = require('../lib/security-headers');

// --- unit: fake res captures every header set ---
function fakeRes() {
  const headers = {};
  return {
    headers,
    set(k, v) {
      if (typeof k === 'object') Object.assign(headers, k);
      else headers[k] = v;
      return this;
    },
  };
}

test('sets CSP + hardening headers on a normal (non-api) path', () => {
  const res = fakeRes();
  let nexted = false;
  securityHeaders({ path: '/index.html' }, res, () => { nexted = true; });
  assert.ok(nexted, 'must call next()');
  assert.match(res.headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(res.headers['Content-Security-Policy'], /object-src 'none'/);
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.strictEqual(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(res.headers['X-Frame-Options'], 'DENY');
  assert.strictEqual(res.headers['Referrer-Policy'], 'no-referrer');
  assert.match(res.headers['Permissions-Policy'], /camera=\(\)/);
  assert.strictEqual(res.headers['Cache-Control'], undefined, 'no no-store on a page path');
});

test("img-src allows blob: — receipt images render via fetchBlob -> object URL (ADR-018)", () => {
  // The dashboard fetches every receipt image with an auth'd XHR and renders the bytes as
  // a browser-generated blob: object URL in a real <img> (never a raw cross-origin URL).
  // Without blob: in img-src, CSP silently blocks EVERY receipt image (Storage + Telegram).
  const res = fakeRes();
  securityHeaders({ path: '/index.html' }, res, () => {});
  assert.match(res.headers['Content-Security-Policy'], /img-src [^;]*\bblob:/);
  // still same-origin only for scripts/styles (no loosening elsewhere)
  assert.match(res.headers['Content-Security-Policy'], /script-src 'self'/);
});

test('adds Cache-Control: no-store on /api/* paths', () => {
  const res = fakeRes();
  securityHeaders({ path: '/api/expenses' }, res, () => {});
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  // still carries the base headers
  assert.ok(res.headers['Content-Security-Policy']);
});

test('adds Cache-Control: no-store on /receipt paths', () => {
  const res = fakeRes();
  securityHeaders({ path: '/receipt/abc123' }, res, () => {});
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

// --- integration: real express app applying only the middleware ---
function server() {
  const app = express();
  app.use(securityHeaders);
  app.get('/', (req, res) => res.send('ok'));
  app.get('/api/thing', (req, res) => res.json({ ok: true }));
  const s = app.listen(0);
  return { s, base: 'http://127.0.0.1:' + s.address().port };
}

test('integration: normal response carries CSP + nosniff, no Cache-Control', async () => {
  const { s, base } = server();
  try {
    const r = await fetch(base + '/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('cache-control'), null);
  } finally { s.close(); }
});

test('integration: /api/* response carries Cache-Control: no-store', async () => {
  const { s, base } = server();
  try {
    const r = await fetch(base + '/api/thing');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { s.close(); }
});
