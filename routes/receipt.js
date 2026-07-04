'use strict';
const { cfg } = require('../lib/config');
const { hreq: realHreq } = require('../lib/http');
const { tgFileUrl: realTgFileUrl } = require('../lib/telegram');
const { sbSelect: realSbSelect } = require('../lib/supabase');
const { fetchReceiptObject: realFetchReceiptObject } = require('../lib/storage');
const { checkDash, dashOrigin } = require('./expenses');

// Map a file extension to an image/pdf content-type; default to jpeg (harmless — the
// browser sniffs anyway). Shared by both serve paths (Storage object + Telegram proxy).
function ctypeForExt(ext) {
  const e = String(ext || '').toLowerCase();
  return e === 'png' ? 'image/png' : e === 'pdf' ? 'application/pdf' : e === 'webp' ? 'image/webp' : 'image/jpeg';
}

// P6 hardening — Findings 1 & 2 (docs/plans/2026-07-02-reference-frontend-qa-security.md §4.3):
//   1. This route had NO checkDash — a receipt image (highly sensitive financial data) was
//      fetchable by anyone who knew/guessed a fileId, no token required. Now gated behind the
//      same checkDash every other dashboard route uses.
//   2. Cache-Control was hardcoded to 'public, max-age=86400', which OVERRODE the security
//      middleware's 'no-store' for /receipt* paths (lib/security-headers.js sets it first via
//      app.use(), but res.set is last-write-wins and this route ran after — so the route's
//      value won). A sensitive image could be cached by a shared/public proxy. Now the route
//      sets 'private, no-store' itself so nothing caches it, anywhere.
module.exports = function mountReceipt(app, deps = {}) {
  const hreq = deps.hreq || realHreq;
  const tgFileUrl = deps.tgFileUrl || realTgFileUrl;
  const sbSelect = deps.sbSelect || realSbSelect;
  const fetchReceiptObject = deps.fetchReceiptObject || realFetchReceiptObject;

  // Stream a Telegram-hosted image via the bot-token proxy (shared by both routes).
  async function serveTelegram(res, fileId) {
    const file = await tgFileUrl(fileId);
    if (!file) { res.status(404).send('not found'); return; }
    const buf = await hreq({ url: file.url, encoding: 'arraybuffer', timeout: 20000 });
    res.set('Content-Type', ctypeForExt(file.path.split('.').pop()));
    res.send(buf);
  }

  // ADR-018: serve a receipt image BY EXPENSE ID. The row is looked up server-side so the
  // browser never learns the raw Storage object path (and can't request an arbitrary one).
  // Prefer the durable Storage copy (receipt_url); fall back to the live Telegram proxy for
  // old rows that only have a receipt_file_id. Same checkDash gate + private, no-store.
  app.get('/receipt/by-id/:id', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    res.set('Cache-Control', 'private, no-store');
    try {
      const id = String(req.params.id || '').slice(0, 100);
      if (!id) return res.status(400).send('missing id');
      const rows = await sbSelect('expenses', { eq: { id } });
      const row = rows && rows[0];
      if (!row) return res.status(404).send('not found');
      if (row.receipt_url) {
        const buf = await fetchReceiptObject(row.receipt_url);
        if (!buf) return res.status(404).send('not found');
        res.set('Content-Type', ctypeForExt(String(row.receipt_url).split('.').pop()));
        return res.send(buf);
      }
      if (row.receipt_file_id) return await serveTelegram(res, row.receipt_file_id);
      return res.status(404).send('not found');
    } catch (e) { console.error('[receipt by-id]', e.message); res.status(502).send('error'); }
  });

  app.get('/receipt/:fileId', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    // Never let anything (proxy, browser back/forward cache, CDN) retain a sensitive image.
    res.set('Cache-Control', 'private, no-store');
    try {
      const fileId = String(req.params.fileId || '').slice(0, 400);
      if (!fileId) return res.status(400).send('missing file_id');
      const file = await tgFileUrl(fileId);
      if (!file) return res.status(404).send('not found');
      const buf = await hreq({ url: file.url, encoding: 'arraybuffer', timeout: 20000 });
      const ext = (file.path.split('.').pop() || '').toLowerCase();
      res.set('Content-Type', ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
      res.send(buf);
    } catch (e) { console.error('[receipt proxy]', e.message); res.status(502).send('error'); }
  });
};
