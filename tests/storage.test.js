'use strict';
// ADR-018 — lib/storage.js: upload receipt bytes to a private Supabase Storage bucket at
// ingestion, and fetch them back for the auth'd serve route. Fully injectable (deps.hreq),
// no real network. Fail-safe: any error -> null, so ingestion never breaks on a storage hiccup.
// Hermetic creds set BEFORE requiring config (whether or not a real .env is present) so the
// auth-header assertion is deterministic under `npm test` (which runs with .env moved aside).
process.env.SB_URL = process.env.SB_URL || 'https://test.supabase.co';
process.env.SB_KEY = process.env.SB_KEY || 'test-service-key';
const test = require('node:test');
const assert = require('node:assert');
const storage = require('../lib/storage');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = Buffer.from('%PDF-1.4 rest', 'latin1');

test('extOf: detects png/jpg/pdf from magic bytes; unknown -> bin', () => {
  assert.strictEqual(storage.extOf(PNG), 'png');
  assert.strictEqual(storage.extOf(JPG), 'jpg');
  assert.strictEqual(storage.extOf(PDF), 'pdf');
  assert.strictEqual(storage.extOf(Buffer.from([0, 1, 2, 3])), 'bin');
  assert.strictEqual(storage.extOf('nope'), 'bin');
});

test('uploadReceiptImage: PUTs bytes, returns an account-scoped uuid path with the right ext', async () => {
  let seen = null;
  const hreq = async (args) => { seen = args; return { Key: 'receipts/' + args.url.split('/receipts/')[1] }; };
  const path = await storage.uploadReceiptImage(PNG, { accountId: 'acme', deps: { hreq } });
  assert.match(path, /^acme\/[0-9a-f-]{36}\.png$/, 'path = <account>/<uuid>.png');
  assert.strictEqual(seen.method, 'POST');
  assert.match(seen.url, /\/storage\/v1\/object\/receipts\/acme\//);
  assert.strictEqual(seen.body, PNG, 'sends the raw buffer');
  assert.ok(seen.headers.Authorization && seen.headers.apikey, 'service-key auth');
});

test('uploadReceiptImage: non-Key response -> null (fail-safe, ingestion still saves)', async () => {
  const hreq = async () => ({ error: 'quota' });
  assert.strictEqual(await storage.uploadReceiptImage(JPG, { deps: { hreq } }), null);
});

test('uploadReceiptImage: a throwing hreq never escapes -> null', async () => {
  const hreq = async () => { throw new Error('ECONNRESET'); };
  await assert.doesNotReject(() => storage.uploadReceiptImage(JPG, { deps: { hreq } }));
  assert.strictEqual(await storage.uploadReceiptImage(JPG, { deps: { hreq } }), null);
});

test('uploadReceiptImage: empty / non-buffer input -> null, no request made', async () => {
  let called = false;
  const hreq = async () => { called = true; return { Key: 'x' }; };
  assert.strictEqual(await storage.uploadReceiptImage(Buffer.alloc(0), { deps: { hreq } }), null);
  assert.strictEqual(await storage.uploadReceiptImage('not-a-buffer', { deps: { hreq } }), null);
  assert.strictEqual(called, false);
});

test('fetchReceiptObject: returns the bytes; empty/garbage -> null', async () => {
  const hreq = async (args) => { assert.match(args.url, /\/receipts\/acme\/x\.png$/); return PNG; };
  assert.strictEqual(await storage.fetchReceiptObject('acme/x.png', { deps: { hreq } }), PNG);
  assert.strictEqual(await storage.fetchReceiptObject('', { deps: { hreq } }), null);
  assert.strictEqual(await storage.fetchReceiptObject(null, { deps: { hreq } }), null);
});

test('fetchReceiptObject: a throwing hreq -> null (never escapes)', async () => {
  const hreq = async () => { throw new Error('boom'); };
  assert.strictEqual(await storage.fetchReceiptObject('a/b.png', { deps: { hreq } }), null);
});

// probeStorage — readiness reachability check (2026-07-11: added to make a VPS-side storage
// fault visible via `curl /ready` when receipt reads 404 but the code/data are fine).
test('probeStorage: bucket-metadata read with our bucket id -> { ok:true }', async () => {
  const hreq = async (args) => {
    assert.match(args.url, /\/storage\/v1\/bucket\/receipts$/);
    assert.strictEqual(args.json, true); // text/json path (must NOT throw on a non-2xx)
    return { id: 'receipts', name: 'receipts', public: false };
  };
  assert.deepStrictEqual(await storage.probeStorage({ deps: { hreq } }), { ok: true, status: 200 });
});

test('probeStorage: an error body (no bucket id) -> { ok:false } with a short PII-free detail', async () => {
  const hreq = async () => ({ statusCode: '403', error: 'Unauthorized', message: 'permission denied' });
  const r = await storage.probeStorage({ deps: { hreq } });
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.detail === 'string' && r.detail.length <= 120);
});

test('probeStorage: a throwing hreq -> { ok:false }, never escapes', async () => {
  const hreq = async () => { throw new Error('ETIMEDOUT'); };
  const r = await storage.probeStorage({ deps: { hreq } });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /ETIMEDOUT/);
});

// probeStorageObject — the DEEP object-download check (the operation that actually serves a photo).
test('probeStorageObject: a 200 with bytes -> { ok:true, bytes }', async () => {
  const fetch = async (url) => {
    assert.match(url, /\/storage\/v1\/object\/receipts\/acme\/x\.jpg$/);
    return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
  };
  assert.deepStrictEqual(await storage.probeStorageObject('acme/x.jpg', { deps: { fetch } }), { ok: true, status: 200, bytes: 4 });
});

test('probeStorageObject: a non-2xx -> { ok:false, status, short detail } (NOT swallowed as bytes)', async () => {
  const fetch = async () => ({ ok: false, status: 400, arrayBuffer: async () => Buffer.from('{"error":"InvalidRequest","message":"bad"}').buffer });
  const r = await storage.probeStorageObject('acme/x.jpg', { deps: { fetch } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(r.detail.length <= 140);
});

test('probeStorageObject: no path -> { ok:false } without a fetch', async () => {
  let called = false;
  const fetch = async () => { called = true; return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) }; };
  const r = await storage.probeStorageObject('', { deps: { fetch } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(called, false);
});

test('probeStorageObject: a throwing/timed-out fetch -> { ok:false }, never escapes', async () => {
  const fetch = async () => { throw new Error('TimeoutError'); };
  const r = await storage.probeStorageObject('a/b.jpg', { deps: { fetch } });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /Timeout/);
});
