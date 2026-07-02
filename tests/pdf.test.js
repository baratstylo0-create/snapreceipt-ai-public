'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// NOTE (deviation from the plan's literal snippet): lib/config.js exports { cfg,
// assertConfig }, not flat top-level constants -- every other module in the repo
// consumes it as `const { cfg } = require('./config')`. Matching that real shape here.
const { cfg } = require('../lib/config');

test('config exposes PDF knobs with sane defaults', () => {
  assert.strictEqual(typeof cfg.PDF_RENDER_DPI, 'number');
  assert.ok(cfg.PDF_RENDER_DPI >= 72);
  assert.strictEqual(typeof cfg.PDF_MAX_BYTES, 'number');
  assert.ok(cfg.PDF_MAX_BYTES > 0);
});
