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

module.exports = { rgbaToPng, PdfError };
