'use strict';
const express = require('express');
const { checkDash, dashOrigin } = require('./expenses');
const { runBatch: realRunBatch } = require('../lib/massupload');
const ocr = require('../lib/ocr');
const templates = require('../lib/templates');
const pdf = require('../lib/pdf');
const storage = require('../lib/storage');
const { createRateLimiter } = require('../lib/ratelimit');

const MAX_IMAGES = Number(process.env.MASS_MAX_IMAGES) || 10;

// P6 abuse defense (§4.4): mass upload fans out to Groq vision OCR per image/page —
// cost-drainable without a limit. UPLOAD_RATE_MAX follows Barat's WEBHOOK_RATE_MAX naming
// convention (lib/ratelimit.js, wired into routes/webhook.js). Reuses the same shared
// limiter, no second implementation.
// Owner directive (lenient): this ceiling must NEVER trip a legit busy user/company — a
// human peaks at maybe 5-10 upload batches/min, so 120/min is ~10x headroom. It is a
// RUNAWAY backstop, not a throttle: the Groq key pool (ADR-016) is the cost backstop; this
// only caps a bug-loop / malicious flood before it hammers every pooled key indefinitely.
// Deliberately generous-but-present (not unlimited — a runaway drains the whole pool otherwise).
const uploadLimiter = createRateLimiter({ max: Number(process.env.UPLOAD_RATE_MAX) || 120 });

// #1 PDF: map lib/pdf's typed PdfError codes to an HTTP status + a FIXED client message.
// The message NEVER interpolates the code or any library internals (SOP §7.2). TOO_LARGE
// (byte cap OR the render-pixel-dimension cap) is a 413; every other reject is a 422.
const PDF_ERR_STATUS = { TOO_LARGE: 413, NOT_PDF: 422, CORRUPT: 422, ENCRYPTED: 422, EMPTY: 422 };
const PDF_ERR_MSG = {
  TOO_LARGE: 'a PDF was too large to process',
  NOT_PDF: 'a file was not a readable PDF',
  CORRUPT: 'a PDF could not be read',
  ENCRYPTED: 'a PDF is password-protected; please remove the password and resend',
  EMPTY: 'a PDF had no pages',
};

