'use strict';
// Tier-2 QA regressions for the Buffer→data-URI image fix (PR #39, fix/barat-ocr-buffer-image).
// The fix adds toImageUrlArg(image): a Buffer becomes a base64 data-URI (MIME sniffed via
// bufferImageMime magic bytes, default image/jpeg); a string passes through unchanged. Applied
// at both Groq call sites in extractReceipt and extractReceipts. Both helpers are internal, so
// these tests exercise them through the public fns by capturing the image_url.url the stub sees.
const test = require('node:test');
const assert = require('node:assert');
const { extractReceipt, extractReceipts } = require('../lib/ocr');

// Hermetic Groq stub — mirrors tests/ocr.test.js stubGroq (global.fetch capture, no network).
function stubGroq(content) {
  const realFetch = global.fetch;
  let lastBody = null;
  global.fetch = async (_url, opt) => {
    lastBody = JSON.parse(opt.body);
    return { text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  return { restore: () => { global.fetch = realFetch; }, sent: () => lastBody };
}

const SPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Vendor', type: 'text',     required: true },
    { key: 'amount',       label: 'Total',  type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',   type: 'date',     required: true },
  ],
};

const OBJ_REPLY = '{"merchant":"X","amount":1,"expense_date":"2026-01-01"}';
const ARR_REPLY = '[{"merchant":"X","amount":1,"expense_date":"2026-01-01"}]';

function sentImageUrl(sent) {
  return sent.messages[1].content.find(p => p.type === 'image_url').image_url.url;
}

// Drive whichever public fn through the stub and return the image_url the model received.
async function urlFor(fn, image, reply) {
  const s = stubGroq(reply);
  try {
    await fn(image, SPEC);
    return sentImageUrl(s.sent());
  } finally { s.restore(); }
}
const viaReceipt  = (image) => urlFor(extractReceipt, image, OBJ_REPLY);
const viaReceipts = (image) => urlFor(extractReceipts, image, ARR_REPLY);

// ---- (3) MIME sniff correctness across formats, for BOTH fns ----

test('MIME sniff: WEBP magic bytes (RIFF....WEBP) → image/webp', async () => {
  // 'RIFF' + 4 size bytes + 'WEBP' + payload
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.from([0x56, 0x50, 0x38, 0x20]),
  ]);
  assert.strictEqual(await viaReceipt(webp),  'data:image/webp;base64,' + webp.toString('base64'));
  assert.strictEqual(await viaReceipts(webp), 'data:image/webp;base64,' + webp.toString('base64'));
});

test('MIME sniff: GIF magic bytes (GIF8) → image/gif', async () => {
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 2, 3])]);
  assert.strictEqual(await viaReceipt(gif),  'data:image/gif;base64,' + gif.toString('base64'));
  assert.strictEqual(await viaReceipts(gif), 'data:image/gif;base64,' + gif.toString('base64'));
});

test('MIME sniff: PNG magic bytes → image/png (both fns)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20]);
  assert.strictEqual(await viaReceipt(png),  'data:image/png;base64,' + png.toString('base64'));
  assert.strictEqual(await viaReceipts(png), 'data:image/png;base64,' + png.toString('base64'));
});

test('MIME sniff: unknown/garbage bytes → default image/jpeg (harmless)', async () => {
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
  assert.strictEqual(await viaReceipt(garbage),  'data:image/jpeg;base64,' + garbage.toString('base64'));
  assert.strictEqual(await viaReceipts(garbage), 'data:image/jpeg;base64,' + garbage.toString('base64'));
});

// ---- (3) short-buffer safety: bounds-checked sniff must not crash on <4-byte buffers ----

test('MIME sniff: tiny/short Buffers (<4 bytes) do not crash and default to jpeg', async () => {
  for (const bytes of [[], [0xff], [0xff, 0xd8], [0x89, 0x50, 0x4e]]) {
    const buf = Buffer.from(bytes);
    const url = await viaReceipt(buf);
    assert.strictEqual(typeof url, 'string');
    assert.strictEqual(url, 'data:image/jpeg;base64,' + buf.toString('base64'));
    // extractReceipts path too
    assert.strictEqual(await viaReceipts(buf), 'data:image/jpeg;base64,' + buf.toString('base64'));
  }
});

test('MIME sniff: a 3-byte JPEG-prefix (0xff 0xd8 0xff) still sniffs jpeg (>=3 branch)', async () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff]);
  assert.strictEqual(await viaReceipt(buf), 'data:image/jpeg;base64,' + buf.toString('base64'));
});

// A RIFF header that claims nothing (too short for the >=12 WEBP check) must not throw and
// must not falsely report webp — falls through to the jpeg default.
test('MIME sniff: short RIFF (<12 bytes) does not false-positive WEBP and does not crash', async () => {
  const buf = Buffer.from('RIFF', 'latin1'); // only 4 bytes
  assert.strictEqual(await viaReceipt(buf), 'data:image/jpeg;base64,' + buf.toString('base64'));
});

