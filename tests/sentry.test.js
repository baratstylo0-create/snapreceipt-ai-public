'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  scrubEventForSentry,
  scrubPathForSentry,
  safeExtra,
} = require('../lib/sentry');

test('scrubPathForSentry removes ids and query strings', () => {
  assert.equal(scrubPathForSentry('/api/receipt/by-id/12345?token=secret'), '/api/receipt/by-id/:id');
  assert.equal(scrubPathForSentry('/receipt/ABCDEF1234567890ABCDEF1234567890'), '/receipt/:id');
});

test('safeExtra keeps only non-sensitive scalar context', () => {
  assert.deepEqual(safeExtra({
    status: 400,
    method: 'POST',
    newField: 'future sensitive value',
    token: 'secret',
    merchant: 'Cafe',
    amount: 123,
    nested: { body: 'nope' },
  }), {
    status: 400,
    method: 'POST',
  });
});

test('scrubEventForSentry removes request bodies, auth context, user and breadcrumbs', () => {
  const event = scrubEventForSentry({
    user: { id: 'u_123', email: 'person@example.com' },
    breadcrumbs: [{ message: 'clicked upload' }],
    request: {
      method: 'POST',
      url: 'https://example.com/api/upload/123456789012345678901234567890?token=secret',
      headers: { authorization: 'Bearer token', cookie: 'sid=1' },
      data: { merchant: 'Cafe', total: 99 },
      query_string: 'token=secret',
      cookies: { sid: '1' },
    },
    tags: {
      route: '/api/upload',
      authorization: 'Bearer token',
    },
    extra: {
      status: 500,
      receipt_url: 'secret',
      body: 'secret',
    },
    transaction: '/api/expenses/12345',
  });

  assert.equal(event.user, undefined);
  assert.equal(event.breadcrumbs, undefined);
  assert.deepEqual(event.request, { method: 'POST', url: '/api/upload/:id' });
  assert.deepEqual(event.tags, { route: '/api/upload' });
  assert.deepEqual(event.extra, { status: 500 });
  assert.equal(event.transaction, '/api/expenses/:id');
});

test('scrubEventForSentry redacts SDK-populated exception messages', () => {
  const event = scrubEventForSentry({
    message: 'HTTP 502: OCR raw said merchant Cafe total 99 card 4242',
    exception: {
      values: [{
        type: 'Error',
        value: 'HTTP 502: {"merchant":"Cafe","total":99,"ocr":"raw text","card":"4242"}',
        stacktrace: {
          frames: [{ filename: 'lib/http.js', function: 'hreq', lineno: 26 }],
        },
      }],
    },
  });

  assert.equal(event.message, '[redacted exception message]');
  assert.equal(event.exception.values[0].type, 'Error');
  assert.equal(event.exception.values[0].value, '[redacted exception message]');
  assert.deepEqual(event.exception.values[0].stacktrace.frames, [
    { filename: 'lib/http.js', function: 'hreq', lineno: 26 },
  ]);
});
