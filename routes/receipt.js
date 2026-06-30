'use strict';
const { cfg } = require('../lib/config');
const { hreq } = require('../lib/http');
const { tgFileUrl } = require('../lib/telegram');

module.exports = function mountReceipt(app) {
  app.get('/receipt/:fileId', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const fileId = String(req.params.fileId || '').slice(0, 400);
      if (!fileId) return res.status(400).send('missing file_id');
      const file = await tgFileUrl(fileId);
      if (!file) return res.status(404).send('not found');
      const buf = await hreq({ url: file.url, encoding: 'arraybuffer', timeout: 20000 });
      const ext = (file.path.split('.').pop() || '').toLowerCase();
      res.set('Content-Type', ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch (e) { console.error('[receipt proxy]', e.message); res.status(502).send('error'); }
  });
};
