'use strict';
// Rate-limit VISIBILITY headers (requested by J2 for the frontend "% used" tracker):
// createRateLimiter must emit the IETF-draft trio on EVERY response, not just on 429,
// so a client can show remaining budget and warn near the edge. Purely additive —
// enforcement (the 429 at count > max) is unchanged, covered by ratelimit.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/ratelimit');

function ctx(ip) {
  const res = {
    statusCode: 200, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return { req: { ip }, res, next() {} };
}

test('emits RateLimit-Limit/Remaining/Reset on an ALLOWED (non-429) response', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 5, windowMs: 60000, now: () => t });
  const c = ctx('1.1.1.1'); rl(c.req, c.res, c.next);
  assert.strictEqual(c.res.statusCode, 200);
  assert.strictEqual(c.res.headers['RateLimit-Limit'], '5');
  assert.strictEqual(c.res.headers['RateLimit-Remaining'], '4', 'first of 5 -> 4 remaining');
  assert.strictEqual(c.res.headers['RateLimit-Reset'], '60', 'whole seconds left in the window');
});

test('Remaining counts down each request within the window', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 3, windowMs: 60000, now: () => t });
  const rem = [];
  for (let i = 0; i < 3; i++) { const c = ctx('2.2.2.2'); rl(c.req, c.res, c.next); rem.push(c.res.headers['RateLimit-Remaining']); }
  assert.deepStrictEqual(rem, ['2', '1', '0'], '3 allowed requests -> 2,1,0 remaining');
});

test('the headers are ALSO present on the 429 response, with Remaining floored at 0', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 30000, now: () => t });
  const ok = ctx('3.3.3.3'); rl(ok.req, ok.res, ok.next);           // consumes the 1 slot
  const blocked = ctx('3.3.3.3'); rl(blocked.req, blocked.res, blocked.next);
  assert.strictEqual(blocked.res.statusCode, 429);
  assert.strictEqual(blocked.res.headers['RateLimit-Limit'], '1');
  assert.strictEqual(blocked.res.headers['RateLimit-Remaining'], '0', 'over-limit never reports negative remaining');
  assert.strictEqual(blocked.res.headers['RateLimit-Reset'], '30');
  assert.ok(Number(blocked.res.headers['Retry-After']) >= 1, 'Retry-After still emitted on 429');
});

test('Reset shrinks as the window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 10, windowMs: 60000, now: () => t });
  const a = ctx('4.4.4.4'); rl(a.req, a.res, a.next);
  assert.strictEqual(a.res.headers['RateLimit-Reset'], '60');
  t += 45000; // 45s into the window
  const b = ctx('4.4.4.4'); rl(b.req, b.res, b.next);
  assert.strictEqual(b.res.headers['RateLimit-Reset'], '15', '15s left after 45s elapsed');
});

test('a fresh window resets Remaining back to max-1 and Reset back to full', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
  const a = ctx('5.5.5.5'); rl(a.req, a.res, a.next);
  assert.strictEqual(a.res.headers['RateLimit-Remaining'], '1');
  t += 1001; // past the window -> new bucket
  const b = ctx('5.5.5.5'); rl(b.req, b.res, b.next);
  assert.strictEqual(b.res.headers['RateLimit-Remaining'], '1', 'counter reset in the new window');
  assert.strictEqual(b.res.headers['RateLimit-Reset'], '1');
});
