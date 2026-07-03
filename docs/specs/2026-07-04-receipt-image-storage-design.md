# Spec — Durable receipt-image storage (Supabase Storage)  ·  Draft for sign-off

> **Decision:** ADR-018 (proposed). **Requested by:** Owner — receipt images must be **click-and-viewable on the dashboard**, reliably, for every ingestion path.
> **Owners:** new `lib/storage.js` + `routes/upload.js` wiring = **Jeevan**. The ingestion hook in `assembleExpense` / `lib/supabase.js` insert path = **Barat** (his lane). Serve route `routes/receipt.js` = shared. Frontend already done (**Mugi** lane, but the auth'd-blob viewer exists today).
> **Tier:** Tier-2 (stores financial-document images; new storage bucket + RLS). Additive, backward-compatible.
> ⚠️ **Sequencing:** the ingestion hook touches Barat's insert path — **land AFTER PR #78** (and coordinate with the voucher/`sbInsertReturning` changes already merged) to avoid a `lib/ocr.js` conflict.

## The problem (verified on live)
Receipt images don't display on the dashboard. Two independent causes:
1. **`/receipt/:fileId` live-proxies Telegram** using `BOT_TOKEN`. Fragile: breaks if the bot token rotates (existing gotcha in `CLAUDE.md`), and a file_id is scoped to the *specific bot* that received it — another token can't resolve it.
2. **Dashboard uploads store NO image at all** — `receipt_file_id` is `null` for `/api/upload` rows (there's no Telegram file), and the frontend only renders an image block `if (r.receipt_file_id)`. So a dashboard-uploaded receipt is *permanently* imageless.

`expenses.receipt_url` (text) **already exists** in `schema.sql` but is **never written** ("unused in v1"). This spec makes it the durable, self-hosted image URL.

## Design — upload to Supabase Storage at ingestion, store the path in `receipt_url`
A private `receipts` bucket. At ingestion, upload the image bytes → store the object path in `receipt_url`. Serving reads from Storage (auth-gated), falling back to the Telegram proxy for old rows.

### 1. Bucket (Barat / DB-owner, one-time)
`receipts` — **private** (`public:false`; financial documents must never be world-readable). Service-role-only access (same posture as every table; anon denied). Not yet created.

### 2. New module — `lib/storage.js` (Jeevan, pure/injectable)
```
// uploadReceiptImage(buffer, { accountId, ext }) -> { path } | null
//   PUTs bytes to storage at  <accountId>/<uuid>.<ext>  via the service key
//   (REST: POST {SB_URL}/storage/v1/object/receipts/<path>). Fail-safe: returns
//   null on any error (ingestion must never break because storage hiccuped).
// receiptObjectPath(row) -> the stored object path, or null.
```
Path scheme `<account_id>/<uuid>.<ext>` — account-scoped (multi-tenant-forward), uuid avoids collisions, no PII in the name.

### 3. Ingestion hook (Barat, `lib/ocr.js` `assembleExpense` — additive)
`assembleExpense` gains an **optional** `imageBuffer` param. When present (and the receipt isn't skipped), upload BEFORE/around the insert and set `expense.receipt_url = path`. When absent, behavior is byte-for-byte today's (Telegram single-photo path can keep its `receipt_file_id` too — the two coexist; `receipt_url` wins at serve time). Fail-safe: a failed upload leaves `receipt_url` null and still saves the row.
- **Dashboard path (`routes/upload.js`, Jeevan):** already holds the decoded `Buffer`s — pass each as `imageBuffer` through `runBatch` → `assembleExpense`. **This is the path that's completely broken today**, so it's the primary win and it's mostly in Jeevan's lane.
- **Telegram path (`lib/bot.js`/`expenseFromPhoto`, Barat):** fetch the photo bytes once (already downloaded for OCR) and pass them too, so Telegram receipts also get a permanent copy instead of a live proxy.

### 4. Serve route (`routes/receipt.js`, shared — stays `checkDash`-gated)
Prefer `receipt_url` (fetch the object from Storage with the service key, stream it back — never hand the browser a raw bucket URL). Fall back to the existing Telegram `file_id` proxy when `receipt_url` is null (old rows). Same `private, no-store` headers. The browser keeps using the existing auth'd-blob fetch (`loadReceiptImage`) — **no frontend change needed**.

## Decisions needed before build
- **A. Serve mechanism:** (i) server streams the object via service key (recommended — bucket stays fully private, one code path, matches today's proxy) vs (ii) short-lived signed URLs handed to the browser (fewer server bytes, but the URL leaks the object if logged). Recommend (i).
- **B. Backfill old rows:** existing Telegram rows have a `receipt_file_id` but no stored image. Options: (i) leave them on the live Telegram proxy (works until token rotation) — recommended for v1; (ii) a one-time job that fetches each via the current bot token and uploads to Storage (only possible while the original token still works). Dashboard-uploaded old rows have no image and can't be backfilled (bytes are gone).
- **C. Format/size:** store as-received (jpeg/png/webp); PDFs — store the original PDF or the rasterized page image? Recommend storing the rasterized page image that OCR saw (what the user expects to view), cap at the existing upload size limits.
- **D. Retention:** tie to ADR-002 retention policy (delete storage object when a row is hard-deleted; soft-delete keeps it). Confirm.

## Non-goals (YAGNI)
- No image transforms/thumbnails (serve the original; the browser scales). Revisit if payload size hurts.
- No public/CDN URLs (private bucket only).
- No re-OCR from stored images.

## Security
- Private bucket, service-role only; the browser only ever gets bytes via the `checkDash`-gated `/receipt` route on a row it's authorized to read. `no-store` so nothing caches a financial document. No storage credentials or raw bucket URLs reach the client. Uploads are size-capped at the existing `/api/upload` limits (no new DoS surface).

## Test plan
- `lib/storage.js`: `uploadReceiptImage` PUTs to the right path, returns `{path}`; returns null (never throws) on a storage error; path is account-scoped + uuid.
- `assembleExpense`: with `imageBuffer` → `receipt_url` set from the upload; without → unchanged (regression-lock every existing fake); upload failure → row still saved, `receipt_url` null.
- Serve route: `receipt_url` present → streams from Storage; null → falls back to Telegram proxy; both keep `private, no-store` + `checkDash`.
- End-to-end (live): dashboard-upload a receipt → row has `receipt_url` → dashboard renders the image (the currently-broken path).
