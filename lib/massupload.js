'use strict';
/**
 * #7 Mass upload — transport-agnostic batch orchestrator.
 * Loops images, calls Barat's extractReceipts per image, runs assembleExpense per
 * extracted receipt, aggregates a best-effort summary. NEVER throws — every image and
 * every receipt is individually try/caught so one failure never blocks the rest
 * (mirrors the graceful degradation already in expenseFromPhoto). Pure orchestration:
 * all I/O is through the injected deps, so it's fully unit-testable with fakes.
 *
 * runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta?, metas?, metaForImage?, extractOpts?, pacingMs?, sleep? })
 *   -> { images, receipts, saved, skipped, failed:[{image_index, receipt_index?, reason, rateLimited}],
 *        flagged:[{image_index, receipt_index, merchant, reason}], truncated_images:[i] }
 *
 * failed[].reason is raw server-side error text — transport adapters (routes, bot) must
 * sanitize/replace it before exposing to a client (SOP §7.2). failed[].rateLimited (2026-07-20)
 * is the one SAFE, sanitized signal a transport adapter may act on directly — true when the
 * failure was callGroq's own key-pool-exhausted throw, not a genuinely unreadable image; lets
 * the caller give an honest "temporarily busy, please retry" message instead of blaming the photo.
 *
 * `pacingMs` (2026-07-20, optional, default 0 — byte-for-byte unchanged unless a caller opts
 * in): a delay awaited BEFORE every image except the first. Exists because OCR_MAX_TOKENS was
 * raised 2500->6000 (fixing a real ~33% empty-output rate) at the cost of shrinking how many
 * receipts fit in one Groq key's per-minute token budget (confirmed live: 8000 tokens/min) —
 * an unpaced 10-photo album can now blow through that budget mid-batch and some receipts get
 * rate-limited. Spacing image reads out keeps a batch under the ceiling WITHOUT touching the
 * token budget/reasoning settings (those were Jeevan's tested, deliberate fix for a different
 * problem — see docs/WORKLOG.md 2026-07-19 — and are not reverted here). `sleep` is injectable
 * (defaults to real setTimeout) so tests never actually wait. Config (the actual ms value)
 * lives in the caller (lib/bot.js), matching this module's stated zero-env-read, pure-DI
 * design — this file only knows HOW to pace, never WHAT the number should be.
 *
 * `metaForImage(i)` / `metas[]` (#31, optional): resolve a DISTINCT meta per image index —
 * e.g. the Telegram multi-photo adapter passes each photo's own `file_id` so batch-uploaded
 * Telegram receipts keep a clickable original image. Falls back to the single `meta` when a
 * per-image value is absent (or a `metaForImage` call throws) — so the dashboard path (one
 * shared `meta`, `fileId:null`) and every existing caller are byte-for-byte unchanged.
 * Multiple receipts extracted from the SAME image correctly share that image's meta.
 *
 * `skipped` (2026-07-03): assembleExpense now returns `skipped:true` for a receipt it
 * decided is not a real receipt (no merchant, no positive amount — e.g. the model forced
 * a reading out of an unrelated photo) and does NOT insert it. Those are counted here,
 * NOT in `saved` — additive/backward-compatible: an older `assembleExpense` fake that
 * never returns `skipped` leaves `res.skipped` undefined (falsy), so existing callers/
 * tests behave byte-for-byte as before.
 *
 * `skippedDetails` (issue #152, per-photo failure feedback): additive to the existing
 * `skipped` counter — one { image_index, receipt_index, reason } per skipped receipt, in
 * processing order, so a caller (lib/bot.js flushGroup) can map a skip back to the EXACT
 * source image (and its file_id) instead of only knowing "N photos were skipped" in the
 * aggregate. `reason` is assembleExpense's own `skipReason` ('blurry'|'not_receipt'|
 * 'unclear'), the same vocabulary lib/ocr.js's skipMessage() already understands.
 *
 * `duplicates` / `duplicateDetails` (issue #152, extends #162 D13 to the batch path):
 * assembleExpense's `duplicate:true` result still carries a truthy `expense` (it was
 * BUILT, just never inserted) — without this, it would silently miscount as `saved`.
 * Counted/detailed the same shape as `skippedDetails`, plus the matched existing row
 * (`duplicateOf`) so the caller can reply with View/Edit buttons per rejected duplicate.
 */
