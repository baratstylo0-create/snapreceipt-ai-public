# Messages to Jeevan — from Barat's Claude sessions (B1/B2)

> Append-only log of every ready-to-send message handed to Barat for Jeevan (SOP-style, mirrors WORKLOG.md).
> Newest entry at the bottom. Barat copy-pastes these to Jeevan as-is or edits before sending.

---

## 2026-07-03 · Claude-B1 · re: PR #49, issues #45/#43 status

Pulled `main` (has #44/#46/#47/#48 — all confirmed merged, clean). But I don't see `normalizeCurrencyCode()` in `lib/currency.js` or `cfg.AUTH_REQUIRED` in `lib/config.js` on any branch/remote yet — checked `main` and every pushed branch. Looks like those two are only committed locally on your end, not pushed. Once they're up I'll wire in the `assembleExpense` currency swap (#45) and the webhook fail-closed check (#43) same day — both are small. Also flagging: my PR #49 (`fix/barat-flushgroup-timer-unhandled-rejection`) touches the same `flushGroup` catch line that #46 just merged — should be a clean/no-op overlap but wanted you aware before merging.

---

## 2026-07-03 · Claude-B1 · re: #45 + #43 done (one PR), item 5 already closed

Both done on ONE branch per your process note — `fix/barat-currency-normalize-and-webhook-failclosed`, PR #51. Pinging as requested.

- **#45 (RM→MYR):** did the exact one-line swap in `assembleExpense` — `normalizeCurrencyCode(fields.currency) || cfg.DEFAULT_CURRENCY`. +2 integration tests (RM→converts FROM MYR + records `currency_original=MYR`; ambiguous `$`→DEFAULT_CURRENCY fallback). Closes #45.
- **#43 (webhook fail-open):** mirrored the checkDash pattern with `cfg.AUTH_REQUIRED` in `routes/webhook.js` — refuses **503** when `AUTH_REQUIRED && !WEBHOOK_SECRET` (prod misconfig), stays permissive + one-time `console.warn` in dev, configured-secret path unchanged (200/401). Flipped your #43 characterization test from "fail-open, not yet fixed" to a dev-permissive / prod-fail-closed pair. Closes #43. (Chose **503** for the misconfig-refuse — server config problem, not a client error; no internals leaked in the body. Shout if you'd prefer 500/403.)
- **443/443 green** (+4 new).
- **Your item 3 (schema verification item 5) is already closed** — I ran the live Supabase table-list query earlier today: only `expenses`/`field_templates`/`category_corrections` exist, nothing foreign. Logged in STATUS.md.
- **Process note taken** — this is the batched-onto-one-branch approach from here on.
- Groq multi-key rotation ADR: understood, no build until you hand me the signed-off spec.

---

## 2026-07-03 · Claude-B1 · re: non-receipt bug fixed (PR #54, merged)

Live QA caught it: sending a selfie replied "✅ Expense Captured / Unknown / $0.00" AND saved a junk row. Fixed — new `isEmptyReceipt()` in `lib/ocr.js`: no usable merchant AND no positive amount → skip the insert, reply asking for a clear receipt photo. Partial reads (merchant OR amount present) still saved for review. +9 tests.

---

## 2026-07-03 · Claude-B1 · re: rate-limit visibility headers (PR #56, merged)

`createRateLimiter` now emits `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` on every response (allowed + 429). Remaining floored at 0, Reset = whole seconds left. Purely additive. Thanks for wiring the frontend chip (#58) — nice.

---

## 2026-07-03 · Claude-B1 · re: Groq key-rotation DONE (PR #60)

Wired `lib/groq.js`'s fall-through against your `lib/groqkeys.js` — `feat/barat-groq-key-rotation`, PR #60. All three of my flagged questions resolved per your module doc:
- **(1) 429-only rotation** — a non-429 throw keeps today's backoff, never rotates. ✓
- **(2) key-swaps don't eat the backoff budget** — rotation is bounded by the `tried` set (no sleep); only full-pool exhaustion consumes one of the 4 backoff attempts. ✓
- **(3) supersede-not-union** — matched your `.env.example`; no doc change needed. ✓

Factored the duplicated 4-attempt loop into one shared `callGroq()` runner (removes the groqChat/groqChatTools copy-paste as a bonus). **Single-key / `GROQ_KEYS`-unset is byte-for-byte the old behavior** — all 6 of your existing groq tests stay green, timings unchanged. +5 rotation tests (429→different key no-sleep, no key retried twice/round, exhaustion→backoff, single-key unchanged, happy path). 668/668. ADR-016 is complete once this merges — pool ceiling ×(pool size) at $0.

---

## 2026-07-12 · Claude (for Barat) · needs Premala VPS deploy + restart — receipt photos merged, live check blocked without VPS access

Owner reported receipts sent to the bot as an **album** (several photos at once) or as a **PDF** save fine (merchant/amount/category correct) but show **no photo** on the dashboard, and no photo in PDF exports.

**Root cause (confirmed by code, not guessed):** of the 4 ways a receipt gets in, only 2 stored the image file — single photo (`expenseFromPhoto`) and dashboard bulk-upload (`routes/upload.js`). The **Telegram album** path (`flushGroup`) and **Telegram PDF** path (`handlePdfDocument`) never called any storage upload — their per-image meta only set `receipt_file_unique_id`, never `receipt_url`. So those rows saved with `receipt_url = null`, and both the dashboard thumbnail and PDF-export receipt-append key off `receipt_url` — null = no photo, silently, everywhere. Not a bucket problem — the single-photo path proves the bucket works fine.

**Fixed in [PR #198](https://github.com/Jeevan1811/receipt-analyser-saas/pull/198) — already merged to `main`.** Mirrors the proven `routes/upload.js` pattern: `flushGroup` now stores each album image via `downloadAndStoreReceiptImage`, `handlePdfDocument` now uploads each rasterised page via `uploadReceiptImage`, both threaded per-image into `runBatch`'s `metaForImage` so `assembleExpense` persists the real `receipt_url`. Fail-safe (null on failure → row still saves imageless, never throws). Zero frontend/export-code changes needed — once `receipt_url` exists, the dashboard Cards view and PDF exports pick it up automatically. 1856/1856 tests green, hermetic.

**What I need from you:** this needs to go live on the Premala VPS (31.97.70.50) — pull latest `main`, restart the bot process so it picks up the new `flushGroup`/`handlePdfDocument` code. I don't have VPS access, so I can't deploy or verify this live myself.

**Verification once deployed:** send an album of 2-3 receipts (or one PDF receipt) to the live bot → open the dashboard Cards view → each new card should show its photo thumbnail → export a PDF → photos should be attached.

**One honest caveat:** receipts saved BEFORE this deploy (their `receipt_url` is already null in the DB) can't be retro-filled — the image bytes were never stored. They'd need to be re-sent (as a single photo, or re-sent as an album now that it's fixed) to get a photo.

Also flagging: [PR #197](https://github.com/Jeevan1811/receipt-analyser-saas/pull/197) (dupedit menu: Delete turns the same message into confirm→deleted, instead of 3 separate bubbles) is still open, whenever you get a chance to look.

---

## 2026-07-12 · Claude (for Barat) · live-tested PR #198 on the VPS — new bug found, need your server logs

Thanks for deploying #198 + #197 — both live-tested and confirmed working for what they cover:

- **#197 (one-message delete flow):** confirmed live via the dashboard (merged by you, good).
- **#198 (album/PDF photo storage):** Owner sent a fresh test album to the live bot. Confirmed **progress**: the new rows (RC-2026-0070/0071/0072) now genuinely have `receipt_url` set — before this deploy, cards with no photo showed **no thumbnail box at all** (no `receipt_url`). Now they show a photo box, so the storage upload is happening. **But** the box says **"Could not load the receipt."** — a new, narrower failure at the *serve-back* step, not the save step.

**What I traced (code-only, I don't have VPS access so I can't see live logs):**
- That message (`activity.js:510`) only fires when `Api.fetchBlob('/receipt/by-id/:id')` gets a **rejected** response — not silently missing, an actual non-2xx or thrown error.
- `routes/receipt.js`'s `/receipt/by-id/:id` returns 404 if `fetchReceiptObject(row.receipt_url)` comes back null, or 502 if anything in the handler throws.
- `fetchReceiptObject` (`lib/storage.js:69`) GETs the object from Supabase Storage using the service key and logs `console.error('[storage] fetch', e.message)` on failure.

**Found a real bug while tracing this (separate from the root cause, but worth fixing regardless):** `lib/http.js`'s `hreq()` never checks `r.ok`/`r.status` — for the `encoding:'arraybuffer'` path specifically, it does `Buffer.from(await r.arrayBuffer())` **no matter what HTTP status came back**. So a 4xx/5xx from Supabase Storage returns a non-empty "buffer" (the error body's bytes) instead of throwing/failing — `fetchReceiptObject`'s `if (!buf) return null` never catches that case. Didn't touch this yet — wanted to flag it, not guess-fix a shared low-level helper without seeing what's actually happening on your box first.

**What I need from you:** after the Owner sends a test album again, can you grep the live server's stdout/PM2 log for `[storage] fetch` or `[receipt by-id]` right after? That'll tell us in one look whether it's a bucket/permissions issue (wrong `SB_KEY` — anon vs service_role?), a missing bucket, or something else. Happy to build whichever fix it turns out to be once we know.

---

## 2026-07-12 · Claude (for Barat) · re: still failing on FRESH receipts — [PR #211](https://github.com/Jeevan1811/receipt-analyser-saas/pull/211) opened, need a VPS-side check

Owner just proved it's not stale data: sent a **brand-new** receipt after your #204 deployed, and it still shows "no photo available." That rules out "just re-send old ones" — new captures are failing to get a usable photo right now.

**Leading theory (server-config, not app code):** the Storage **upload** itself is failing on the VPS. Two concrete suspects, both consistent with what a local diagnostic against my own `.env` showed (zero buckets, zero readable rows on that project):
1. The **`receipts` Storage bucket doesn't exist** in the VPS's Supabase project, or
2. The VPS's **`SB_KEY` is the publishable/anon key, not `service_role`** — a publishable key can't write to a private bucket, so every upload gets rejected.

I can't confirm which from here — I don't have VPS access, and the definitive proof is either a look at the Supabase Storage tab or a single log line.

**Opened [PR #211](https://github.com/Jeevan1811/receipt-analyser-saas/pull/211)** (not merged — please review first) with 3 changes that don't fix the server config but stop it from being a dead end:
1. `routes/receipt.js` — a failed Storage fetch now falls back to the Telegram proxy instead of a dead 404, so photos still show (via Telegram) even while the upload issue is being sorted.
2. `lib/storage.js` — a rejected upload now logs the real Supabase error (`[storage] upload rejected: ...`) instead of failing silently. **This is the line that will finally name the actual cause.**
3. `lib/bot.js` — album rows now carry their own Telegram file id, so they get the same fallback single-photo rows always had.
(Deliberately left your `lib/http.js` fix — #206 — out of this branch; no overlap, no duplicate PR.)

**What I need from you, once #211 is reviewed/merged and deployed:**
1. Check the VPS's Supabase project Storage tab — does a **private `receipts` bucket** exist? Create it if not.
2. Check the VPS's `.env` — is `SB_KEY` the **service_role / `sb_secret_...`** key, not the publishable/anon one?
3. Ask Barat to send one more test receipt, then `grep '\[storage\]'` the PM2 log — the new line will say exactly what's wrong (bucket missing / permission denied / bad path).

1867/1867 tests green on #211.
