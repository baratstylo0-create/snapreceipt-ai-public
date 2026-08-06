'use strict';
// #1 PDF ingestion. OWNER: Barat. Pure decode: NO Groq, NO DB, NO FieldSpec.
// Rasterizes untrusted PDF bytes to PNG page buffers with WASM PDFium
// (@hyzyla/pdfium, ADR-014); encodes RGBA -> PNG via node:zlib (no sharp — see
// ADR-014's zero-added-native-deps rationale). In-memory only, no temp files.
const zlib = require('node:zlib');

class PdfError extends Error {
  constructor(code) { super(code); this.name = 'PdfError'; this.code = code; }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

// data: RGBA bytes, length === width*height*4
function rgbaToPng(data, width, height) {
  const bpp = 4, rowLen = width * bpp;
  const rawImg = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    rawImg[y * (rowLen + 1)] = 0; // filter: none
    data.copy(rawImg, y * (rowLen + 1) + 1, y * rowLen, y * rowLen + rowLen);
  }
  const idat = zlib.deflateSync(rawImg);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit depth, colour type 6 (RGBA)
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const { cfg } = require('./config');

// Cache the WASM library init across calls (expensive; stateless per-doc after init).
let _libPromise = null;
async function getLibrary() {
  if (!_libPromise) {
    const { PDFiumLibrary } = await import('@hyzyla/pdfium'); // ESM lib, dynamic import from CJS
    _libPromise = PDFiumLibrary.init();
  }
  return _libPromise;
}

// rasterizePdf(pdfBuffer, { maxPages, dpi }) -> { pages: Buffer[], truncated: boolean }
// Frozen interface (ARCHITECTURE §2/§3.1 pattern, ADR-014). Throws a typed PdfError —
// never a raw library error (SOP §7.2/§7.3, untrusted file input).
async function rasterizePdf(pdfBuffer, { maxPages = cfg.MASS_MAX_IMAGES, dpi = cfg.PDF_RENDER_DPI } = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) throw new PdfError('CORRUPT');
  if (pdfBuffer.length > cfg.PDF_MAX_BYTES) throw new PdfError('TOO_LARGE');
  if (pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('NOT_PDF');

  const library = await getLibrary();
  let doc;
  try {
    doc = await library.loadDocument(pdfBuffer);
  } catch (e) {
    // Confirmed live (Task 0) against @hyzyla/pdfium: an encrypted/password-protected
    // PDF throws "Password required or incorrect password"; a corrupt/truncated PDF
    // (which already passed our own %PDF- magic check) throws the generic "File not
    // in PDF format or corrupted" -- PDFium does not distinguish corrupt vs not-a-PDF
    // itself, so NOT_PDF is caught entirely by our magic-byte check above.
    throw new PdfError(/password/i.test(e && e.message) ? 'ENCRYPTED' : 'CORRUPT');
  }
  try {
    const all = [...doc.pages()];
    if (all.length === 0) throw new PdfError('EMPTY');
    const truncated = all.length > maxPages;
    const take = all.slice(0, maxPages);
    const scale = dpi / 72;
    const pages = [];
    for (const page of take) {
      // Render-dimension bomb guard: an untrusted PDF can declare a huge MediaBox
      // (e.g. 20000x20000pt) that forces PDFium to allocate a multi-GB bitmap. The
      // byte/page/DPI caps don't cover this — cap the rendered pixel area and reject
      // with a typed PdfError BEFORE page.render (SOP §7.3, untrusted-input DoS).
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const wpx = Math.ceil(originalWidth * scale);
      const hpx = Math.ceil(originalHeight * scale);
      if (!(wpx > 0) || !(hpx > 0) || wpx * hpx > cfg.PDF_MAX_RENDER_PIXELS) throw new PdfError('TOO_LARGE');
      let img;
      try {
        img = await page.render({
          scale,
          render: ({ data, width, height }) => rgbaToPng(Buffer.from(data), width, height),
        });
      } catch (e) {
        // Never let a raw pdfium/WASM error escape (breaks the typed-PdfError contract
        // and would surface library internals as a 500 in Task 7 — SOP §7.2).
        if (e instanceof PdfError) throw e;
        throw new PdfError('CORRUPT');
      }
      pages.push(Buffer.from(img.data));
    }
    return { pages, truncated };
  } finally {
    try { doc.destroy(); } catch { /* ignore teardown errors */ }
  }
}

module.exports = { rasterizePdf, rgbaToPng, PdfError };