function isPdfBuffer(buf) {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Strip a data-URI prefix ("data:image/png;base64,") if the client sent one.
function stripDataUri(s) {
  const m = /^data:[^;]*;base64,/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

// #7 mass upload: failed[].reason from lib/massupload is RAW server-side error text
// (SOP §7.2 — client-facing responses must never leak internals like stack frames,
// file paths, or connection details). Rebuild each failed entry with a fixed,
// non-identifying message; log the raw reasons server-side for debugging.
function sanitizeSummary(summary) {
  const failed = (summary.failed || []).map(f => (
    'receipt_index' in f
      ? { image_index: f.image_index, receipt_index: f.receipt_index, reason: 'could not save receipt' }
      : { image_index: f.image_index, reason: 'could not read image' }
  ));
  return { ...summary, failed };
}

function duplicateInfo(expense) {
  const reasons = expense && expense.anomaly && Array.isArray(expense.anomaly.reasons)
    ? expense.anomaly.reasons : [];
  const dup = reasons.find((r) => r && r.type === 'duplicate');
  if (!dup) return null;
  const detail = String(dup.detail || '');
  const m = detail.match(/matches existing expense\s+([^\s)]+)/i);
  return {
    expense_id: expense.id || null,
    existing_expense_id: m ? m[1] : null,
    duplicate_detail: detail || 'possible duplicate',
  };
}

module.exports = function mountUpload(app, deps = {}) {
  const runBatch = deps.runBatch || realRunBatch;
  // Resolve via 'in deps' so a test can force the unavailable (503) path with an explicit undefined,
  // regardless of whether Barat's ocr.extractReceipts has merged yet. Resolution happens at mount
  // time (server boot), so the 503 lifts on the next restart after ocr.extractReceipts merges.
  const extractReceipts = ('extractReceipts' in deps) ? deps.extractReceipts : ocr.extractReceipts;
  const assembleExpense = ('assembleExpense' in deps) ? deps.assembleExpense : ocr.assembleExpense;
  const getFieldSpec = deps.getFieldSpec || templates.getFieldSpec;
  const rasterizePdf = deps.rasterizePdf || pdf.rasterizePdf;
  const uploadReceiptImage = deps.uploadReceiptImage || storage.uploadReceiptImage;

  app.post('/api/upload', uploadLimiter, checkDash, express.json({ limit: '10mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const images = req.body && req.body.images;
      if (!Array.isArray(images) || images.length === 0 || images.some(s => typeof s !== 'string' || s === '')) {
        return res.status(400).json({ error: 'images must be a non-empty array of base64 strings' });
      }
      if (images.length > MAX_IMAGES) return res.status(413).json({ error: 'too many images (max ' + MAX_IMAGES + ')' });
      if (typeof extractReceipts !== 'function') return res.status(503).json({ error: 'mass upload not available yet' });

      const buffers = images.map(s => Buffer.from(stripDataUri(s), 'base64'));

      // Expand any PDF item into its rendered page images (a PDF page is just another
      // image for runBatch); non-PDF items pass straight through. rasterizePdf enforces
      // its own byte/page/pixel caps and throws a typed PdfError, which we map to a safe
      // 413/422 here. A PDF rejection fails the whole request (not a best-effort item)
      // so the client gets an actionable status.
      let pagesTruncated = false;
      let expanded;
      try {
        expanded = [];
        for (const buf of buffers) {
          if (isPdfBuffer(buf)) {
            const { pages, truncated } = await rasterizePdf(buf);
            if (truncated) pagesTruncated = true;
            for (const p of pages) expanded.push(p);
          } else {
            expanded.push(buf);
          }
        }
      } catch (e) {
        const code = e && e.code;
        if (code && PDF_ERR_STATUS[code]) return res.status(PDF_ERR_STATUS[code]).json({ error: PDF_ERR_MSG[code] });
        throw e; // not a PdfError → generic 502 via the outer catch (no internals leaked)
      }
      // Defensive: a batch of PDFs can expand past MAX_IMAGES pages — bound the Groq
      // call count (cost/DoS) and surface the truncation, same knob as the input cap.
      if (expanded.length > MAX_IMAGES) { expanded.length = MAX_IMAGES; pagesTruncated = true; }

      const fieldSpec = await getFieldSpec();
      const meta = { repName: 'Dashboard', fileId: null };
      // Business mode (multiUser, Phase 3): stamp the capturer's branch onto every row so
      // branch/staff reports + exports can attribute it. req.user is the session resolved by
      // checkDash — a clerk captures to their own branch, an admin to their Head Office branch
      // (both carried on the session's branch_id). Personal mode: req.user is undefined → the
      // field stays absent and rows are untagged (unchanged). staff_user_id is set by the bot's
      // "which staff?" step; the dashboard leaves it null in v1. (Persistence of these onto the
      // row is assembleExpense's job — lib/ocr.js, Barat — this only supplies the context.)
      if (req.user && req.user.branch_id) meta.branch_id = req.user.branch_id;
      // ADR-023 Phase 8: stamp the capturer's company beside their branch (multi-company clients),
      // from the same session source. Absent when the session carries no company (additive).
      if (req.user && req.user.company_id) meta.company_id = req.user.company_id;
      // ADR-018: upload each image (a PDF is already rasterized to a page image here) to the
      // private `receipts` bucket and carry its object path per-image as `receipt_url`, so
      // assembleExpense stores a durable URL — the dashboard-upload path had NO image before.
      // Fail-safe: uploadReceiptImage never throws (null on error) -> receipt_url null -> row
      // still saves imageless. Parallel; order preserved so metas[i] aligns with expanded[i].
      const metas = await Promise.all(expanded.map(async (buf) => {
        const path = await uploadReceiptImage(buf);
        return { ...meta, receipt_url: path || null };
      }));
      // QA report #1: the dashboard upload result only ever showed bare counts (1 SAVED /
      // 0 FAILED...) with no indication of WHAT was actually read off the receipt — users
      // couldn't tell whether the extraction was even correct, which read as "maybe it
      // didn't upload". The bot's own batch summary already lists merchant/amount/category
      // per saved receipt (lib/bot.js's captureAssemble) — mirror that same wrapper here so
      // the dashboard can show it too, plus the row id for a "View in Activity" link.
      const savedItems = [];
      const flaggedDetails = [];
      const captureAssemble = async (args) => {
        const result = await assembleExpense(args);
        if (result && result.expense && !result.skipped) {
          const e = result.expense;
          savedItems.push({
            id: e.id, merchant: e.merchant, amount: e.amount, currency: e.currency,
            category: e.category, voucher_no: e.voucher_no,
            branch_id: e.branch_id || null,
            staff_user_id: e.staff_user_id || null,
          });
          if (result.flagged) {
            flaggedDetails.push(duplicateInfo(e) || { expense_id: e.id || null });
          }
        }
        return result;
      };
      const summary = await runBatch(expanded, fieldSpec, { extractReceipts, assembleExpense: captureAssemble, meta, metas });
      if (summary.failed && summary.failed.length) console.error('[api/upload] failures:', JSON.stringify(summary.failed));
      const out = sanitizeSummary(summary);
      if (Array.isArray(out.flagged) && flaggedDetails.length) {
        out.flagged = out.flagged.map((f, i) => ({ ...f, ...(flaggedDetails[i] || {}) }));
      }
      out.saved_items = savedItems;
      if (pagesTruncated) out.pages_truncated = true;
      res.json(out);
    } catch (e) {
      console.error('[api/upload]', e && e.message);
      res.status(502).json({ error: 'upload failed' });
    }
  });
};
