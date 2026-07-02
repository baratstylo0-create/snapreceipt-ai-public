'use strict';
// Tier-2 QA regressions for #1 PDF ingestion (PR #38, feature/barat-p4-pdf).
// Adversarial pass over lib/pdf.js rasterizePdf. Some tests are CHARACTERIZATION tests
// that LOCK CURRENT (buggy) behaviour so a fix is visible as a diff; each is marked.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { rasterizePdf, PdfError } = require('../lib/pdf');
const { cfg } = require('../lib/config');

const fx = f => fs.readFileSync(`tests/fixtures/pdf/${f}`);

// ---------------------------------------------------------------------------
// Charter 1: magic-byte + size-cap ordering + bypass shapes
// ---------------------------------------------------------------------------

test('QA: size cap is enforced BEFORE magic-byte + parse (21MB of zeros, no %PDF-, still TOO_LARGE)', async () => {
  // If the magic check ran first this all-zero buffer would be NOT_PDF; if parse ran it would
  // be CORRUPT. TOO_LARGE proves the byte cap is the very first gate (lib/pdf.js:62 precedes 63/65).
  const bigNoMagic = Buffer.alloc(cfg.PDF_MAX_BYTES + 1);
  await assert.rejects(() => rasterizePdf(bigNoMagic),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
});

test('QA: a valid-magic 21MB buffer rejects TOO_LARGE without invoking pdfium', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(cfg.PDF_MAX_BYTES)]);
  const t0 = Date.now();
  await assert.rejects(() => rasterizePdf(big),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
  // Sanity: the reject is effectively immediate (no WASM parse of 21MB).
  assert.ok(Date.now() - t0 < 500, 'oversized reject should be immediate, not after a parse');
});

test('QA: buffer exactly AT the cap boundary is accepted past the size gate (cap is > not >=)', async () => {
  const atCap = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(cfg.PDF_MAX_BYTES - 5)]);
  assert.strictEqual(atCap.length, cfg.PDF_MAX_BYTES);
  // It passes the size + magic gate and is handed to pdfium, which rejects the garbage body as CORRUPT.
  await assert.rejects(() => rasterizePdf(atCap),
    e => e instanceof PdfError && e.code === 'CORRUPT');
});

test('QA: %PDF- magic + garbage body -> CORRUPT (not a raw pdfium error)', async () => {
  const garbage = Buffer.concat([Buffer.from('%PDF-'), Buffer.from('total garbage not a pdf')]);
  await assert.rejects(() => rasterizePdf(garbage),
    e => e instanceof PdfError && e.code === 'CORRUPT');
});

test('QA: non-Buffer / null / undefined / empty inputs all reject as PdfError (no TypeError escapes)', async () => {
  for (const bad of ['%PDF-1.4 a string', null, undefined, Buffer.alloc(0), 12345, {}]) {
    await rasterizePdf(bad).then(
      () => assert.fail(`input ${String(bad)} should have rejected`),
      e => assert.ok(e instanceof PdfError, `input ${String(bad)} leaked a non-PdfError: ${e && e.name}`));
  }
});

// ---------------------------------------------------------------------------
// Charter 3: EMPTY path + PdfError contract on a zero-page doc
// ---------------------------------------------------------------------------

test('QA: a valid zero-page PDF rejects as PdfError EMPTY', async () => {
  await assert.rejects(() => rasterizePdf(fx('zero-page.pdf')),
    e => e instanceof PdfError && e.code === 'EMPTY');
});

test('QA: PdfError.message never carries library/file internals (message === code)', async () => {
  for (const f of ['not-a-pdf.bin', 'corrupt.pdf', 'encrypted.pdf']) {
    await rasterizePdf(fx(f)).then(
      () => assert.fail(`${f} should reject`),
      e => {
        assert.ok(e instanceof PdfError, `${f} leaked non-PdfError`);
        // message is exactly the stable code — no "Password required", no path, no stack text.
        assert.match(e.message, /^(CORRUPT|TOO_LARGE|NOT_PDF|ENCRYPTED|EMPTY)$/,
          `${f} PdfError.message leaked: ${JSON.stringify(e.message)}`);
      });
  }
});

// ---------------------------------------------------------------------------
// Charter 2 + 3: RENDER-DIMENSION BOMB (FINDING — Barat's to fix)
// A ~470-byte PDF declaring a 20000x20000pt MediaBox forces pdfium to attempt a
// multi-GB bitmap. rasterizePdf caps bytes/pages/DPI but NOT rendered pixel dims.
// Two defects observed, LOCKED here as characterization tests:
//   (A) unbounded render allocation is attempted (untrusted-input DoS)
//   (B) the render-loop error escapes as a RAW Error, not a typed PdfError
//       (violates the lib/pdf.js:58-59 contract; Task 7's PdfError.code->HTTP-status
//        mapping will fall through to a 500).
// When Barat adds a pixel-dimension cap that throws PdfError (e.g. 'TOO_LARGE'/'CORRUPT'),
// FLIP the assertions below (see the inline note) — that is the intended green state.
// ---------------------------------------------------------------------------

test('QA FINDING (render bomb): tiny PDF w/ huge MediaBox is NOT capped and leaks a raw non-PdfError', async () => {
  let threw = null;
  try {
    await rasterizePdf(fx('huge-mediabox.pdf'));
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected the render bomb to throw (no page-size cap exists)');

  // CURRENT (buggy) behaviour — characterization lock:
  //   the render loop has no PdfError-mapping catch, so a raw library Error escapes.
  assert.strictEqual(threw instanceof PdfError, false,
    'CHARACTERIZATION: render-loop error currently escapes as a raw Error, not PdfError. ' +
    'If this now fails, Barat added the missing catch/pixel-cap — flip this to `true` and assert e.code.');
  assert.strictEqual(threw.name, 'Error');
  // The raw message is a pdfium/WASM internal — exactly the kind of string SOP §7.2 forbids surfacing.
  assert.match(threw.message, /memory|bitmap|allocate/i,
    'CHARACTERIZATION: raw pdfium allocation error text is exposed by rasterizePdf');
});
