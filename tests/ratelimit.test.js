'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/ratelimit');

// Fake req/res: req carries an ip; res records status/json/headers. next() increments a counter.
function ctx(ip) {
  const res = {
    statusCode: 200, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nexted = 0;
  return { req: { ip }, res, next: () => { nexted++; }, passed: () => nexted };
}

test('createRateLimiter: allows up to max, then 429s within the window', () => {
  let t = 1000;
  const rl = createRateLimiter({ max: 3, windowMs: 60000, now: () => t });
  const results = [];
  for (let i = 0; i < 5; i++) { const c = ctx('1.1.1.1'); rl(c.req, c.res, c.next); results.push(c.res.statusCode); }
  assert.deepStrictEqual(results, [200, 200, 200, 429, 429]); // 3 pass, rest blocked
});

test('the window resets: after windowMs the same IP is allowed again', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  const a = ctx('2.2.2.2'); rl(a.req, a.res, a.next);
  const b = ctx('2.2.2.2'); rl(b.req, b.res, b.next);
  assert.strictEqual(a.res.statusCode, 200);
  assert.strictEqual(b.res.statusCode, 429);           // blocked in the same window
  t += 1001;                                            // advance past the window
  const c = ctx('2.2.2.2'); rl(c.req, c.res, c.next);
  assert.strictEqual(c.res.statusCode, 200);           // allowed again
});

test('limits are per-IP: one noisy IP does not throttle another', () => {
  let t = 5;
  const rl = createRateLimiter({ max: 1, windowMs: 60000, now: () => t });
  const a1 = ctx('10.0.0.1'); rl(a1.req, a1.res, a1.next);
  const a2 = ctx('10.0.0.1'); rl(a2.req, a2.res, a2.next); // same IP, 2nd -> blocked
  const b1 = ctx('10.0.0.2'); rl(b1.req, b1.res, b1.next); // different IP -> allowed
  assert.strictEqual(a1.res.statusCode, 200);
  assert.strictEqual(a2.res.statusCode, 429);
  assert.strictEqual(b1.res.statusCode, 200);
});

test('a 429 sets a Retry-After header and a fixed non-leaky body', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 30000, now: () => t });
  const a = ctx('3.3.3.3'); rl(a.req, a.res, a.next);
  const b = ctx('3.3.3.3'); rl(b.req, b.res, b.next);
  assert.strictEqual(b.res.statusCode, 429);
  assert.strictEqual(b.res.body.error, 'rate limit exceeded'); // fixed message, no internals
  assert.ok(Number(b.res.headers['Retry-After']) > 0);
  assert.strictEqual(b.passed(), 0); // next() never called on a blocked request
});

test('a missing IP still counts (fail-safe: unknown clients share one bucket, never bypass)', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 60000, now: () => t });
  const a = ctx(undefined); rl(a.req, a.res, a.next);
  const b = ctx(undefined); rl(b.req, b.res, b.next);
  assert.strictEqual(a.res.statusCode, 200);
  assert.strictEqual(b.res.statusCode, 429); // both fell into the 'unknown' bucket
});

test('createRateLimiter rejects a non-positive max', () => {
  assert.throws(() => createRateLimiter({ max: 0 }), /positive number/);
  assert.throws(() => createRateLimiter({ max: -5 }), /positive number/);
});
