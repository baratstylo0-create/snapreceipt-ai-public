'use strict';
// P6 hardening (§4.3): checkDash must be FAIL-CLOSED in production. Today (pre-fix) it is
// `if (!cfg.DASHBOARD_TOKEN) return next()` — i.e. with no token configured, EVERY request
// is let through unauthenticated. This regression-tests both modes:
//   - prod (NODE_ENV=production) + no token  -> refused (401/500), never silently open.
//   - dev  (no NODE_ENV=production) + no token -> allowed (today's behavior), but warns loudly.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const { checkDash } = require('../routes/expenses');

function appWithGate() {
  const app = express();
  app.get('/probe', checkDash, (req, res) => res.json({ ok: true }));
  return app;
}

async function get(app, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/probe', { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

// Save/restore process.env + cfg mutations around every test so this file never
// leaks state into other test files (they run in one process via node:test).
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('prod mode, no DASHBOARD_TOKEN configured -> refused, no silent open', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = '';
  await withEnv({ NODE_ENV: 'production', AUTH_REQUIRED: undefined }, async () => {
    const app = appWithGate();
    const { status, json } = await get(app);
    assert.strictEqual(status >= 401 && status < 600, true, 'must not be 2xx');
    assert.notStrictEqual(status, 200);
    assert.ok(json && /misconfig/i.test(json.error || ''), 'error must say server misconfigured, not leak internals');
  });
  cfg.DASHBOARD_TOKEN = savedToken;
});

test('AUTH_REQUIRED=true (non-prod) + no token -> also refused', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = '';
  await withEnv({ NODE_ENV: 'test', AUTH_REQUIRED: 'true' }, async () => {
    const app = appWithGate();
    const { status } = await get(app);
    assert.notStrictEqual(status, 200);
  });
  cfg.DASHBOARD_TOKEN = savedToken;
});

test('dev mode (no NODE_ENV=production, no AUTH_REQUIRED), no token -> allowed (permissive, back-compat)', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = '';
  await withEnv({ NODE_ENV: 'test', AUTH_REQUIRED: undefined }, async () => {
    const app = appWithGate();
    const { status, json } = await get(app);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { ok: true });
  });
  cfg.DASHBOARD_TOKEN = savedToken;
});

test('dev mode, no token -> logs a loud warning on the unauthenticated request', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = '';
  const origWarn = console.warn;
  let warned = false;
  console.warn = (...args) => { warned = true; origWarn.apply(console, args); };
  try {
    await withEnv({ NODE_ENV: 'test', AUTH_REQUIRED: undefined }, async () => {
      const app = appWithGate();
      await get(app);
    });
    assert.strictEqual(warned, true, 'expected a console.warn on unauthenticated dev-mode request');
  } finally {
    console.warn = origWarn;
    cfg.DASHBOARD_TOKEN = savedToken;
  }
});

test('token configured (any mode) -> still requires a valid token (unchanged behavior)', async () => {
  const savedToken = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret123';
  await withEnv({ NODE_ENV: 'test' }, async () => {
    const app = appWithGate();
    const bad = await get(app, {});
    assert.strictEqual(bad.status, 401);
    const good = await get(app, { Authorization: 'Bearer secret123' });
    assert.strictEqual(good.status, 200);
  });
  cfg.DASHBOARD_TOKEN = savedToken;
});
