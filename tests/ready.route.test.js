'use strict';
// #13 monitoring — GET /ready is a DEEP readiness probe (distinct from /health liveness):
// it confirms the Supabase data plane is reachable. 200 when up, 503 when down, no data in
// the body (no PII). Rate-limited (it touches the DB). Groq is intentionally NOT pinged.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const mountMisc = require('../routes/misc');

async function call(path, { stubSelect } = {}) {
  const orig = supabase.sbSelect;
  if (stubSelect) supabase.sbSelect = stubSelect;
  const app = express();
  mountMisc(app);
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + path);
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  } finally { srv.close(); supabase.sbSelect = orig; }
}

test('GET /ready → 200 {ok:true, deps:{db:"up"}} when Supabase is reachable', async () => {
  const { status, json } = await call('/ready', { stubSelect: async () => [] });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.deps.db, 'up');
});

test('GET /ready → 503 {ok:false, deps:{db:"down"}} when the DB read throws', async () => {
  const { status, json } = await call('/ready', { stubSelect: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(status, 503);
  assert.strictEqual(json.ok, false);
  assert.strictEqual(json.deps.db, 'down');
});

test('GET /ready returns NO data rows in the body (probe only, no PII leak)', async () => {
  const { json } = await call('/ready', { stubSelect: async () => [{ id: 'secret-row', merchant: 'ACME' }] });
  assert.deepStrictEqual(Object.keys(json).sort(), ['deps', 'ok'], 'body is exactly {ok, deps} — no rows echoed');
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
