'use strict';
/**
 * #7 Mass upload — transport-agnostic batch orchestrator.
 * Loops images, calls Barat's extractReceipts per image, runs assembleExpense per
 * extracted receipt, aggregates a best-effort summary. NEVER throws — every image and
 * every receipt is individually try/caught so one failure never blocks the rest
 * (mirrors the graceful degradation already in expenseFromPhoto). Pure orchestration:
 * all I/O is through the injected deps, so it's fully unit-testable with fakes.
 *
 * runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta?, extractOpts? })
 *   -> { images, receipts, saved, failed:[{image_index, receipt_index?, reason}],
 *        flagged:[{image_index, receipt_index, merchant, reason}], truncated_images:[i] }
 */
async function runBatch(images, fieldSpec, deps) {
  const { extractReceipts, assembleExpense, meta = {}, extractOpts } = deps;
  const list = Array.isArray(images) ? images : [];
  const summary = { images: list.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };

  for (let i = 0; i < list.length; i++) {
    let receipts;
    try {
      const out = await extractReceipts(list[i], fieldSpec, extractOpts);
      receipts = out && Array.isArray(out.receipts) ? out.receipts : [];
      if (out && out.truncated) summary.truncated_images.push(i);
    } catch (e) {
      summary.failed.push({ image_index: i, reason: e.message });   // whole image unreadable
      continue;
    }
    for (let j = 0; j < receipts.length; j++) {
      summary.receipts += 1;
      const r = receipts[j] || {};
      try {
        const { expense, flagged } = await assembleExpense({ ...meta, fields: r.fields, rawParsed: r.rawParsed, fieldSpec });
        summary.saved += 1;
        if (flagged) summary.flagged.push({ image_index: i, receipt_index: j, merchant: expense && expense.merchant, reason: flagged });
      } catch (e) {
        summary.failed.push({ image_index: i, receipt_index: j, reason: e.message });
      }
    }
  }
  return summary;
}

module.exports = { runBatch };
