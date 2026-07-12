'use strict';
// #13 monitoring — GET /ready is a DEEP readiness probe (distinct from /health liveness):
// it confirms the Supabase data plane is reachable. 200 when up, 503 when down, no data in
// the body (no PII). Rate-limited (it touches the DB). Groq is intentionally NOT pinged.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const storage = require('../lib/storage');
const mountMisc = require('../routes/misc');

// Both deps are stubbed so the probe never touches a real network (hermetic). storage defaults
// to "up" so the DB-focused tests are unaffected; pass stubProbe to exercise the storage verdict.
async function call(path, { stubSelect, stubProbe } = {}) {
  const origSelect = supabase.sbSelect;
  const origProbe = storage.probeStorage;
  if (stubSelect) supabase.sbSelect = stubSelect;
  storage.probeStorage = stubProbe || (async () => ({ ok: true, status: 200 }));
  const app = express();
  mountMisc(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path);
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  } finally { srv.close(); supabase.sbSelect = origSelect; storage.probeStorage = origProbe; }
}

test('GET /ready → 200 {ok:true, deps:{db:"up", storage:"up"}} when both are reachable', async () => {
  const { status, json } = await call('/ready', { stubSelect: async () => [] });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.deps.db, 'up');
  assert.strictEqual(json.deps.storage, 'up');
});

test('GET /ready → 503 {ok:false, deps:{db:"down"}} when the DB read throws', async () => {
  const { status, json } = await call('/ready', { stubSelect: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(status, 503);
  assert.strictEqual(json.ok, false);
  assert.strictEqual(json.deps.db, 'down');
});

// The exact 2026-07-11 incident shape: server up, DB up, but STORAGE unreachable. This is the
// verdict that a plain `curl /ready` must surface so the VPS-side fault is visible without SSH.
test('GET /ready reports storage:"down" (+ a short detail) but STAYS 200 — storage does not gate readiness', async () => {
  const { status, json } = await call('/ready', {
    stubSelect: async () => [],
    stubProbe: async () => ({ ok: false, status: null, detail: 'Bucket not found' }),
  });
  assert.strictEqual(status, 200, 'a storage blip must NOT pull the instance out of rotation');
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.deps.db, 'up');
  assert.strictEqual(json.deps.storage, 'down');
  assert.strictEqual(json.storage_detail, 'Bucket not found');
});

test('GET /ready: a throwing storage probe still resolves to storage:"down", never crashes the probe', async () => {
  const { status, json } = await call('/ready', {
    stubSelect: async () => [],
    stubProbe: async () => { throw new Error('boom'); },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.deps.storage, 'down');
});

test('GET /ready returns NO data rows in the body (probe only, no PII leak)', async () => {
  const { json } = await call('/ready', { stubSelect: async () => [{ id: 'secret-row', merchant: 'ACME' }] });
  assert.deepStrictEqual(Object.keys(json).sort(), ['deps', 'ok'], 'body is exactly {ok, deps} (storage up → no detail) — no rows echoed');
  assert.deepStrictEqual(Object.keys(json.deps).sort(), ['db', 'storage'], 'deps carries only up/down verdicts');
});

test('GET /ready is rate-limited (emits RateLimit-* headers)', async () => {
  const { headers } = await call('/ready', { stubSelect: async () => [] });
  assert.ok(headers.get('ratelimit-limit'), 'RateLimit-Limit header present → limiter wired');
});

test('GET /health is unchanged (liveness, no deps touched)', async () => {
  let touched = false;
  const { status, json } = await call('/health', { stubSelect: async () => { touched = true; return []; } });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(touched, false, '/health must NOT hit the DB (pure liveness)');
});
