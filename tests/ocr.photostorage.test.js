'use strict';
// QA round finding (Issue 5, "receipt photos missing in some boxes"): traced the root
// cause to lib/storage.js's durable-image upload (ADR-018) being wired into the
// DASHBOARD upload route only (routes/upload.js) — the Telegram bot's own photo path
// (expenseFromPhoto) never saved a durable copy at all, relying solely on the live
// Telegram file_id proxy (routes/receipt.js's serveTelegram), which is fragile: bot-token
// rotation or Telegram's own file retention can make an old photo unreachable later.
//
// downloadAndStoreReceiptImage(fileUrl, deps) closes that gap for the single-photo path —
// same fail-safe contract as uploadReceiptImage itself (never throws; null just means the
// row saves without a durable image, same graceful-degrade the dashboard path already has).
const test = require('node:test');
const assert = require('node:assert');
const { downloadAndStoreReceiptImage } = require('../lib/ocr');

test('downloadAndStoreReceiptImage: downloads the bytes then stores them, returns the object path', async () => {
  const buf = Buffer.from('fake-jpeg-bytes');
  let downloadedUrl = null, uploadedBuf = null;
  const path = await downloadAndStoreReceiptImage('https://api.telegram.org/file/bot123/photos/x.jpg', {
    hreq: async (opts) => { downloadedUrl = opts.url; return buf; },
    uploadReceiptImage: async (b) => { uploadedBuf = b; return 'default/uuid.jpg'; },
  });
  assert.strictEqual(downloadedUrl, 'https://api.telegram.org/file/bot123/photos/x.jpg');
  assert.strictEqual(uploadedBuf, buf);
  assert.strictEqual(path, 'default/uuid.jpg');
});

test('downloadAndStoreReceiptImage: download failure -> null, never throws (fail-safe, same contract as uploadReceiptImage)', async () => {
  const path = await downloadAndStoreReceiptImage('https://api.telegram.org/file/bot123/photos/x.jpg', {
    hreq: async () => { throw new Error('ECONNRESET'); },
    uploadReceiptImage: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(path, null);
});

test('downloadAndStoreReceiptImage: empty/non-buffer download result -> null, upload never attempted', async () => {
  let uploadCalled = false;
  const path = await downloadAndStoreReceiptImage('https://x/y.jpg', {
    hreq: async () => Buffer.alloc(0),
    uploadReceiptImage: async () => { uploadCalled = true; return 'x'; },
  });
  assert.strictEqual(path, null);
  assert.strictEqual(uploadCalled, false);
});

test('downloadAndStoreReceiptImage: storage upload failure -> null (uploadReceiptImage\'s own fail-safe surfaces through)', async () => {
  const path = await downloadAndStoreReceiptImage('https://x/y.jpg', {
    hreq: async () => Buffer.from('bytes'),
    uploadReceiptImage: async () => null, // uploadReceiptImage's own documented fail-safe contract
  });
  assert.strictEqual(path, null);
});

test('downloadAndStoreReceiptImage: missing/garbage fileUrl -> null, never throws', async () => {
  assert.strictEqual(await downloadAndStoreReceiptImage(null, {}), null);
  assert.strictEqual(await downloadAndStoreReceiptImage('', {}), null);
});
