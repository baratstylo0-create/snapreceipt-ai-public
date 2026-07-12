'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hreq } = require('../lib/http');

test('hreq is a function and rejects on an unreachable host quickly', async () => {
  assert.strictEqual(typeof hreq, 'function');
  await assert.rejects(
    () => hreq({ url: 'http://127.0.0.1:1/never', timeout: 200 }),
    /.*/
  );
});

// --- arraybuffer status check (2026-07-11: a failing receipt/Telegram fetch used to return the
// error body AS image bytes -> silent broken thumbnail, no log, real cause hidden) ---------------

function stubFetch(status, bodyStr) {
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(bodyStr, 'utf8'),
    text: async () => bodyStr,
  });
  return () => { global.fetch = orig; };
}

test('hreq arraybuffer: a 2xx returns the raw bytes as a Buffer', async () => {
  const restore = stubFetch(200, 'PNGDATA');
  try {
    const buf = await hreq({ url: 'https://x/obj', encoding: 'arraybuffer' });
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.toString('utf8'), 'PNGDATA');
  } finally { restore(); }
});

test('hreq arraybuffer: a non-2xx THROWS (carrying status) instead of returning the error body as bytes', async () => {
  const restore = stubFetch(400, '{"error":"Bucket not found"}');
  try {
    await assert.rejects(
      () => hreq({ url: 'https://x/obj', encoding: 'arraybuffer' }),
      (err) => { assert.strictEqual(err.status, 400); assert.match(err.message, /Bucket not found/); return true; }
    );
  } finally { restore(); }
});

test('hreq arraybuffer: a 403 (permissions) also throws with the status surfaced', async () => {
  const restore = stubFetch(403, 'new row violates row-level security policy');
  try {
    await assert.rejects(
      () => hreq({ url: 'https://x/obj', encoding: 'arraybuffer' }),
      (err) => { assert.strictEqual(err.status, 403); return true; }
    );
  } finally { restore(); }
});

test('hreq text/json path is UNCHANGED: a non-2xx still returns the body (callers inspect it themselves)', async () => {
  const restore = stubFetch(404, '{"error":"not found"}');
  try {
    const parsed = await hreq({ url: 'https://x/api', json: true });
    assert.deepStrictEqual(parsed, { error: 'not found' }); // did NOT throw
  } finally { restore(); }
});
