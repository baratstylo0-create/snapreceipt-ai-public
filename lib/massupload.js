'use strict';
/**
 * #7 Mass upload — transport-agnostic batch orchestrator.
 * Loops images, calls Barat's extractReceipts per image, runs assembleExpense per
 * extracted receipt, aggregates a best-effort summary. NEVER throws — every image and
 * every receipt is individually try/caught so one failure never blocks the rest
 * (mirrors the graceful degradation already in expenseFromPhoto). Pure orchestration:
 * all I/O is through the injected deps, so it's fully unit-testable with fakes.
 *
 * runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta?, metas?, metaForImage?, extractOpts? })
 *   -> { images, receipts, saved, skipped, failed:[{image_index, receipt_index?, reason}],
 *        flagged:[{image_index, receipt_index, merchant, reason}], truncated_images:[i] }
 *
 * failed[].reason is raw server-side error text — transport adapters (routes, bot) must
 * sanitize/replace it before exposing to a client (SOP §7.2).
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
 */
function msgOf(e) { return (e && e.message) ? String(e.message) : String(e); }

async function runBatch(images, fieldSpec, deps = {}) {
  const { extractReceipts, assembleExpense, meta = {}, metas, metaForImage, extractOpts } = deps;
  const list = Array.isArray(images) ? images : [];
  const summary = { images: list.length, receipts: 0, saved: 0, skipped: 0, failed: [], flagged: [], truncated_images: [] };

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
    const imgMeta = resolveMeta(i);   // same meta for every receipt read from THIS image
    let receipts;
    try {
      const out = await extractReceipts(list[i], fieldSpec, extractOpts);
      receipts = out && Array.isArray(out.receipts) ? out.receipts : [];
      if (out && out.truncated) summary.truncated_images.push(i);
    } catch (e) {
      summary.failed.push({ image_index: i, reason: msgOf(e) });   // whole image unreadable
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
        const { expense, flagged, skipped } = await assembleExpense({ ...imgMeta, fields: r.fields, rawParsed: r.rawParsed, fieldSpec });
        if (skipped) { summary.skipped += 1; continue; }
        summary.saved += 1;
        if (flagged) summary.flagged.push({ image_index: i, receipt_index: j, merchant: expense && expense.merchant, reason: flagged });
      } catch (e) {
        summary.failed.push({ image_index: i, receipt_index: j, reason: msgOf(e) });
      }
    }
  }
  return summary;
}

module.exports = { runBatch };
