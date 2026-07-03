'use strict';
// Issue #53: an OPTIONS preflight to a gated /api/* or /receipt route must get CORS
// headers and a 2xx WITHOUT ever reaching checkDash (auth) — browsers don't attach
// credentials to preflights and expect a fast, unauthenticated 2xx/204 response.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const corsPreflight = require('../lib/cors-preflight');

function appWith() {
  const app = express();
  app.use(corsPreflight);
  // A route AFTER the middleware — if preflight is handled correctly this handler
  // must NEVER run for an OPTIONS request (proves short-circuit before auth/logic).
  app.options('/api/upload', (req, res) => res.status(599).end()); // sentinel: "reached past middleware"
  app.get('/api/expenses', (req, res) => res.json({ ok: true }));
  return app;
}

async function req(app, method, path, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path, { method, headers });
    return { status: r.status, headers: r.headers };
  } finally { srv.close(); }
}

test('OPTIONS preflight on /api/* returns 204 with CORS headers, never reaches the route', async () => {
  const { status, headers } = await req(appWith(), 'OPTIONS', '/api/upload', {
    Origin: 'https://dash.example.com',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Authorization, Content-Type',
  });
  assert.strictEqual(status, 204); // never 599 (the sentinel), never 404
  assert.ok(headers.get('access-control-allow-methods').includes('POST'));
  assert.ok(headers.get('access-control-allow-headers').toLowerCase().includes('authorization'));
});

test('OPTIONS preflight on /receipt/:fileId also gets CORS headers (Finder A #2/#4)', async () => {
  const { status, headers } = await req(appWith(), 'OPTIONS', '/receipt/fid1');
  assert.strictEqual(status, 204);
  assert.ok(headers.get('access-control-allow-methods'));
});

test('Access-Control-Allow-Origin reflects DASHBOARD_ORIGIN when set', async () => {
  const saved = cfg.DASHBOARD_ORIGIN;
  cfg.DASHBOARD_ORIGIN = 'https://dash.example.com';
  try {
    const { headers } = await req(appWith(), 'OPTIONS', '/api/expenses');
    assert.strictEqual(headers.get('access-control-allow-origin'), 'https://dash.example.com');
  } finally { cfg.DASHBOARD_ORIGIN = saved; }
});

test('Access-Control-Allow-Origin falls back to * when DASHBOARD_ORIGIN is unset (dev)', async () => {
  const saved = cfg.DASHBOARD_ORIGIN;
  cfg.DASHBOARD_ORIGIN = '';
  try {
    const { headers } = await req(appWith(), 'OPTIONS', '/api/expenses');
    assert.strictEqual(headers.get('access-control-allow-origin'), '*');
  } finally { cfg.DASHBOARD_ORIGIN = saved; }
});

test('a non-OPTIONS request is passed through untouched (no accidental short-circuit)', async () => {
  const { status } = await req(appWith(), 'GET', '/api/expenses');
  assert.strictEqual(status, 200);
});

test('OPTIONS on an unrelated path (e.g. /health) is passed through, not swallowed', async () => {
  const app = express();
  app.use(corsPreflight);
  app.options('/health', (req, res) => res.status(200).json({ ok: true }));
  const { status } = await req(app, 'OPTIONS', '/health');
  assert.strictEqual(status, 200); // reached the real handler — preflight middleware ignored this path
});