function msgOf(e) { return (e && e.message) ? String(e.message) : String(e); }

// Mirrors lib/groq.js's isRateLimitError() — duplicated (not imported) so this module keeps
// its zero-hard-dependency, fully-fake-testable design (see file doc comment above). A batch
// upload is the MORE likely place to hit callGroq's own Error('429') (multiple images back to
// back within the same minute), so failed[] entries need the same honest classification the
// single-photo path (lib/ocr.js expenseFromPhoto) got in the 2026-07-20 incident fix — a
// caller must not tell the user their photo was unreadable when the account was just
// temporarily rate-limited. `reason` itself stays raw/hidden per SOP §7.2; `rateLimited` is
// the only thing a transport adapter may act on directly.
function isRateLimitError(e) { return !!(e && e.message === '429'); }

async function runBatch(images, fieldSpec, deps = {}) {
  const { extractReceipts, assembleExpense, meta = {}, metas, metaForImage, extractOpts, pacingMs = 0 } = deps;
  const wait = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const list = Array.isArray(images) ? images : [];
  const summary = { images: list.length, receipts: 0, saved: 0, skipped: 0, skippedDetails: [], duplicates: 0, duplicateDetails: [], failed: [], flagged: [], truncated_images: [] };

  // #31: distinct meta per image when the caller supplies one; otherwise the shared `meta`.
  // Never throws — a bad per-image lookup falls back rather than aborting the batch.
  const resolveMeta = (i) => {
    try {
      if (typeof metaForImage === 'function') { const m = metaForImage(i); if (m && typeof m === 'object') return m; }
      else if (Array.isArray(metas) && metas[i] && typeof metas[i] === 'object') return metas[i];
    } catch { /* fall back to the shared meta */ }
    return meta;
  };

  for (let i = 0; i < list.length; i++) {
    // Pace image reads (not before the first — no reason to delay a single-image "batch"
    // or the start of a multi-image one). See the pacingMs doc comment above for why.
    if (i > 0 && pacingMs > 0) await wait(pacingMs);
    const imgMeta = resolveMeta(i);   // same meta for every receipt read from THIS image
    let receipts;
    try {
      const out = await extractReceipts(list[i], fieldSpec, extractOpts);
      receipts = out && Array.isArray(out.receipts) ? out.receipts : [];
      if (out && out.truncated) summary.truncated_images.push(i);
    } catch (e) {
      summary.failed.push({ image_index: i, reason: msgOf(e), rateLimited: isRateLimitError(e) });   // whole image unreadable
      continue;
    }
    for (let j = 0; j < receipts.length; j++) {
      summary.receipts += 1;
      try {
        // Read the element INSIDE the try: model output is untrusted (SOP §7.3) and a
        // hostile/exotic receipts array (e.g. a throwing getter) must never escape the
        // never-throws contract — it's recorded as a receipt-level failure like any other.
        const r = receipts[j] || {};
        // Destructuring directly off the awaited call (not a pre-bound variable) is
        // deliberate: a null/undefined assembleExpense result must still throw here and
        // be recorded as a receipt-level failure (regression lock, tests/massupload.test.js).
        const { expense, flagged, skipped, skipReason, duplicate, duplicateOf } = await assembleExpense({ ...imgMeta, fields: r.fields, rawParsed: r.rawParsed, fieldSpec });
        if (skipped) {
          summary.skipped += 1;
          summary.skippedDetails.push({ image_index: i, receipt_index: j, reason: skipReason || 'unclear' });
          continue;
        }
        if (duplicate) {
          summary.duplicates += 1;
          summary.duplicateDetails.push({ image_index: i, receipt_index: j, duplicateOf });
          continue;
        }
        summary.saved += 1;
        if (flagged) summary.flagged.push({ image_index: i, receipt_index: j, merchant: expense && expense.merchant, reason: flagged });
      } catch (e) {
        summary.failed.push({ image_index: i, receipt_index: j, reason: msgOf(e), rateLimited: isRateLimitError(e) });
      }
    }
  }
  return summary;
}

module.exports = { runBatch };
