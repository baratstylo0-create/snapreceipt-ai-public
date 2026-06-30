'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hreq } = require('../lib/http');

test('hreq is a function and rejects on an unreachable host quickly', async () => {
  assert.strictEqual(typeof hreq, 'function');
  await assert.rejects(
    () => hreq({ url: 'http://127.0.0.1:1/never', timeout: 200 }),
    /.*/
  );
});
