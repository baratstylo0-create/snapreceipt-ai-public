# Spec — #7 Mass Upload

> Status: approved (brainstorm 2026-07-02). Owner: Jeevan. Branch: `feature/jeevan-p4-massupload`.
> Track: Vertical AI → **Tier-2** (SOP §4.7: untrusted file/image input + it writes money rows).
> New frozen interface: `lib/massupload.js` exports `runBatch(images, fieldSpec, deps)` (transport-agnostic).
> Consumes (dependency-injected, read-only): `extractReceipts()` + `assembleExpense()` (Barat, `lib/ocr.js`),
> `getFieldSpec()` (Barat, `lib/templates.js`), `checkDash` (`routes/expenses.js`).

## Plain-English summary
Today a user logs one receipt at a time. Mass upload lets them hand over a **stack of receipt photos at
once** — the system reads every photo (a single photo may even contain several receipts), processes each
one exactly like the normal single-receipt flow (merchant, amount, currency, category, anomaly flags),
saves them, and returns a **summary**: how many photos, how many receipts found, how many saved, which
failed and why, and which were flagged for review. One blurry photo never discards the good ones.

## Scope (this PR)
- **`lib/massupload.js`** — a transport-agnostic batch orchestrator (my lane). Loops images, calls Barat's
  `extractReceipts` per image, runs `assembleExpense` per extracted receipt, aggregates a summary. Never
  builds vision/OCR logic itself — that is Barat's `lib/ocr.js`.
- **`routes/upload.js`** — dashboard adapter (my lane): `POST /api/upload` behind `checkDash`, decodes
  base64 images, calls `runBatch`, returns the summary.
- Sequential processing, best-effort, ~10-image cap (Owner-chosen).

