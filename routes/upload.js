'use strict';
const express = require('express');
const { checkDash } = require('./expenses');
const { runBatch: realRunBatch } = require('../lib/massupload');
const ocr = require('../lib/ocr');
const templates = require('../lib/templates');

const MAX_IMAGES = Number(process.env.MASS_MAX_IMAGES) || 10;

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

module.exports = function mountUpload(app, deps = {}) {
  const runBatch = deps.runBatch || realRunBatch;
  // Resolve via 'in deps' so a test can force the unavailable (503) path with an explicit undefined,
  // regardless of whether Barat's ocr.extractReceipts has merged yet.
  const extractReceipts = ('extractReceipts' in deps) ? deps.extractReceipts : ocr.extractReceipts;
  const assembleExpense = ('assembleExpense' in deps) ? deps.assembleExpense : ocr.assembleExpense;
  const getFieldSpec = deps.getFieldSpec || templates.getFieldSpec;

  app.post('/api/upload', checkDash, express.json({ limit: '10mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const images = req.body && req.body.images;
      if (!Array.isArray(images) || images.length === 0 || images.some(s => typeof s !== 'string' || s === '')) {
        return res.status(400).json({ error: 'images must be a non-empty array of base64 strings' });
      }
      if (images.length > MAX_IMAGES) return res.status(413).json({ error: 'too many images (max ' + MAX_IMAGES + ')' });
      if (typeof extractReceipts !== 'function') return res.status(503).json({ error: 'mass upload not available yet' });

      const buffers = images.map(s => Buffer.from(stripDataUri(s), 'base64'));
      const fieldSpec = await getFieldSpec();
      const meta = { repName: 'Dashboard', fileId: null };
      const summary = await runBatch(buffers, fieldSpec, { extractReceipts, assembleExpense, meta });
      if (summary.failed && summary.failed.length) console.error('[api/upload] failures:', JSON.stringify(summary.failed));
      res.json(sanitizeSummary(summary));
    } catch (e) {
      console.error('[api/upload]', e && e.message);
      res.status(502).json({ error: 'upload failed' });
    }
  });
};
