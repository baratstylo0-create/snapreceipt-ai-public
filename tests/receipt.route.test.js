'use strict';
// P6 hardening — Finding 1 & 2 (docs/plans/2026-07-02-reference-frontend-qa-security.md §4.3):
//   1. GET /receipt/:fileId had NO checkDash -> anyone who knows/guesses a fileId could fetch a
//      sensitive receipt image with no token. Now gated behind checkDash, same as every other route.
//   2. The route's own Cache-Control: public, max-age=86400 overrode the security middleware's
//      no-store (res.set is last-write-wins and the route ran after the middleware). Now the route
//      sets Cache-Control: private, no-store itself so nothing caches a sensitive image.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const mountReceipt = require('../routes/receipt');

function appWith(deps) {
  const app = express();
  mountReceipt(app, deps);
  return app;
}

async function get(app, path, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, { headers });
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { srv.close(); }
}

test('DASHBOARD_TOKEN configured, no token supplied -> 401, receipt never fetched', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  let called = false;
  try {
    const app = appWith({ tgFileUrl: async () => { called = true; return { url: 'http://x', path: 'a.jpg' }; } });
    const { status } = await get(app, '/receipt/fid1');
    assert.strictEqual(status, 401);
    assert.strictEqual(called, false, 'must not touch Telegram when unauthenticated');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('DASHBOARD_TOKEN configured, correct bearer token -> 200 + private, no-store', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({
      tgFileUrl: async () => ({ url: 'http://x', path: 'a.jpg' }),
      hreq: async () => Buffer.from('fake-jpeg-bytes'),
    });
    const { status, headers, buf } = await get(app, '/receipt/fid1', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 200);
    assert.strictEqual(headers.get('cache-control'), 'private, no-store');
    assert.strictEqual(buf.toString(), 'fake-jpeg-bytes');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('DASHBOARD_TOKEN configured, ?key= query token also works (existing checkDash contract)', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({
      tgFileUrl: async () => ({ url: 'http://x', path: 'a.png' }),
      hreq: async () => Buffer.from('fake-png-bytes'),
    });
    const { status } = await get(app, '/receipt/fid1?key=tok-abc');
    assert.strictEqual(status, 200);
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('Cache-Control is never the old public/max-age value, even on error paths', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({ tgFileUrl: async () => null }); // -> 404 branch
    const { status, headers } = await get(app, '/receipt/fid1', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 404);
    assert.notStrictEqual(headers.get('cache-control'), 'public, max-age=86400');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});
