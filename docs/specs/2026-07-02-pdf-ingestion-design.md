# Design — #1 PDF Ingestion

> **Feature:** #1 Extract data from receipts — **PDFs** (images already shipped via #4/#7).
> **Status:** Design approved by Owner (Jeevan) 2026-07-02. Ready for plan → subagent-TDD.
> **Depends on:** ADR-014 (dependency choice: `@hyzyla/pdfium`), #7 mass-upload spine (`runBatch`, merged), Barat's `extractReceipts`/`assembleExpense` (merged, #29).
> **Owners:** `lib/pdf.js` + Telegram PDF path = **Barat** (OCR/vision boundary). `routes/upload.js` glue = **Jeevan**. Spec/ADR/plan/coordination = **Jeevan (Owner)**.
> **Tier:** **Tier-2** (untrusted-file parsing surface + a new dependency) → independent QA before merge (SOP §4.7, ADR-008/012 precedent).

---

## 1. Problem & goal

Customers can already send a **photo** of a receipt (Telegram or dashboard upload) and get expense
rows back (#4 OCR, #7 mass upload). This feature adds **PDF** as an accepted input on both surfaces,
producing the same result. A PDF may be:

- a **digital/native** PDF (an emailed invoice, a "print to PDF") — text is real/selectable; and/or
- a **scanned/image** PDF — the page is effectively a picture of paper; no embedded text; and/or
- **multi-page** and/or **multiple receipts per page**.

All are treated as **hostile, untrusted file input** (PROJECT_BRIEF §7, SOP §7).

**Done when:** a customer uploads a PDF — digital or scanned, one page or several — on the dashboard
or via Telegram, and gets correct expense rows out; oversized/encrypted/corrupt PDFs fail gracefully
with **no crash and no leaked internals**; the page cap holds; and the work has passed independent
Tier-2 review.

## 2. Key insight — rasterize, then reuse the #7 spine

The Groq vision model reads **images, not PDFs** (ADR-007: qwen is image-only, base64). So the entire
feature reduces to one new step: **turn a PDF into an array of page images.** That array is *exactly*
the `images[]` shape `runBatch(images, fieldSpec, …)` (#7) already consumes. Everything downstream —
per-image extraction, multi-receipt-per-image split, best-effort never-throws orchestration, batch
summary — is already built, tested, and merged. We add the front-end (PDF → page PNGs); we do **not**
write new fan-out/orchestration.

Consequences of reuse:
- **Multi-page** falls out for free: a 3-page invoice → 3 page images → up to 3 reads.
- **Multiple receipts per page** falls out for free: `runBatch` routes each page through Barat's
  `extractReceipts`, which already returns `1..N` receipts per image.
- The page cap **is** `MASS_MAX_IMAGES` (the same cap #7 uses), and overflow reuses `truncated`
  semantics #7 already surfaces.

## 3. Architecture (three thin pieces, existing lanes)

```
PDF in (dashboard upload ─┐
        OR Telegram doc)  ├─▶ sniff %PDF magic bytes (never trust extension/content-type)
                          │
   lib/pdf.js [BARAT] ────┴─▶ rasterizePdf(buf, {maxPages}) → { pages: Buffer[], truncated }
                                   pure WASM PDFium — NO Groq, NO FieldSpec, in-memory only
                                        │  pages[]  (== runBatch's images[] shape)
   lib/massupload.runBatch(pages, fieldSpec, { extractReceipts, assembleExpense, … })  [existing]
                                        │
                                        ▼  N expense rows (multi-page AND multi-receipt-per-page)
```

### 3.1 New module — `lib/pdf.js`  (Barat)

Single-purpose, no Groq, no FieldSpec, independently unit-testable with fixture PDFs.

```
rasterizePdf(pdfBuffer, { maxPages = MASS_MAX_IMAGES, dpi = PDF_RENDER_DPI (default 150) })
  -> { pages: Buffer[], truncated: boolean }
```

- `pages` = **PNG** buffers, one per rendered page, in document order.
- Renders at a middle-ground **~150 DPI**: legible enough for qwen OCR, small enough to bound size.
- Caps at `maxPages`; if the document has more pages, render the first `maxPages` and set
  `truncated: true` (do not render the rest).
- **Error contract (decided):** `rasterizePdf` **throws a single typed `PdfError`** (with a stable,
  non-leaky `.code`, e.g. `ENCRYPTED` / `CORRUPT` / `EMPTY` / `NOT_PDF` / `TOO_LARGE`) on any input it
  cannot process. It never throws raw library internals. Callers (route + Telegram) catch `PdfError`
  and map `.code` → a **fixed sanitized string** for the client; the library's own message/stack is
  never surfaced or logged. (Rationale: a typed throw keeps the "couldn't process" path explicit at
  every call site and matches how the route already sanitizes `runBatch` `failed[].reason` per §7.2;
  returning an empty `pages:[]` silently could be mistaken for "a valid 0-receipt PDF".)
- **Byte-size guard:** reject before rendering if `pdfBuffer.length` exceeds `PDF_MAX_BYTES`
  (env-driven, sensible default) → `PdfError('TOO_LARGE')`. Defends against decompression/page bombs
  and Groq cost-drain (threat #3) before any parsing work happens.
- In-memory buffers only — **no temp files written to disk.**

### 3.2 Dashboard glue — `routes/upload.js`  (Jeevan)

The existing `POST /api/upload` (#7) gains a PDF branch:

- `checkDash` auth unchanged.
- Detect PDF by **magic bytes** (`%PDF-` prefix on the decoded buffer), not by extension or a
  client-supplied content-type.
- On PDF: `rasterizePdf(buf)` → `runBatch(pages, fieldSpec, { extractReceipts, assembleExpense })` →
  return the **same batch summary shape** #7 already returns (counts + sanitized `failed[]`), plus the
  `truncated` signal when the page cap tripped.
- `PdfError` → mapped to a fixed sanitized message + appropriate status (oversized → 413; encrypted /
  corrupt / not-a-pdf → 422 or the batch's existing failure shape — finalized in the plan). Never 500,
  never leak.
- Existing image / multi-image paths are **unchanged**.

### 3.3 Telegram glue — `lib/bot.js`  (Barat)

Mirror the existing multi-photo adapter (#32), but for a **document** message whose MIME/name says PDF:

- On a PDF document update: resolve the Telegram `file_id` → download buffer → `rasterizePdf` → **one**
  `runBatch` → **one counts-only** reply (never `failed[].reason`, never `PdfError` internals; SOP §7.2).
- Single-photo and existing media-group photo paths are **unchanged**.
- Uses the same `MASS_MAX_IMAGES` cap; a too-many-pages PDF replies with the truncated count.

## 4. Data flow (end to end)

```
PDF (upload | Telegram doc)
  → sniff %PDF
  → rasterizePdf → { pages: Buffer[], truncated }
  → runBatch(pages, fieldSpec, { extractReceipts, assembleExpense })
       → per page: extractReceipts → 1..N receipts
       → per receipt: assembleExpense (currency/category/anomaly/confidence) → supabase insert
  → batch summary (dashboard: full counts + truncated; Telegram: counts only)
```

## 5. Dependency decision (see ADR-014)

**`@hyzyla/pdfium`** — PDFium (Google's Chrome PDF engine) compiled to WebAssembly; MIT-licensed
wrapper over the BSD/Apache PDFium core; zero runtime dependencies; WASM auto-loads in Node.

Why this over the alternatives (full record in ADR-014):
- **License is clean for a commercial SaaS** — permissive, no copyleft. (MuPDF/`mupdf` is AGPL-or-paid
  and is therefore rejected for now.)
- **No build step, no native compile, identical on Windows dev and Linux prod** — pure WASM. Best fit
  for the project's "no build, pure Node 22" constraint. (pdf.js + `@napi-rs/canvas` also permissive,
  but two deps and a platform-specific native binary — kept as the named fallback.)
- **Runs in a WASM sandbox** — memory-isolated, no shell-out — a real security win on hostile input,
  and the reason a system binary (poppler/ghostscript) was rejected.
- Output PNG buffers drop straight into `runBatch`.

**Honest risk & the one pre-commit check:** `@hyzyla/pdfium` is a smaller community project than the
official `mupdf`, and it is likely **ESM** while this project is **CommonJS** (`require`). Before the
ADR fully locks, Barat runs a ~10-minute spike to confirm CommonJS interop (dynamic `import()`) + the
exact render API against a real fixture PDF (same "verify live at wire-up" discipline as ADR-007). If
interop is unworkable, the fallback (pdf.js + `@napi-rs/canvas`) is already named in the ADR.

## 6. Security & privacy (Tier-2 — untrusted file input)

- **Detect by magic bytes**, never trust extension or client content-type.
- **Two hard caps:** `PDF_MAX_BYTES` (reject oversized before parsing) **and** `maxPages`
  (`MASS_MAX_IMAGES`) — defends threat #3 (Groq cost-drain) and memory/page bombs.
- **Graceful failure, never a throw that 500s:** encrypted / password-locked / corrupt / truncated /
  zero-page / not-really-a-PDF all become a typed `PdfError` → a **fixed sanitized** client message.
- **No leakage:** the library's error text, stack, filenames, or any file contents never appear in the
  client response **or in logs** (ADR-002: no images/PII in logs, ever).
- **WASM sandbox**, in-memory buffers, **no temp files**.
- `account_id` scoping and auth are unchanged — inherited from the existing `runBatch`/route/bot paths.

## 7. Testing (TDD, both owners; independent Tier-2 QA before merge)

**`lib/pdf.js` (Barat's suite) — fixture PDFs:**
- 1-page native PDF → `pages.length === 1`, `truncated === false`.
- multi-page native PDF → correct page count.
- scanned / image-only PDF → renders (proves both kinds handled by the same path).
- `> maxPages` PDF → renders exactly `maxPages`, `truncated === true`.
- encrypted / password-protected → `PdfError('ENCRYPTED')`, no throw of internals.
- corrupt / truncated bytes → `PdfError('CORRUPT')`.
- zero-page / empty → `PdfError('EMPTY')`.
- non-PDF bytes → `PdfError('NOT_PDF')`.
- oversized buffer → `PdfError('TOO_LARGE')` **before** any parse.

**`routes/upload.js` (Jeevan's suite):**
- PDF upload (multi-page) → N rows via `runBatch`; summary shape matches #7; `truncated` surfaced.
- oversized PDF → 413 (or mapped status), sanitized message.
- encrypted / corrupt PDF → sanitized failure, **no leak** — plant a fake secret in a broken fixture
  and assert it never appears in the response (regression like #32's planted-secret test).
- existing image / multi-image paths unchanged (no regressions).

**Telegram (Barat's suite):** PDF document → one `runBatch` → counts-only reply; never leaks
`failed[].reason` or `PdfError` internals; single-photo & media-group paths unchanged.

## 8. Ownership & sequencing

| Piece | Owner | Notes |
|---|---|---|
| This spec + ADR-014 + plan + coordination | **Jeevan (Owner)** | drives; Barat stays HOLDING until handed the plan |
| `lib/pdf.js` (rasterizer) | **Barat** | new module, single purpose, his OCR/vision boundary |
| Telegram PDF `document` path in `lib/bot.js` | **Barat** | mirrors #32 multi-photo adapter |
| `routes/upload.js` PDF glue | **Jeevan** | reuses #7 cap + reason-sanitization |
| `@hyzyla/pdfium` → `package.json` + ADR-014 | **Barat** (dep lands with `lib/pdf.js`) | new dep = Tier-2 |

**Sequence:**
1. Spec + ADR-014 + plan (Jeevan, now).
2. Barat spike (CJS/ESM interop + render API) → confirms or triggers the fallback.
3. Barat builds `lib/pdf.js` + Telegram path, TDD, on `feature/barat-p4-pdf`.
4. Review + **independent Tier-2 QA** on Barat's branch → merge.
5. Jeevan adds `routes/upload.js` PDF glue in his lane → QA → PR → merge.

## 9. Config (all env-driven, ARCHITECTURE §3.5 rule — no hardcoded knobs)

- `MASS_MAX_IMAGES` — **reused** as the page cap (default 10). No new page-cap knob.
- `PDF_RENDER_DPI` — page render resolution (default 150).
- `PDF_MAX_BYTES` — reject oversized PDFs before parsing (sensible default, finalized in plan).

## 10. Out of scope (YAGNI)

- Per-page OCR quality escalation / DPI bumping on hard pages.
- Blank-page detection / skipping.
- Page-range selection UI.
- Storing rendered page images (they're transient, like the multi-photo path — issue #31 territory).
- Any change to `extractReceipt`/`extractReceipts` (already sufficient; consumed as-is).