Out of scope (own follow-ups): **Telegram multi-photo** (Barat's lane — `lib/bot.js` gathers a media
group and calls the same `runBatch`; flagged, not built here); PDF batches (#1 PDF, parked); any change
to `extractReceipts`/`assembleExpense` themselves (Barat's).

## Barat's contract (verified on `feature/barat-p4-mass-ocr`, 2026-07-02)
- `extractReceipts(image, fieldSpec, { maxTokens?, model?, maxReceipts? }) -> { receipts, truncated, raw }`
  - `receipts = [ { fields, rawParsed } ]` — one element per receipt, same per-receipt shape as `extractReceipt`.
  - `truncated = true` when the model returned MORE than the per-image cap (`MASS_MAX_RECEIPTS`, env, default 10) and extras were dropped.
- `assembleExpense({ chatId, repName, fileId, fields, rawParsed, fieldSpec }, deps?) -> { expense, flagged }`
  runs currency(#10)→category(#6)→anomaly(#5)→confidence(#11) and inserts the row. `flagged` truthy = anomaly/low-confidence.
- **Cross-lane dependency:** `feature/barat-p4-mass-ocr` must merge for the live path. `lib/massupload.js` is
  dependency-injected so it is fully built + tested here without it; the route degrades to **503** until it lands.

## `lib/massupload.js` — `async runBatch(images, fieldSpec, deps) -> summary`
- **`images`**: an array of images in whatever form `extractReceipts` accepts (URL or Buffer). `runBatch`
  does not decode/transport — the caller supplies ready-to-read images.
- **`deps`** (injected for testability + defensiveness): `{ extractReceipts, assembleExpense, meta, extractOpts? }`.
  - `meta = { chatId, repName, fileId }` — context passed straight into each `assembleExpense` call.
    Dashboard passes `{ repName: 'Dashboard', fileId: null, chatId: <account/dashboard sentinel> }`.
  - `extractOpts` (optional) forwarded to `extractReceipts` (e.g. `{ maxReceipts }`).
- **Algorithm** (sequential — one image at a time, respecting the groq 429 backoff):
  ```
  summary = { images: N, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }
  for i in 0..N-1:
    try:
      { receipts, truncated } = await extractReceipts(images[i], fieldSpec, extractOpts)
      if truncated: summary.truncated_images.push(i)
      for j in 0..receipts.length-1:
        summary.receipts += 1
        try:
          { expense, flagged } = await assembleExpense({ ...meta, fields, rawParsed, fieldSpec })
          summary.saved += 1
          if flagged: summary.flagged.push({ image_index: i, receipt_index: j, merchant, reason: flagged })
        catch e:
          summary.failed.push({ image_index: i, receipt_index: j, reason: e.message })
    catch e:
      summary.failed.push({ image_index: i, reason: e.message })   // whole image unreadable
  return summary
  ```
- **Never throws.** Every image and every receipt is individually try/caught; one failure never blocks the
  rest (Owner-chosen best-effort). Mirrors the graceful-degradation already in `expenseFromPhoto`.
- Pure orchestration + I/O only through the injected deps → fully unit-testable with fakes, no network/DB.

## `routes/upload.js` — `POST /api/upload`
- Gated by `checkDash` (reuse from `routes/expenses.js`). CORS header before the try (house convention).
- Body parser: `express.json({ limit: '10mb' })`. Body shape: `{ images: [ base64String, ... ] }`.
- **Validation (all before any processing):**
  - `images` must be a non-empty array of non-empty strings → else **400** (static message, no echo).
  - `images.length > MAX_IMAGES` (10) → **413**.
  - oversized body → **413** (handled by the app-level body-parser error handler already in `server.js`).
- **Defensive dark-path:** if the real `extractReceipts` is not yet available
  (`typeof require('../lib/ocr').extractReceipts !== 'function'`) → **503** `{ error: 'mass upload not available yet' }`.
  (Same pattern #9 used for `groqChatTools`. Tests inject a fake so this never fires in tests.)
- Decode each base64 string with `Buffer.from(str, 'base64')` (lenient — never throws; an invalid string
  yields a garbage/empty Buffer that `extractReceipts` will simply fail on, recorded as a failed image in
  the summary). So no per-string 400 branch is needed — the only 400s are the up-front shape checks
  (non-array / empty / non-string element). Optionally strip a `data:...;base64,` URI prefix if present
  before decoding.
- `fieldSpec = await getFieldSpec()`; `summary = await runBatch(buffers, fieldSpec, { extractReceipts, assembleExpense, meta })`.
- Respond `200` with the summary JSON. Unexpected top-level error (e.g. `getFieldSpec` throws) → **502**
  `{ error: 'upload failed' }`, logging only `e.message` (no stack/paths — SOP §7.2).
- Mounted in `server.js` with the existing `const mountUpload = require('./routes/upload'); mountUpload(app);` pattern.
- deps-injectable exactly like `routes/agent.js`: `module.exports = function mountUpload(app, deps = {})`
  so tests inject a fake `runBatch`/`extractReceipts`.

## Constants (env-overridable)
`MAX_IMAGES = 10` (`process.env.MASS_MAX_IMAGES`), JSON body limit `10mb`. Per-image receipt cap lives in
`extractReceipts` (`MASS_MAX_RECEIPTS`, Barat's) — not re-implemented here; its `truncated` is surfaced.

## Testing (hermetic, fakes injected — mirrors #9)
`lib/massupload.js` (fake `extractReceipts` + `assembleExpense`, no I/O):
- multi-image, multi-receipt, all success → `saved` == total receipts, `failed` empty.
- one image's `extractReceipts` throws → that image in `failed` (no `receipt_index`), other images fully processed.
- one receipt's `assembleExpense` throws → that receipt in `failed` (with `receipt_index`), siblings saved.
- `truncated:true` from an image → its index in `truncated_images`.
- `flagged` receipts aggregated into `summary.flagged`.
- sequential order preserved; `meta` passed through to every `assembleExpense` call.
- empty `images` → summary with zeros (route rejects empty at 400; orchestrator itself is total-agnostic).

`routes/upload.js` (fake `runBatch`/deps, real express via `app.listen(0)` + `fetch`):
- happy path → 200 + summary body.
- `checkDash` enforced (401 when `DASHBOARD_TOKEN` set and no key; 200 with key) — toggle `cfg.DASHBOARD_TOKEN`.
- non-array / empty / non-string-element `images` → 400 (no stack leak).
- `images.length` 11 → 413 (runBatch not called).
- missing real `extractReceipts` → 503.
- `runBatch`/`getFieldSpec` throw → 502 JSON, no stack.
Boot/smoke: `/api/upload` mounts; add `../lib/massupload` + `../routes/upload` to `tests/smoke.test.js`.

## Definition of Done
Frozen `runBatch` interface; best-effort never-throw orchestration with the summary shape above; `POST
/api/upload` with `checkDash`, image cap (413), safe errors (400/502), 503 dark-path; sequential
processing; no new dependency; env-driven caps; all tests green; WORKLOG/STATUS/ARCHITECTURE updated
(add `lib/massupload.js` + `routes/upload.js` to the module map). PR → **independent Tier-2 QA** (untrusted
image input + writes money rows) before merge, plus a separate QA of Barat's `feature/barat-p4-mass-ocr`
(focus: `extractReceipt` untouched, array-parse + unterminated-`<think>` rejection + extra-key stripping,
`stripThink` behaviour-preserving; and that `assembleExpense` tolerates `fileId:null` for dashboard uploads).
