'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// NOTE (deviation from the plan's literal snippet): lib/config.js exports { cfg,
// assertConfig }, not flat top-level constants -- every other module in the repo
// consumes it as `const { cfg } = require('./config')`. Matching that real shape here.
const { cfg } = require('../lib/config');

test('config exposes PDF knobs with sane defaults', () => {
  assert.strictEqual(typeof cfg.PDF_RENDER_DPI, 'number');
  assert.ok(cfg.PDF_RENDER_DPI >= 72);
  assert.strictEqual(typeof cfg.PDF_MAX_BYTES, 'number');
  assert.ok(cfg.PDF_MAX_BYTES > 0);
});

const zlib = require('node:zlib');
const { rgbaToPng, PdfError } = require('../lib/pdf');

test('rgbaToPng emits a valid PNG with correct signature and dimensions', () => {
  // 2x1 image, two opaque pixels (red, green)
  const rgba = Buffer.from([255,0,0,255,  0,255,0,255]);
  const png = rgbaToPng(rgba, 2, 1);
  // PNG signature
  assert.deepStrictEqual(png.subarray(0, 8),
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  // IHDR is the first chunk: bytes 12..16 type 'IHDR', then width/height
  assert.strictEqual(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.strictEqual(png.readUInt32BE(16), 2); // width
  assert.strictEqual(png.readUInt32BE(20), 1); // height
  // IDAT inflates back to filtered scanlines (1 filter byte + 8 data bytes)
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const idatLen = png.readUInt32BE(idatStart - 4);
  const idat = png.subarray(idatStart + 4, idatStart + 4 + idatLen);
  const raw = zlib.inflateSync(idat);
  assert.strictEqual(raw.length, (2 * 4 + 1) * 1); // (width*4 + filterByte) * height
  assert.strictEqual(raw[0], 0); // filter: none
});

test('PdfError carries a stable non-leaky code', () => {
  const e = new PdfError('CORRUPT');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.code, 'CORRUPT');
  assert.strictEqual(e.name, 'PdfError');
});