// ---- (2) string passthrough is byte-identical (Telegram + PDF/data-URI paths unaffected) ----

test('string passthrough: http(s) URL is byte-identical for both fns', async () => {
  const url = 'https://cdn.example.com/receipts/2026/r-9911.png?sig=abc123&x=1';
  assert.strictEqual(await viaReceipt(url),  url);
  assert.strictEqual(await viaReceipts(url), url);
});

test('string passthrough: an existing data-URI string is passed through unchanged (not re-wrapped)', async () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
        r1 = await viaReceipt(dataUri),
        r2 = await viaReceipts(dataUri);
  assert.strictEqual(r1, dataUri);
  assert.strictEqual(r2, dataUri);
  // guard against accidental double-wrapping like data:...;base64,data:...
  assert.ok(!/base64,data:/.test(r1) && !/base64,data:/.test(r2));
});

// ---- (4) non-Buffer / non-string inputs behave as before (pass through, no NEW throw) ----
// The fix's guard is Buffer.isBuffer(image) ? ...data-URI : image — so anything not a Buffer
// (number, null, object) reaches image_url.url unchanged, exactly as pre-fix. It must not
// newly throw inside toImageUrlArg / bufferImageMime.

test('non-Buffer/non-string inputs pass through unchanged (no new throw): null', async () => {
  assert.strictEqual(await viaReceipt(null),  null);
  assert.strictEqual(await viaReceipts(null), null);
});

test('non-Buffer/non-string inputs pass through unchanged (no new throw): number', async () => {
  assert.strictEqual(await viaReceipt(42),  42);
  assert.strictEqual(await viaReceipts(42), 42);
});

test('non-Buffer/non-string inputs pass through unchanged (no new throw): plain object', async () => {
  const obj = { not: 'a buffer' };
  // deepStrictEqual (not reference) because the stub serialises the payload through
  // JSON.stringify/parse; the fix leaves the object untouched (no data-URI wrapping).
  assert.deepStrictEqual(await viaReceipt(obj),  obj);
  assert.deepStrictEqual(await viaReceipts(obj), obj);
});

// A {"type":"Buffer",...}-shaped POJO (a Buffer that already got JSON-serialised) is NOT a real
// Buffer, so Buffer.isBuffer is false and it passes through as-is. This documents that the fix
// addresses raw Buffers at the source, not already-corrupted payloads (which is correct scope).
test('an already-serialised {type:"Buffer"} POJO is not treated as a Buffer (passes through)', async () => {
  const pojo = { type: 'Buffer', data: [0x89, 0x50, 0x4e, 0x47] };
  const url = await viaReceipt(pojo);
  // Untouched — Buffer.isBuffer is false, so no data-URI wrapping. (deepStrictEqual because
  // the stub round-trips the payload through JSON.) Notably it did NOT throw in the sniff.
  assert.deepStrictEqual(url, pojo);
});

// ---- (4) safety: well-formed base64, no JSON-payload injection, moderately large Buffer ----

test('data-URI base64 is well-formed and round-trips back to the original bytes', async () => {
  // Bytes chosen to include values that would be unsafe if not base64-encoded: quotes,
  // braces, backslash, newline, high bytes.
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x22, 0x7b, 0x7d, 0x5c, 0x0a, 0xff, 0xfe, 0x00]);
  const url = await viaReceipt(raw);
  const m = /^data:image\/png;base64,(.+)$/.exec(url);
  assert.ok(m, 'well-formed data:image/png;base64, prefix');
  const b64 = m[1];
  assert.match(b64, /^[A-Za-z0-9+/]+={0,2}$/, 'strict base64 alphabet only — no raw injection chars');
  assert.deepStrictEqual(Buffer.from(b64, 'base64'), raw, 'round-trips to original bytes');
});

test('the image_url.url is a plain string field in the JSON payload (no structural injection)', async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x22, 0x7d, 0x5d]); // includes " } ]
  const s = stubGroq(OBJ_REPLY);
  try {
    await extractReceipt(raw, SPEC);
    const body = s.sent();
    const part = body.messages[1].content.find(p => p.type === 'image_url');
    assert.strictEqual(typeof part.image_url.url, 'string');
    // The whole thing survived JSON.stringify → JSON.parse in the stub intact, proving the
    // data-URI is just a string field and did not break out of the JSON structure.
    assert.strictEqual(part.image_url.url, 'data:image/png;base64,' + raw.toString('base64'));
  } finally { s.restore(); }
});

test('a moderately large Buffer (~512 KiB) converts without crashing', async () => {
  const big = Buffer.alloc(512 * 1024, 0x41); // fill with 'A'
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47; // PNG magic prefix
  const url = await viaReceipt(big);
  assert.ok(url.startsWith('data:image/png;base64,'));
  assert.strictEqual(url, 'data:image/png;base64,' + big.toString('base64'));
});
