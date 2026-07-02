# Spec — Telegram multi-photo adapter (#7, Barat's lane)

> Status: **SPEC-ONLY (approved to spec, hold implementation)**. Owner of file: Barat. Branch: `feature/barat-p4-telegram-multiphoto`.
> Track: Vertical AI → **Tier-2** (SOP §4.7: untrusted image input + it writes money rows).
> This is the Telegram consumer of J1's frozen `runBatch()` (ARCHITECTURE §3.7). It is the sibling of
> `routes/upload.js` (the dashboard adapter, J1's) — same orchestration, different transport.
> **DO NOT IMPLEMENT until both land on `main`:** `lib/massupload.js` (`runBatch`, `feature/jeevan-p4-massupload`)
> **and** `lib/ocr.js` `extractReceipts` (`feature/barat-p4-mass-ocr`). Until then this codes against unmerged code.

## Plain-English summary
Today, if a user sends several receipt photos to the Telegram bot at once, the bot treats each photo as a
separate message and logs them one by one, with a separate reply for each. This adapter makes the bot
recognise a **batch** (Telegram calls it a "media group" — several photos sent together), read them all in
one go through the shared batch engine, and reply with **one summary**: how many photos, how many receipts
found, how many saved, how many flagged, how many it couldn't read. A single photo keeps working exactly
as it does today.

## The core problem (why this needs a buffer)
Telegram delivers a multi-photo send as **N separate webhook updates**, one per photo, each carrying the
**same `media_group_id`**, arriving milliseconds apart. There is no single "here are 5 photos" update. So the
adapter must **collect** the updates that share a `media_group_id`, wait a short debounce window for the rest
to arrive, then process the group once. This buffering is the only genuinely new logic here — everything
downstream is the existing `runBatch` + `extractReceipts` + `assembleExpense`.

## Scope (this PR, when unblocked)
- **`lib/bot.js`** (Barat's lane) — add media-group detection + a short-lived in-memory buffer keyed by
  `media_group_id`; on debounce flush, resolve each photo's `file_id` → image URL and call `runBatch` once;
  send one summary message. Single-photo and document-image paths stay **unchanged** (`expenseFromPhoto`).
- Dependency-injected (like `routes/agent.js`/`routes/upload.js`) so it is unit-testable with fakes.

Out of scope: `runBatch` itself (J1's, frozen — consume only); `extractReceipts`/`assembleExpense` (already
Barat's, unchanged); PDF batches (#1, parked); any persistent/cross-process buffering (v1 is single-process).

## Consumes (all injected, read-only)
- `runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta, extractOpts? })` — J1, `lib/massupload.js` (ARCHITECTURE §3.7).
- `extractReceipts` / `assembleExpense` — Barat, `lib/ocr.js`.
- `getFieldSpec()` — Barat, `lib/templates.js`.
- `tgFileUrl(fileId)` / `tgSend(chatId, text)` — `lib/telegram.js` (already used by `expenseFromPhoto`).

## Design — media-group buffer in `lib/bot.js`
```
// module-level, per-process
const groups = new Map();  // media_group_id -> { chatId, repName, fileIds:[], timer }
const GROUP_DEBOUNCE_MS = env MASS_GROUP_DEBOUNCE_MS (default 2000)
const MAX_GROUP_IMAGES  = env MASS_MAX_IMAGES (default 10, aligns with runBatch/upload + Telegram's own 10 cap)

handleUpdate(update):
  ...existing text / summary / single-photo handling...
  if msg has photo AND msg.media_group_id:            // <-- new branch, BEFORE the single-photo branch
     g = groups.get(id) or create { chatId, repName, fileIds:[], timer:null }
     if g.fileIds.length < MAX_GROUP_IMAGES: g.fileIds.push(bestPhotoFileId(msg))
     clearTimeout(g.timer)
     g.timer = setTimeout(() => flushGroup(id), GROUP_DEBOUNCE_MS)
     groups.set(id, g)
     return                                            // do NOT process per-photo

flushGroup(id):
  g = groups.get(id); groups.delete(id)
  if !g or !g.fileIds.length: return
  try:
    tgSend(g.chatId, "🧾 Reading N receipts…")
    fieldSpec = await getFieldSpec()
    images = []; for fid in g.fileIds: f = await tgFileUrl(fid); if f?.url: images.push(f.url)
    meta = { chatId: g.chatId, repName: g.repName, fileId: null }   // see "per-image file_id" below
    summary = await runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta })
    tgSend(g.chatId, formatSummary(summary))
  catch e:
    console.error('[group]', e.message); tgSend(g.chatId, "⚠️ Couldn't process that batch. Please resend.")
```
- **Never throws out of `handleUpdate`/`flushGroup`** — mirrors `expenseFromPhoto`'s try/catch; one bad
  batch never crashes the webhook.
- **`formatSummary`** — plain user text from the `runBatch` summary, e.g.
  `✅ 5 photos · 6 receipts · 5 saved · 1 needs review · 1 couldn't read`. Include a short note if
  `truncated_images` non-empty ("some photos had more receipts than we could read at once").
  **Sanitize:** never echo `failed[].reason` (raw server error text, §7.2) — report counts only.

## Open design point to confirm with J1 — per-image `file_id`
`runBatch` takes ONE `meta` for the whole batch, so every saved row gets the same `fileId`. For Telegram,
each photo has its own `file_id` (its "Receipt Image Link"). Two options:
- **(A) v1 simple — `meta.fileId: null`** (what the dashboard adapter does). Rows save with no per-image
  link. Requires `assembleExpense` to tolerate `fileId:null` — already the case (`receipt_file_id` is
  nullable). Recommended for v1; matches the existing dashboard behaviour.
- **(B) enhancement — per-image meta.** Would need J1 to extend `runBatch` to accept a per-image `fileId`
  (e.g. `metaFor(i)`), since the interface is frozen. Propose as a follow-up, not v1.
**Recommendation: ship (A); raise (B) with J1 as a small `runBatch` enhancement if per-image links are wanted.**

## Risks / edge cases
- **In-memory buffer** is per-process and lost on restart → a media group mid-arrival during a restart is
  partially processed. Acceptable for single-process webhook v1; documented, not solved here.
- **Debounce tuning:** too short splits a group into two batches; too long feels laggy. Env-tunable; 2s default.
- **Cap:** Telegram media groups are already ≤10; we still clamp to `MAX_GROUP_IMAGES` defensively.
- **Untrusted images:** unchanged bar — `extractReceipts` already treats image + model output as hostile;
  the buffer only holds `file_id` strings (no image bytes) until flush.
- **Concurrency:** groups keyed by `media_group_id`, so simultaneous batches from different chats don't mix.

## Testing (hermetic, fakes injected — mirrors #9/#7)
Refactor `handleUpdate` to accept injected deps (default to real) so tests need no network:
- N updates sharing a `media_group_id` → after debounce, **one** `runBatch` call with N images; one summary sent.
- a single photo (no `media_group_id`) → existing `expenseFromPhoto` path, `runBatch` NOT called (back-compat).
- debounce coalescing: updates arriving within the window produce ONE flush, not N.
- `runBatch` throws → one safe error message, `handleUpdate` does not throw.
- summary formatting: saved/flagged/failed/truncated counts rendered; `failed[].reason` never surfaced.
- `MAX_GROUP_IMAGES` clamp: an 11th photo in a group is dropped, not sent to `runBatch`.
- (fake timers to avoid real 2s waits.)
Add `lib/bot.js` batch tests to the suite; keep existing bot behaviour tests green.

## Definition of Done (when unblocked)
Media-group buffering with debounce flush; single `runBatch` call per group; one sanitized summary; single
photo unchanged; never throws; env-driven debounce + cap; deps-injectable; all tests green;
WORKLOG/STATUS/ARCHITECTURE updated (note `lib/bot.js` now consumes `runBatch`). PR → independent Tier-2 QA
(untrusted image input + writes money rows). **Prereq: `runBatch` + `extractReceipts` merged to `main` first.**
