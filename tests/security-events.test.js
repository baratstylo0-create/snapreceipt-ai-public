'use strict';
// SEC-6 (ADR-025): central security-event logging. One middleware observes the FINAL response
// status and logs the security-relevant ones — auth failure (401), scope/role denial (403),
// rate-limit trip (429) — so no route needs its own call and none can be forgotten. ADR-002:
// method/path/status/ip only, never bodies/tokens/query strings.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const securityEvents = require('../lib/security-events');
const { logSecurity } = require('../lib/log');

function makeApp() {
  const app = express();
  app.use(securityEvents);
  app.get('/login', (req, res) => res.status(401).json({ error: 'unauthorized' }));       // auth fail
  app.get('/branch', (req, res) => res.status(403).json({ error: 'forbidden' }));          // scope deny
  app.get('/flood', (req, res) => res.status(429).json({ error: 'rate limit exceeded' })); // rate limit
  app.get('/ok', (req, res) => res.status(200).json({ ok: true }));                        // normal
  app.get('/missing', (req, res) => res.status(404).json({ error: 'not found' }));         // not security
  return app;
}

// Hit `path`, capturing every console.warn line emitted while the request completes.
async function hitCapturingWarn(path) {
  const captured = [];
  const orig = console.warn;
  console.warn = (x) => captured.push(x);
  try {
    const srv = makeApp().listen(0);
    const { port } = srv.address();
    try {
      await fetch('http://127.0.0.1:' + port + path);
      await new Promise((r) => setTimeout(r, 25)); // let res 'finish' fire on the server
    } finally { srv.close(); }
  } finally { console.warn = orig; }
  return captured;
}

test('401 -> one auth_fail security line with level/where/method/path/status/ip', async () => {
  const lines = await hitCapturingWarn('/login');
  assert.strictEqual(lines.length, 1, 'exactly one security line for one 401');
  const o = JSON.parse(lines[0]);
  assert.strictEqual(o.level, 'security');
  assert.strictEqual(o.where, 'auth_fail');
  assert.strictEqual(o.status, 401);
  assert.strictEqual(o.method, 'GET');
  assert.strictEqual(o.path, '/login');
  assert.ok('ip' in o, 'source IP is recorded (the point of a security log)');
});

test('403 -> scope_deny, 429 -> rate_limit', async () => {
  for (const [path, where, status] of [['/branch', 'scope_deny', 403], ['/flood', 'rate_limit', 429]]) {
    const lines = await hitCapturingWarn(path);
    assert.strictEqual(lines.length, 1, path + ' logs one line');
    const o = JSON.parse(lines[0]);
    assert.strictEqual(o.where, where);
    assert.strictEqual(o.status, status);
  }
});

test('does NOT log normal (200) or non-security (404) responses', async () => {
  for (const path of ['/ok', '/missing']) {
    const lines = await hitCapturingWarn(path);
    assert.strictEqual(lines.length, 0, path + ' must not emit a security line');
  }
});

test('path only — a query string (which could carry a token) is never logged', async () => {
  const lines = await hitCapturingWarn('/login?token=supersecret123');
  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].includes('supersecret123'), 'query string / token must not appear in the log');
});

test('logSecurity is ADR-002 safe — a nested-object field is dropped, never serialized', () => {
  const captured = [];
  const orig = console.warn;
  console.warn = (x) => captured.push(x);
  try { logSecurity('auth_fail', { status: 401, body: { password: 'hunter2' } }); }
  finally { console.warn = orig; }
  const o = JSON.parse(captured[0]);
  assert.strictEqual(o.level, 'security');
  assert.ok(!('body' in o), 'a nested-object field must never be logged (PII guard)');
  assert.ok(!captured[0].includes('hunter2'), 'nested secret never appears');
});
