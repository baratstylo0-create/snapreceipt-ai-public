'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('all modules import without throwing', () => {
  assert.doesNotThrow(() => {
    require('../lib/config'); require('../lib/http'); require('../lib/groq');
    require('../lib/supabase'); require('../lib/telegram'); require('../lib/money');
    require('../lib/categorize'); require('../lib/ocr'); require('../lib/bot');
    require('../lib/currency'); require('../lib/reports'); require('../lib/agent');
    require('../lib/massupload');
    require('../routes/webhook'); require('../routes/expenses');
    require('../routes/receipt'); require('../routes/reports'); require('../routes/templates'); require('../routes/excel'); require('../routes/misc');
    require('../routes/agent');
    require('../routes/upload');
  });
});

test('GET /health returns ok JSON', async () => {
  const express = require('express');
  const mountMisc = require('../routes/misc');
  const app = express();
  mountMisc(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health');
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.service, 'receipt-saas');
  } finally { server.close(); }
});
