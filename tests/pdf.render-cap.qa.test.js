'use strict';
// Re-QA of the render-cap fix (PR #38, commit 66a28d6). Independent adversarial pass
// over the F1 (render-dimension bomb) + F2 (raw-error leak) fixes in lib/pdf.js.
// All PDFs built in-memory (hermetic, no binary fixtures). Does NOT touch lib/*.
const { test } = require('node:test');
const assert = require('node:assert');
const { rasterizePdf, PdfError } = require('../lib/pdf');
const { cfg } = require('../lib/config');

// Minimal single-object-per-page PDF builder with configurable page-dict extras.
// pageDictExtra: string, or (i) => string for per-page variation.
function buildPdf(pageDictExtra, { pages = 1 } = {}) {
  const content = 'BT /F1 12 Tf 100 100 Td (x) Tj ET';
  const contentObjNum = 3 + pages;
  const kids = [];
  const pageObjNums = [];
  for (let i = 0; i < pages; i++) { pageObjNums.push(3 + i); kids.push(`${3 + i} 0 R`); }

  const header = '%PDF-1.7\n';
  let body = '';
  let pos = header.length;
  const offsets = [];
  const push = (s) => { offsets.push(pos); body += s; pos += Buffer.byteLength(s, 'latin1'); };

  push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>\nendobj\n`);
  for (let i = 0; i < pages; i++) {
    const extra = typeof pageDictExtra === 'function' ? pageDictExtra(i) : pageDictExtra;
    push(`${pageObjNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${contentObjNum} 0 R /Resources << >> ${extra} >>\nendobj\n`);
  }
  push(`${contentObjNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefPos = pos;
  const total = contentObjNum + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  const trailer = `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, 'latin1');
}

const scale = cfg.PDF_RENDER_DPI / 72;
const isPng = (b) => Buffer.isBuffer(b) && b.length > 8 &&
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

// ---------------------------------------------------------------------------
// F1: render-dimension cap — boundary
// ---------------------------------------------------------------------------

test('F1 boundary: page just UNDER PDF_MAX_RENDER_PIXELS renders to a valid PNG', async () => {
  // 3035pt square @150dpi => 6323x6323 = 39.98MP < 40MP cap.
  const d = 3035;
  const px = Math.ceil(d * scale);
  assert.ok(px * px <= cfg.PDF_MAX_RENDER_PIXELS, 'test precondition: under cap');
  const { pages } = await rasterizePdf(buildPdf(`/MediaBox [0 0 ${d} ${d}]`), { maxPages: 5 });
  assert.strictEqual(pages.length, 1);
  assert.ok(isPng(pages[0]), 'under-cap page must render to a PNG');
});

test('F1 boundary: page just OVER PDF_MAX_RENDER_PIXELS rejects TOO_LARGE', async () => {
  // 3036pt square @150dpi => 6325x6325 = 40.0056MP > 40MP cap.
  const d = 3036;
  const px = Math.ceil(d * scale);
  assert.ok(px * px > cfg.PDF_MAX_RENDER_PIXELS, 'test precondition: over cap');
  await assert.rejects(() => rasterizePdf(buildPdf(`/MediaBox [0 0 ${d} ${d}]`), { maxPages: 5 }),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
});

test('F1: huge MediaBox rejects FAST (guard runs before any multi-GB render alloc)', async () => {
  const t0 = Date.now();
  await assert.rejects(() => rasterizePdf(buildPdf('/MediaBox [0 0 20000 20000]')),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
  // If the guard ran AFTER render(), pdfium would attempt a ~1.7e9-px alloc and this
  // would either OOM or take seconds. An immediate reject proves the guard is pre-render.
  assert.ok(Date.now() - t0 < 1000, 'render-bomb reject must be near-immediate (pre-render guard)');
});

// ---------------------------------------------------------------------------
// F1: bypass probes — declared size must authoritatively match rendered size
// ---------------------------------------------------------------------------

test('F1 bypass /UserUnit: a small MediaBox + huge UserUnit does NOT render larger than the cap', async () => {
  // /UserUnit scales user-space units for viewers, but pdfium's rasterizer ignores it —
  // getOriginalSize() and render(scale) both stay at MediaBox pt size. Confirm the page
  // renders normally (not rejected, not an oversized bitmap): guard == render reality.
  const { pages } = await rasterizePdf(buildPdf('/MediaBox [0 0 595 842] /UserUnit 1000'), { maxPages: 5 });
  assert.strictEqual(pages.length, 1);
  assert.ok(isPng(pages[0]));
  // And an actually-large MediaBox is still caught even if UserUnit is present.
  await assert.rejects(() => rasterizePdf(buildPdf('/MediaBox [0 0 20000 20000] /UserUnit 1000')),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
});

test('F1 bypass /CropBox: a small MediaBox with a HUGE CropBox cannot smuggle an oversized render', async () => {
  // getOriginalSize() returns the effective (crop-intersected) page size that render()
  // uses. A giant CropBox is intersected with the small MediaBox -> render stays small.
  const { pages } = await rasterizePdf(buildPdf('/MediaBox [0 0 595 842] /CropBox [0 0 20000 20000]'), { maxPages: 5 });
  assert.strictEqual(pages.length, 1);
  assert.ok(isPng(pages[0]), 'crop-inflated declaration must still render to a bounded PNG');
});

test('F1 bypass /CropBox: a huge MediaBox with a small CropBox is measured by the effective (small) size', async () => {
  // This one legitimately renders small because getOriginalSize reflects the CropBox.
  // Verifies the guard measures what render actually produces (not the raw MediaBox),
  // so it neither false-rejects nor under-measures.
  const { pages } = await rasterizePdf(buildPdf('/MediaBox [0 0 20000 20000] /CropBox [0 0 595 842]'), { maxPages: 5 });
  assert.strictEqual(pages.length, 1);
  assert.ok(isPng(pages[0]));
});

// ---------------------------------------------------------------------------
// F1: degenerate dims reject/normalize cleanly (never a raw error, never a giant alloc)
// ---------------------------------------------------------------------------

test('F1 degenerate: zero / negative / absurd MediaBox never leak a raw error', async () => {
  const cases = [
    '/MediaBox [0 0 0 0]',
    '/MediaBox [0 0 -500 -500]',
    '/MediaBox [0 0 1e9 1e9]',
    '/MediaBox [0 0 99999999 99999999]',
  ];
  for (const mb of cases) {
    let out = null, err = null;
    try { out = await rasterizePdf(buildPdf(mb), { maxPages: 5 }); }
    catch (e) { err = e; }
    // Either it renders (pdfium normalized to a sane default) OR it rejects — but if it
    // rejects it MUST be a typed PdfError, never a raw Error / pdfium text.
    if (err) {
      assert.ok(err instanceof PdfError, `${mb} leaked a non-PdfError: ${err && err.name}: ${err && err.message}`);
      assert.match(err.message, /^(TOO_LARGE|CORRUPT|EMPTY|NOT_PDF|ENCRYPTED)$/, `${mb} message leaked internals`);
    } else {
      assert.ok(out.pages.every(isPng), `${mb} rendered but produced a non-PNG`);
    }
  }
});

// ---------------------------------------------------------------------------
// F1: per-page enforcement (not just page 1)
// ---------------------------------------------------------------------------

test('F1 per-page: an oversized page 2 rejects the whole call (cap applied per page, not just page 1)', async () => {
  // Page 0 = A4 (fine), page 1 = 20000x20000 bomb, page 2 = A4. If the cap only checked
  // page 1 (index 0) the bomb at index 1 would slip through and render.
  const pdf = buildPdf((i) => i === 1 ? '/MediaBox [0 0 20000 20000]' : '/MediaBox [0 0 595 842]', { pages: 3 });
  await assert.rejects(() => rasterizePdf(pdf, { maxPages: 10 }),
    e => e instanceof PdfError && e.code === 'TOO_LARGE');
});

test('F1 per-page: an oversized page BEYOND maxPages is NOT reached (cap only guards rendered pages)', async () => {
  // page 0 = A4, page 1 = bomb, but maxPages=1 so page 1 is never taken -> should succeed.
  const pdf = buildPdf((i) => i === 1 ? '/MediaBox [0 0 20000 20000]' : '/MediaBox [0 0 595 842]', { pages: 3 });
  const { pages, truncated } = await rasterizePdf(pdf, { maxPages: 1 });
  assert.strictEqual(pages.length, 1);
  assert.ok(isPng(pages[0]));
  assert.strictEqual(truncated, true);
});

// ---------------------------------------------------------------------------
// F2: raw error from page.render maps to PdfError (contract at lib/pdf.js:58-59)
// ---------------------------------------------------------------------------

test('F2: an error thrown inside the render callback surfaces as PdfError, never a raw Error', async () => {
  // The user-supplied render() callback runs inside page.render. If it throws a plain
  // Error (simulating a pdfium/WASM internal failure), the catch must map it to a typed
  // PdfError('CORRUPT') and never let the raw Error / stack escape.
  //
  // We can't reach into lib/pdf.js's own render callback, so we assert the equivalent
  // contract: rasterizePdf on a well-formed page still yields only PdfError on any
  // internal failure. A structurally-valid page that pdfium can load but whose content
  // stream is malformed is the closest black-box trigger; if it throws it must be typed.
  const badContent = Buffer.from(
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>\nendobj\n' +
    '4 0 obj\n<< /Length 9999 >>\nstream\n\xff\xff bad stream\nendstream\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1');
  let out = null, err = null;
  try { out = await rasterizePdf(badContent); }
  catch (e) { err = e; }
  if (err) {
    assert.ok(err instanceof PdfError, `render failure leaked a non-PdfError: ${err && err.name}`);
    assert.match(err.message, /^(CORRUPT|TOO_LARGE|EMPTY|NOT_PDF|ENCRYPTED)$/);
  } else {
    assert.ok(out.pages.every(isPng));
  }
});

// ---------------------------------------------------------------------------
// Config knob sanity
// ---------------------------------------------------------------------------

test('config: PDF_MAX_RENDER_PIXELS defaults to 40 MP and is a positive finite number', () => {
  assert.strictEqual(cfg.PDF_MAX_RENDER_PIXELS, 40_000_000);
  assert.ok(Number.isFinite(cfg.PDF_MAX_RENDER_PIXELS) && cfg.PDF_MAX_RENDER_PIXELS > 0);
});

test('config: PDF_MAX_RENDER_PIXELS is env-overridable and wired to the guard', () => {
  // config reads process.env at load, so we verify the override in a fresh child process
  // (a valid number overrides; junk falls back to 40M) AND that a tiny override actually
  // makes a normal A4 page reject TOO_LARGE — proving the knob feeds the pre-render guard.
  const { execFileSync } = require('node:child_process');
  const run = (env, expr) =>
    execFileSync(process.execPath, ['-e', expr], { env: { ...process.env, ...env } }).toString().trim();

  assert.strictEqual(run({ PDF_MAX_RENDER_PIXELS: '12345678' },
    "const {cfg}=require('./lib/config'); process.stdout.write(String(cfg.PDF_MAX_RENDER_PIXELS));"), '12345678');
  assert.strictEqual(run({ PDF_MAX_RENDER_PIXELS: 'notanumber' },
    "const {cfg}=require('./lib/config'); process.stdout.write(String(cfg.PDF_MAX_RENDER_PIXELS));"), '40000000');

  // Tiny cap (1000 px) must make even a normal A4 page reject via the guard.
  const guardProbe =
    "const {rasterizePdf,PdfError}=require('./lib/pdf');" +
    "const pdf=Buffer.from('%PDF-1.7\\n1 0 obj\\n<< /Type /Catalog /Pages 2 0 R >>\\nendobj\\n2 0 obj\\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\\nendobj\\n3 0 obj\\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF','latin1');" +
    "rasterizePdf(pdf).then(()=>process.stdout.write('RENDERED'),e=>process.stdout.write((e instanceof PdfError?'PdfError:':'RAW:')+e.code));";
  assert.strictEqual(run({ PDF_MAX_RENDER_PIXELS: '1000' }, guardProbe), 'PdfError:TOO_LARGE');
});
