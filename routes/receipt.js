'use strict';
const { cfg } = require('../lib/config');
const { hreq: realHreq } = require('../lib/http');
const { tgFileUrl: realTgFileUrl } = require('../lib/telegram');
const { checkDash, dashOrigin } = require('./expenses');

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
