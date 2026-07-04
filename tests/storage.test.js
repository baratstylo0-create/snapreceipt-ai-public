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
