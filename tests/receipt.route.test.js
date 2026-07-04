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

test('?key= query token is REJECTED — header-only auth (Task J F2 fix)', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({
      tgFileUrl: async () => ({ url: 'http://x', path: 'a.png' }),
      hreq: async () => Buffer.from('fake-png-bytes'),
    });
    // The ?key= path was dropped (tokens in URLs leak to history/proxy logs); a correct
    // token in the query no longer authorizes — only the Authorization: Bearer header does.
    const { status } = await get(app, '/receipt/fid1?key=tok-abc');
    assert.strictEqual(status, 401);
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

// --- ADR-018: serve BY EXPENSE ID (look the row up server-side, never hand the browser
//     the raw storage path). Prefers durable Storage (receipt_url), falls back to the
//     Telegram proxy for old rows (receipt_file_id). ---

test('by-id: row with receipt_url streams from Storage (never touches Telegram)', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  let tgCalled = false;
  try {
    const app = appWith({
      sbSelect: async (_t, q) => (q.eq.id === 'e1' ? [{ id: 'e1', receipt_url: 'default/u.png', receipt_file_id: 'fidX' }] : []),
      fetchReceiptObject: async (path) => (path === 'default/u.png' ? Buffer.from('stored-png-bytes') : null),
      tgFileUrl: async () => { tgCalled = true; return { url: 'http://x', path: 'a.jpg' }; },
    });
    const { status, headers, buf } = await get(app, '/receipt/by-id/e1', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 200);
    assert.strictEqual(buf.toString(), 'stored-png-bytes');
    assert.strictEqual(headers.get('content-type'), 'image/png');
    assert.strictEqual(headers.get('cache-control'), 'private, no-store');
    assert.strictEqual(tgCalled, false, 'receipt_url present -> must not fall back to Telegram');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('by-id: row with only receipt_file_id falls back to the Telegram proxy', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({
      sbSelect: async () => [{ id: 'e2', receipt_url: null, receipt_file_id: 'fid2' }],
      tgFileUrl: async (fid) => (fid === 'fid2' ? { url: 'http://x', path: 'a.jpg' } : null),
      hreq: async () => Buffer.from('telegram-jpeg-bytes'),
    });
    const { status, buf } = await get(app, '/receipt/by-id/e2', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 200);
    assert.strictEqual(buf.toString(), 'telegram-jpeg-bytes');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('by-id: row with neither image -> 404', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  try {
    const app = appWith({ sbSelect: async () => [{ id: 'e3', receipt_url: null, receipt_file_id: null }] });
    const { status } = await get(app, '/receipt/by-id/e3', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 404);
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('by-id: unknown expense id -> 404, never touches Storage/Telegram', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  let touched = false;
  try {
    const app = appWith({
      sbSelect: async () => [],
      fetchReceiptObject: async () => { touched = true; return Buffer.from('x'); },
      tgFileUrl: async () => { touched = true; return { url: 'http://x', path: 'a.jpg' }; },
    });
    const { status } = await get(app, '/receipt/by-id/nope', { Authorization: 'Bearer tok-abc' });
    assert.strictEqual(status, 404);
    assert.strictEqual(touched, false);
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});

test('by-id: is checkDash-gated (401 with no token when one is configured)', async () => {
  const saved = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'tok-abc';
  let looked = false;
  try {
    const app = appWith({ sbSelect: async () => { looked = true; return []; } });
    const { status } = await get(app, '/receipt/by-id/e1');
    assert.strictEqual(status, 401);
    assert.strictEqual(looked, false, 'must not query the DB when unauthenticated');
  } finally { cfg.DASHBOARD_TOKEN = saved; }
});
