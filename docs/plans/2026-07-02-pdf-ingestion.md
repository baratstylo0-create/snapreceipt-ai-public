# #1 PDF Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept PDF receipts (digital or scanned, one page or many) on the dashboard upload and via Telegram, rasterize each page to a PNG, and feed the pages through the existing `runBatch` spine to produce expense rows — safely, on untrusted input.

**Architecture:** One new pure-decode module `lib/pdf.js` turns PDF bytes → PNG page buffers using WASM PDFium (`@hyzyla/pdfium`), encoding RGBA→PNG with Node's built-in `zlib` (no `sharp`). Those page buffers are exactly the `images[]` array `lib/massupload.runBatch` (#7) already consumes, so multi-page and multi-receipt-per-page fall out with no new orchestration. Two thin adapters call it: `routes/upload.js` (dashboard, Jeevan) and the Telegram `document` path in `lib/bot.js` (Barat).

**Tech Stack:** Node 22 (native `fetch`/`Buffer`/`zlib`), Express, `@hyzyla/pdfium` (WASM, the one new dep — ADR-014), `node:test`.

**Spec:** `docs/specs/2026-07-02-pdf-ingestion-design.md` · **Decision:** ADR-014 (`docs/DECISIONS.md`).

**Ownership / branches:**
- **Barat** (`feature/barat-p4-pdf`): Task 0–6 (`lib/pdf.js`, `package.json`, Telegram path in `lib/bot.js`, fixtures). Tier-2.
- **Jeevan** (`feature/jeevan-p4-pdf-route`, forks *after* Barat's branch merges): Task 7 (`routes/upload.js`).

**Tier:** Tier-2 (untrusted-file parser + new dep). Independent QA on Barat's branch before merge; independent QA on the route glue before merge.

---

## File Structure

| File | Owner | Responsibility |
|---|---|---|
| `lib/pdf.js` (create) | Barat | `rasterizePdf(buf, opts)` + private `PdfError`, `rgbaToPng`, dynamic-import loader. Pure decode; no Groq, no DB. |
| `lib/config.js` (modify) | Barat | Add `PDF_RENDER_DPI` (150) and `PDF_MAX_BYTES` env-backed constants next to existing `MASS_MAX_IMAGES`. |
| `package.json` (modify) | Barat | Add `@hyzyla/pdfium` dependency (ADR-014). |
| `lib/bot.js` (modify) | Barat | Telegram `document`(PDF) → `rasterizePdf` → one `runBatch` → counts-only reply. |
| `routes/upload.js` (modify) | Jeevan | Detect `%PDF` on the decoded buffer → `rasterizePdf` → `runBatch`; map `PdfError`→status; sanitize. |
| `tests/pdf.test.js` (create) | Barat | Unit tests for `rasterizePdf` + `rgbaToPng`. |
| `tests/bot.pdf.test.js` (create) | Barat | Telegram PDF path tests. |
| `tests/upload.pdf.test.js` (create) | Jeevan | Route PDF-branch tests. |
| `tests/fixtures/pdf/*` (create) | Barat | Small committed fixture PDFs (generated in Task 0). |

**Conventions to follow (read first):** `lib/massupload.js` (`runBatch` signature + `truncated`/`failed[]` shapes, ARCHITECTURE §3.7), `lib/ocr.js` (`extractReceipts`, `assembleExpense`), `lib/bot.js` (existing media-group adapter — mirror its debounce/never-throws style), `routes/upload.js` (existing base64 decode + `failed[].reason` sanitization), `lib/config.js` (how `MASS_MAX_IMAGES` is read from env). All model/config knobs come from env (ARCHITECTURE §3.5).

---

## Task 0: Spike — confirm PDFium interop + RGBA→PNG (Barat, throwaway)

> **⚡ PRE-VALIDATED by J1 (in-session 2026-07-02) — the risky half is already proven.** J1 ran this exact
> spike on generated native PDFs: dynamic `import()` from CJS ✓, `PDFiumLibrary.init()` + `page.render`
> → RGBA ✓, the `node:zlib` encoder → **legible** PNG ✓ (625×416px @ 150 DPI), multi-page ✓,
> non-PDF→throws ✓, `added 1 package` (zero-dep) ✓. See ADR-014 "Spike result". **The fallback (C) is not
> needed.** Barat's Task 0 therefore reduces to: (a) `npm install @hyzyla/pdfium` + commit; (b) **generate
> the fixtures that need external tools** (`encrypted.pdf` via `qpdf`, `scanned.pdf` from an image) plus the
> trivial ones; (c) **confirm the exact `loadDocument` error string for a password-protected PDF** so
> `ENCRYPTED` maps distinctly from `CORRUPT` (Task 3's catch regex). You may skip re-proving the interop —
> go straight to Task 1 once fixtures exist. The spike script below is retained for reference.

**Goal:** De-risk ADR-014 before writing real code: prove dynamic `import()` of the ESM lib works from CommonJS, that `render()` returns raw RGBA, and that a `zlib` PNG encoder yields a valid image. Generate the test fixtures. *(Interop + encoder already proven by J1 — see the note above; the remaining real work is fixtures + the encrypted-error-string check.)*

**Files:**
- Modify: `package.json` (add dep)
- Create (throwaway, NOT committed): `scratch/pdf-spike.js`
- Create (committed): `tests/fixtures/pdf/` fixtures

- [ ] **Step 1: Install the dependency**

Run: `npm install @hyzyla/pdfium`
Expected: added to `package.json` dependencies; `npm test` still green (275).

- [ ] **Step 2: Write the spike script** (`scratch/pdf-spike.js`)

```js
// Throwaway. Proves: dynamic import from CJS, render→RGBA, zlib PNG encode.
const fs = require('node:fs');
const zlib = require('node:zlib');

// Minimal RGBA->PNG (single IDAT, filter 0 per scanline). Same algo we'll port to lib/pdf.js.
function rgbaToPng(data, width, height) {
  const bpp = 4, rowLen = width * bpp;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: none
    data.copy(raw, y * (rowLen + 1) + 1, y * rowLen, y * rowLen + rowLen);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

(async () => {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium'); // dynamic import from CJS
  const lib = await PDFiumLibrary.init();
  const doc = await lib.loadDocument(fs.readFileSync('tests/fixtures/pdf/one-page.pdf'));
  let n = 0;
  for (const page of doc.pages()) {
    const img = await page.render({
      scale: 150 / 72,
      render: ({ data, width, height }) => rgbaToPng(Buffer.from(data), width, height),
    });
    fs.writeFileSync(`scratch/page-${n++}.png`, Buffer.from(img.data));
  }
  console.log('pages rendered:', n);
  doc.destroy(); lib.destroy();
})().catch(e => { console.error('SPIKE FAIL:', e); process.exit(1); });
```

- [ ] **Step 3: Generate committed fixtures** under `tests/fixtures/pdf/`

Generate these (use any local tool — Chrome "print to PDF", `qpdf`, ImageMagick — they are committed, not code):
- `one-page.pdf` — a 1-page native PDF with visible text.
- `three-page.pdf` — 3 native pages.
- `scanned.pdf` — a PDF whose page is a single embedded raster image (export an image to PDF).
- `encrypted.pdf` — password-protected (`qpdf --encrypt pw pw 256 -- one-page.pdf encrypted.pdf`).
- `eleven-page.pdf` — 11 native pages (exceeds default cap of 10).
- `not-a-pdf.bin` — arbitrary non-PDF bytes (e.g. copy a small PNG).
- `corrupt.pdf` — `one-page.pdf` truncated to its first ~200 bytes.

- [ ] **Step 4: Run the spike**

Run: `node scratch/pdf-spike.js`
Expected: prints `pages rendered: 1`; `scratch/page-0.png` opens as a legible image of the receipt.
**If dynamic import throws, or `render` has no `{data,width,height}`, or the PNG is garbage → STOP.** Trigger ADR-014 fallback (pdf.js + `@napi-rs/canvas`); report to Owner before proceeding.

- [ ] **Step 5: Clean up the spike**

Run: `rm -rf scratch/` (do NOT commit the spike or the `scratch/` PNGs; the `rgbaToPng`/`crc32` code moves into `lib/pdf.js` in Task 2). Commit only `package.json` + the fixtures:

```bash
git add package.json tests/fixtures/pdf/
git commit -m "chore(#1): add @hyzyla/pdfium (ADR-014) + PDF test fixtures; spike confirms CJS interop + zlib PNG"
```

---

## Task 1: Config knobs (Barat)

**Files:**
- Modify: `lib/config.js` (add two constants beside `MASS_MAX_IMAGES`)
- Test: `tests/pdf.test.js` (create)

- [ ] **Step 1: Write the failing test** (`tests/pdf.test.js`)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../lib/config');

test('config exposes PDF knobs with sane defaults', () => {
  assert.strictEqual(typeof config.PDF_RENDER_DPI, 'number');
  assert.ok(config.PDF_RENDER_DPI >= 72);
  assert.strictEqual(typeof config.PDF_MAX_BYTES, 'number');
  assert.ok(config.PDF_MAX_BYTES > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pdf.test.js`
Expected: FAIL (`PDF_RENDER_DPI` is undefined).

- [ ] **Step 3: Add the constants** in `lib/config.js` (match the existing `MASS_MAX_IMAGES` env-read pattern; place next to it and add to the exports)

```js
const PDF_RENDER_DPI = Number(process.env.PDF_RENDER_DPI) || 150;
const PDF_MAX_BYTES  = Number(process.env.PDF_MAX_BYTES)  || 20 * 1024 * 1024; // 20 MB
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pdf.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js tests/pdf.test.js
git commit -m "feat(#1): PDF_RENDER_DPI + PDF_MAX_BYTES config knobs"
```

---

## Task 2: `rgbaToPng` encoder + `PdfError` (Barat)

**Files:**
- Create: `lib/pdf.js`
- Test: `tests/pdf.test.js` (append)

- [ ] **Step 1: Write the failing test** (append to `tests/pdf.test.js`)

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pdf.test.js`
Expected: FAIL (`Cannot find module '../lib/pdf'`).

- [ ] **Step 3: Create `lib/pdf.js` with the encoder + error type** (port `rgbaToPng`/`crc32` verbatim from the Task 0 spike; the file's rasterize function comes in Task 3)

```js
// lib/pdf.js  [BARAT] — PDF -> PNG page buffers. Pure decode: no Groq, no DB, no FieldSpec.
// Rasterizes with WASM PDFium (@hyzyla/pdfium, ADR-014); encodes RGBA->PNG via node:zlib (no sharp).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pdf.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pdf.js tests/pdf.test.js
git commit -m "feat(#1): RGBA->PNG encoder (node:zlib) + PdfError type in lib/pdf.js"
```

---

## Task 3: `rasterizePdf` happy path — native + scanned, multi-page (Barat)

**Files:**
- Modify: `lib/pdf.js` (add `rasterizePdf` + a cached PDFium loader)
- Test: `tests/pdf.test.js` (append)

- [ ] **Step 1: Write the failing test** (append)

```js
const fs = require('node:fs');
const { rasterizePdf } = require('../lib/pdf');
const fx = f => fs.readFileSync(`tests/fixtures/pdf/${f}`);
const PNG_SIG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

test('rasterizePdf renders a 1-page native PDF to one PNG', async () => {
  const { pages, truncated } = await rasterizePdf(fx('one-page.pdf'));
  assert.strictEqual(pages.length, 1);
  assert.deepStrictEqual(pages[0].subarray(0, 8), PNG_SIG);
  assert.strictEqual(truncated, false);
});

test('rasterizePdf renders every page of a multi-page PDF', async () => {
  const { pages, truncated } = await rasterizePdf(fx('three-page.pdf'));
  assert.strictEqual(pages.length, 3);
  assert.ok(pages.every(p => p.subarray(0, 8).equals(PNG_SIG)));
  assert.strictEqual(truncated, false);
});

test('rasterizePdf renders a scanned/image-only PDF (same path)', async () => {
  const { pages } = await rasterizePdf(fx('scanned.pdf'));
  assert.ok(pages.length >= 1);
  assert.deepStrictEqual(pages[0].subarray(0, 8), PNG_SIG);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pdf.test.js`
Expected: FAIL (`rasterizePdf is not a function`).

- [ ] **Step 3: Implement `rasterizePdf`** in `lib/pdf.js` (add above `module.exports`; use the exact `@hyzyla/pdfium` API confirmed in Task 0)

```js
const { PDF_RENDER_DPI, PDF_MAX_BYTES, MASS_MAX_IMAGES } = require('./config');

// Cache the WASM library init across calls (it's expensive; the lib is stateless per-doc).
let _libPromise = null;
async function getLibrary() {
  if (!_libPromise) {
    const { PDFiumLibrary } = await import('@hyzyla/pdfium'); // ESM lib, dynamic import from CJS
    _libPromise = PDFiumLibrary.init();
  }
  return _libPromise;
}

async function rasterizePdf(pdfBuffer, { maxPages = MASS_MAX_IMAGES, dpi = PDF_RENDER_DPI } = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) throw new PdfError('CORRUPT');
  if (pdfBuffer.length > PDF_MAX_BYTES) throw new PdfError('TOO_LARGE');
  if (pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('NOT_PDF');

  const library = await getLibrary();
  let doc;
  try {
    doc = await library.loadDocument(pdfBuffer);
  } catch (e) {
    throw new PdfError(/password|encrypt/i.test(e && e.message) ? 'ENCRYPTED' : 'CORRUPT');
  }
  try {
    const all = [...doc.pages()];
    if (all.length === 0) throw new PdfError('EMPTY');
    const truncated = all.length > maxPages;
    const take = all.slice(0, maxPages);
    const pages = [];
    for (const page of take) {
      const img = await page.render({
        scale: dpi / 72,
        render: ({ data, width, height }) => rgbaToPng(Buffer.from(data), width, height),
      });
      pages.push(Buffer.from(img.data));
    }
    return { pages, truncated };
  } finally {
    try { doc.destroy(); } catch { /* ignore teardown errors */ }
  }
}
```

Update exports: `module.exports = { rasterizePdf, rgbaToPng, PdfError };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pdf.test.js`
Expected: PASS (all three render tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/pdf.js tests/pdf.test.js
git commit -m "feat(#1): rasterizePdf renders native+scanned+multi-page PDFs to PNG buffers"
```

---

## Task 4: `rasterizePdf` caps + error contract (Barat)

**Files:**
- Test: `tests/pdf.test.js` (append). Implementation already written in Task 3 — this task proves the guards and adds the regression locks.

- [ ] **Step 1: Write the failing tests** (append)

```js
test('rasterizePdf caps at maxPages and flags truncated', async () => {
  const { pages, truncated } = await rasterizePdf(fx('eleven-page.pdf')); // default cap 10
  assert.strictEqual(pages.length, 10);
  assert.strictEqual(truncated, true);
});

test('rasterizePdf rejects oversized buffers BEFORE parsing', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(21 * 1024 * 1024)]);
  await assert.rejects(() => rasterizePdf(big), e => e instanceof PdfError && e.code === 'TOO_LARGE');
});

test('rasterizePdf rejects non-PDF bytes', async () => {
  await assert.rejects(() => rasterizePdf(fx('not-a-pdf.bin')),
    e => e.code === 'NOT_PDF');
});

test('rasterizePdf rejects a corrupt/truncated PDF without leaking internals', async () => {
  await assert.rejects(() => rasterizePdf(fx('corrupt.pdf')),
    e => e instanceof PdfError && e.code === 'CORRUPT');
});

test('rasterizePdf rejects an encrypted PDF as ENCRYPTED', async () => {
  await assert.rejects(() => rasterizePdf(fx('encrypted.pdf')),
    e => e instanceof PdfError && e.code === 'ENCRYPTED');
});

test('rasterizePdf never throws a raw library error (only PdfError)', async () => {
  for (const f of ['not-a-pdf.bin', 'corrupt.pdf', 'encrypted.pdf']) {
    await rasterizePdf(fx(f)).then(
      () => assert.fail(`${f} should have rejected`),
      e => assert.strictEqual(e.name, 'PdfError', `${f} leaked a non-PdfError`));
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/pdf.test.js`
Expected: PASS. If `encrypted.pdf` surfaces as `CORRUPT` not `ENCRYPTED`, adjust the message regex in `loadDocument`'s catch (Task 3) to match `@hyzyla/pdfium`'s actual encrypted-doc error text (confirm the exact string during the run), then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/pdf.test.js lib/pdf.js
git commit -m "test(#1): rasterizePdf caps + PdfError contract (encrypted/corrupt/not-pdf/too-large), never leaks"
```

---

## Task 5: Telegram PDF document path (Barat)

**Files:**
- Modify: `lib/bot.js` (add a `document`-is-PDF branch in `handleUpdate`, before the single-photo path; mirror the existing media-group adapter's never-throws + counts-only-reply style)
- Test: `tests/bot.pdf.test.js` (create)

- [ ] **Step 1: Write the failing test** (`tests/bot.pdf.test.js`)

Follow the DI style of `tests/bot.batch.test.js` (inject `runBatch`, `extractReceipts`, `assembleExpense`, `getFieldSpec`, `tgSend`, and a `tgFileUrl`/download dep + a `rasterizePdf` dep). Assert:

```js
// 1. A PDF document update → rasterizePdf called once → runBatch called once with the pages →
//    exactly one reply, containing counts only.
// 2. The reply NEVER contains failed[].reason text: plant a fake secret in a failed[] entry and
//    assert it is absent from the sent message (regression like bot.batch's planted-secret test).
// 3. rasterizePdf throwing PdfError('ENCRYPTED') → a single safe "couldn't read that PDF" reply,
//    handleUpdate does NOT throw, runBatch NOT called.
// 4. A normal single photo still goes through expenseFromPhoto; rasterizePdf/runBatch NOT called.
```

Write these as concrete `node:test` cases using injected fakes (no network). Use a fake PDF `document` update shape: `{ message: { chat:{id:1}, document:{ file_id:'F', mime_type:'application/pdf', file_name:'r.pdf' } } }`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/bot.pdf.test.js`
Expected: FAIL (no PDF branch; photo path or no-op).

- [ ] **Step 3: Implement the branch** in `lib/bot.js` `handleUpdate` — detect `message.document` whose `mime_type === 'application/pdf'` (or `file_name` ends `.pdf`); resolve `file_id`→URL→download buffer (reuse the existing `hreq`/`tgFileUrl` helpers), `await rasterizePdf(buf)` inside try/catch, then `await runBatch(pages, fieldSpec, { extractReceipts, assembleExpense, meta:{ fileId:null } })`, then send ONE counts-only summary (reuse the media-group summary formatter — counts + truncated only, never `failed[].reason`). On `PdfError` or any throw: send one safe generic message, never rethrow. Keep the single-photo and media-group branches unchanged and checked in the existing order.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/bot.pdf.test.js`
Expected: PASS. Then full suite: `npm test` — expected all green (275 + new).

- [ ] **Step 5: Commit**

```bash
git add lib/bot.js tests/bot.pdf.test.js
git commit -m "feat(#1): Telegram PDF document -> rasterizePdf -> runBatch, counts-only reply, never leaks"
```

---

## Task 6: Barat branch wrap — WORKLOG + push + PR (Barat)

- [ ] **Step 1:** Append a `docs/WORKLOG.md` entry (files, what changed, tests count, what's next, assumptions) per SOP §4.3.
- [ ] **Step 2:** `npm test` — confirm full green; record the number.
- [ ] **Step 3:** Push `feature/barat-p4-pdf`; open PR titled `feat(#1): PDF rasterization (lib/pdf.js) + Telegram PDF path`. Body: link ADR-014 + this plan; note Tier-2 (untrusted parser + new dep) → request independent QA. **Do not self-merge.**

---

## Task 7: Dashboard route glue (Jeevan — AFTER Barat's branch merges)

**Files:**
- Modify: `routes/upload.js` (add a PDF branch to `POST /api/upload`)
- Test: `tests/upload.pdf.test.js` (create)

> Fork `feature/jeevan-p4-pdf-route` off `main` only after Barat's `lib/pdf.js` has merged, so `require('../lib/pdf')` resolves. Run `npm install` first (new dep landed on main).

- [ ] **Step 1: Write the failing test** (`tests/upload.pdf.test.js`)

Mirror the existing `tests/upload.*` DI style (inject `rasterizePdf`, `runBatch`, `getFieldSpec`, auth). Cases:

```js
// 1. { images:[<base64 of a %PDF buffer>] } → detect PDF by magic → rasterizePdf → runBatch →
//    200 with the same batch-summary shape as an image batch + truncated surfaced.
// 2. Oversized PDF (rasterizePdf throws PdfError('TOO_LARGE')) → 413, fixed sanitized message.
// 3. Encrypted/corrupt PDF (PdfError) → 422, fixed sanitized message; response body contains NONE of
//    the library internals — plant a secret via a rejecting rasterizePdf and assert it is absent.
// 4. A normal image upload still takes the existing image path (rasterizePdf NOT called).
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/upload.pdf.test.js`
Expected: FAIL (no PDF branch).

- [ ] **Step 3: Implement the branch** in `routes/upload.js`: after decoding each item to a Buffer (existing lenient base64/data-URI decode), check `buf.subarray(0,5).toString('latin1') === '%PDF-'`. If PDF: `await rasterizePdf(buf)` → `runBatch(pages, fieldSpec, { extractReceipts, assembleExpense })`; wrap in try/catch mapping `PdfError.code`: `TOO_LARGE`→413, `NOT_PDF`/`CORRUPT`/`ENCRYPTED`/`EMPTY`→422, each to a **fixed** message string (no interpolation of error internals). Reuse the existing `failed[].reason` sanitizer for the batch result. Non-PDF items keep the current image path unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/upload.pdf.test.js` then `npm test`
Expected: all green.

- [ ] **Step 5: Commit + WORKLOG + PR**

```bash
git add routes/upload.js tests/upload.pdf.test.js docs/WORKLOG.md
git commit -m "feat(#1): dashboard /api/upload accepts PDFs -> rasterizePdf -> runBatch (sanitized, capped)"
```
Push `feature/jeevan-p4-pdf-route`; open PR; Tier-2 → independent QA before merge.

---

## Self-Review (author check)

- **Spec coverage:** scope D-bounded (Task 3 multi-page + scanned; `runBatch` fan-out gives multi-receipt-per-page) ✓; rasterize via `@hyzyla/pdfium` (Task 0/3) ✓; PNG via zlib not sharp (Task 2) ✓; magic-byte detect (Task 3 guard + Task 7 route) ✓; two caps (Task 3/4) ✓; typed `PdfError` + sanitized, no-leak (Task 4/5/7) ✓; both surfaces (Task 5 Telegram, Task 7 dashboard) ✓; env knobs (Task 1) ✓; Tier-2 QA both branches (Task 6/7) ✓; no temp files / in-memory (Task 3) ✓.
- **Placeholder scan:** Task 5 describes the `handleUpdate` branch in prose rather than a full code block because it must mirror `lib/bot.js`'s existing media-group adapter (formatter, `hreq`/`tgFileUrl` helpers) whose exact internals live in Barat's file — the executing subagent reads that file first (named in File Structure). This is a deliberate "follow the established pattern" instruction, not a missing detail; the interface it must call (`rasterizePdf`, `runBatch`) is fully specified. Same for Task 7's route branch (mirror existing decode/sanitize).
- **Type consistency:** `rasterizePdf(buffer, {maxPages,dpi}) → {pages:Buffer[],truncated}`, `PdfError.code ∈ {ENCRYPTED,CORRUPT,EMPTY,NOT_PDF,TOO_LARGE}`, `rgbaToPng(data,width,height)` — identical across Tasks 2–7 and the spec. ✓
