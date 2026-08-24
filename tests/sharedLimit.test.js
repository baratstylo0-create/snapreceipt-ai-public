'use strict';
// lib/sharedLimit.js — P-04a shared (multi-instance) rate limiting, issue #37.
//
// The properties that matter: a global budget really is shared across instances, an
// unreachable store degrades to the in-process limiter rather than to nothing, a flood never
// reaches the database, and the bucket key never carries a raw IP.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const sl = require('../lib/sharedLimit');

// A fake Supabase that implements bump_rate_limit's ACTUAL semantics — a fixed window keyed
// by (bucket, window) with an atomic increment. A stub that just returned 1 would make every
// enforcement assertion below vacuous.
function fakeStore({ windowMs = 60000, fail = false } = {}) {
  const counts = new Map();
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rpc/bump_rate_limit')) return realFetch(url, opt);
    if (fail) throw new Error('simulated shared-store outage');
    const body = opt.body ? JSON.parse(opt.body) : {};
    const win = Math.floor(Date.now() / (body.p_window_ms || windowMs));
    const k = body.p_key + '|' + win;
    const next = (counts.get(k) || 0) + 1;
    counts.set(k, next);
    calls.push(body.p_key);
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls, counts };
}

function serve(middleware) {
  const a = express();
  a.set('trust proxy', true);
  a.get('/probe', middleware, (req, res) => res.json({ ok: true }));
  return a;
}

async function hit(app, { ip = '203.0.113.1' } = {}) {
  const srv = app.listen(0);
  try {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/probe', {
      headers: { 'X-Forwarded-For': ip },
    });
    return { status: r.status, limit: r.headers.get('ratelimit-limit'), remaining: r.headers.get('ratelimit-remaining') };
  } finally { srv.close(); }
}

// A fresh app per test run so layer 1's own Map never leaks between tests.
function limiter(opts) { return serve(sl.createAbuseLimiter(opts)); }

// ---- privacy ----------------------------------------------------------------

test('bucketKey: never contains the raw client identifier', () => {
  const ip = '203.0.113.42';
  const k = sl.bucketKey('auth.login', ip);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.ok(!k.includes(ip), 'a rate limiter is not a reason to start retaining IP addresses');
  assert.ok(!k.includes('203'));
});

test('bucketKey: separates endpoints, clients and salts', () => {
  const a = sl.bucketKey('auth.login', '1.2.3.4');
  assert.notStrictEqual(sl.bucketKey('auth.signup', '1.2.3.4'), a, 'two endpoints must not share a budget');
  assert.notStrictEqual(sl.bucketKey('auth.login', '5.6.7.8'), a, 'two clients must not share a budget');

  const saved = process.env.SESSION_IP_SALT;
  try {
    process.env.SESSION_IP_SALT = 'different-salt';
    assert.notStrictEqual(sl.bucketKey('auth.login', '1.2.3.4'), a, 'the salt must actually participate');
  } finally {
    if (saved === undefined) delete process.env.SESSION_IP_SALT;
    else process.env.SESSION_IP_SALT = saved;
  }
});

// ---- construction guards ----------------------------------------------------

test('createAbuseLimiter: refuses to be built without a unique name or a sane max', () => {
  assert.throws(() => sl.createAbuseLimiter({ max: 5 }), /name is required/,
    'an unnamed bucket would silently collide with another endpoint');
  assert.throws(() => sl.createAbuseLimiter({ name: 'x', max: 0 }), /positive number/);
  assert.throws(() => sl.createAbuseLimiter({ name: 'x' }), /positive number/);
});

// ---- enforcement ------------------------------------------------------------

test('enforces the global budget and then 429s', async () => {
  const store = fakeStore();
  try {
    const app = limiter({ name: 't.enforce', max: 3, localMax: 1000 });
    for (let i = 1; i <= 3; i += 1) {
      const r = await hit(app);
      assert.strictEqual(r.status, 200, 'request ' + i + ' is within budget');
    }
    const over = await hit(app);
    assert.strictEqual(over.status, 429, 'the 4th exceeds a max of 3');
    assert.strictEqual(over.remaining, '0');
  } finally { store.restore(); }
});

test('the budget is SHARED — a second instance inherits the first\'s count', async () => {
  // The entire point of the ticket. Two independently-constructed limiters model two
  // processes: separate in-memory Maps, one shared counter.
  const store = fakeStore();
  try {
    const instanceA = limiter({ name: 't.shared', max: 3, localMax: 1000 });
    const instanceB = limiter({ name: 't.shared', max: 3, localMax: 1000 });

    assert.strictEqual((await hit(instanceA)).status, 200);
    assert.strictEqual((await hit(instanceA)).status, 200);
    assert.strictEqual((await hit(instanceB)).status, 200, 'instance B, 3rd request overall');
    assert.strictEqual((await hit(instanceB)).status, 429,
      'instance B must be refused on the budget instance A already spent — this is what the in-memory limiter could not do');
  } finally { store.restore(); }
});

test('different clients get independent budgets', async () => {
  const store = fakeStore();
  try {
    const app = limiter({ name: 't.perclient', max: 2, localMax: 1000 });
    assert.strictEqual((await hit(app, { ip: '1.1.1.1' })).status, 200);
    assert.strictEqual((await hit(app, { ip: '1.1.1.1' })).status, 200);
    assert.strictEqual((await hit(app, { ip: '1.1.1.1' })).status, 429);
    assert.strictEqual((await hit(app, { ip: '2.2.2.2' })).status, 200,
      'one abusive client must not lock everybody else out');
  } finally { store.restore(); }
});

// ---- failure posture --------------------------------------------------------

test('FAILS OPEN when the shared store is unreachable', async () => {
  // A deliberate security decision, so it gets an explicit test rather than being emergent:
  // a Supabase blip must not stop everyone logging in. Protection degrades to layer 1.
  const store = fakeStore({ fail: true });
  try {
    const app = limiter({ name: 't.failopen', max: 1, localMax: 1000 });
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual((await hit(app)).status, 200,
        'an outage must not convert an availability problem into a total lockout');
    }
  } finally { store.restore(); }
});

test('but layer 1 still enforces during an outage — degraded, never absent', async () => {
  const store = fakeStore({ fail: true });
  try {
    const app = limiter({ name: 't.floor', max: 100, localMax: 2 });
    assert.strictEqual((await hit(app)).status, 200);
    assert.strictEqual((await hit(app)).status, 200);
    assert.strictEqual((await hit(app)).status, 429,
      'the in-process limiter is the floor that makes fail-open acceptable');
  } finally { store.restore(); }
});

test('a thrown store error reports UNKNOWN, never a fresh budget', async () => {
  const store = fakeStore({ fail: true });
  try {
    assert.strictEqual(await sl.bumpShared('t.null', '1.2.3.4'), null);
  } finally { store.restore(); }
});

test('a MALFORMED store response also reports UNKNOWN, not zero', async () => {
  // Distinct from the thrown-error path above, and originally untested — mutation testing
  // found the gap. The store can answer 200 with something unparseable (an error object, an
  // empty array, a schema drift). Reporting 0 there would advertise a full budget on every
  // such response, and reads as "first request in the window" to anyone debugging it.
  // Enforcement is unaffected either way (both fail open), but "unknown" and "zero" must not
  // be conflated in a limiter's own bookkeeping.
  const realFetch = global.fetch;
  for (const body of ['null', '[]', '{"message":"schema cache stale"}', '"nonsense"']) {
    global.fetch = async (url, opt) => {
      if (!String(url).includes('/rpc/bump_rate_limit')) return realFetch(url, opt);
      return { ok: true, status: 200, text: async () => body };
    };
    // eslint-disable-next-line no-await-in-loop
    const got = await sl.bumpShared('t.malformed', '1.2.3.4');
    assert.strictEqual(got, null, 'body ' + body + ' must read as unknown, got ' + got);
  }
  global.fetch = realFetch;
});

// ---- the database is not the flood absorber ---------------------------------

test('a flood is cut off by layer 1 WITHOUT reaching the database', async () => {
  // If every request in a flood spent a DB round-trip, the limiter would itself become the
  // amplification vector it exists to prevent.
  const store = fakeStore();
  try {
    const app = limiter({ name: 't.noamplify', max: 1000, localMax: 2 });
    await hit(app); await hit(app);
    const afterAllowed = store.calls.length;
    for (let i = 0; i < 10; i += 1) {
      assert.strictEqual((await hit(app)).status, 429);
    }
    assert.strictEqual(store.calls.length, afterAllowed,
      'refused requests must cost zero database round-trips, got ' + (store.calls.length - afterAllowed));
  } finally { store.restore(); }
});

// ---- opt-out ----------------------------------------------------------------

test('SHARED_RATE_LIMIT=false falls back to exactly the previous behaviour', async () => {
  const store = fakeStore();
  const saved = process.env.SHARED_RATE_LIMIT;
  try {
    process.env.SHARED_RATE_LIMIT = 'false';
    assert.strictEqual(sl.sharedEnabled(), false);
    const app = limiter({ name: 't.optout', max: 1, localMax: 1000 });
    assert.strictEqual((await hit(app)).status, 200);
    assert.strictEqual((await hit(app)).status, 200, 'the shared budget is not consulted at all');
    assert.strictEqual(store.calls.length, 0, 'and the database is never touched');
  } finally {
    if (saved === undefined) delete process.env.SHARED_RATE_LIMIT;
    else process.env.SHARED_RATE_LIMIT = saved;
    store.restore();
  }
});

test('sharedEnabled: defaults ON, and accepts the codebase\'s usual boolean spellings', () => {
  const saved = process.env.SHARED_RATE_LIMIT;
  try {
    delete process.env.SHARED_RATE_LIMIT;
    assert.strictEqual(sl.sharedEnabled(), true, 'protection must be opt-OUT, never opt-in');
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE']) {
      process.env.SHARED_RATE_LIMIT = on;
      assert.strictEqual(sl.sharedEnabled(), true, on);
    }
    for (const off of ['0', 'false', 'no', 'off']) {
      process.env.SHARED_RATE_LIMIT = off;
      assert.strictEqual(sl.sharedEnabled(), false, off);
    }
  } finally {
    if (saved === undefined) delete process.env.SHARED_RATE_LIMIT;
    else process.env.SHARED_RATE_LIMIT = saved;
  }
});

// ---- client compatibility ---------------------------------------------------

test('the 429 body and headers are identical to the in-process limiter', async () => {
  // Existing clients already handle lib/ratelimit.js's 429 shape; a second, differently-shaped
  // rejection would be a silent breaking change, and would also tell an attacker which layer
  // refused them.
  const store = fakeStore();
  try {
    const app = limiter({ name: 't.shape', max: 1, localMax: 1000 });
    await hit(app);
    const srv = app.listen(0);
    try {
      const r = await fetch('http://127.0.0.1:' + srv.address().port + '/probe', {
        headers: { 'X-Forwarded-For': '203.0.113.1' },
      });
      assert.strictEqual(r.status, 429);
      assert.deepStrictEqual(await r.json(), { error: 'rate limit exceeded' });
      assert.ok(r.headers.get('retry-after'), 'Retry-After must be present');
      assert.strictEqual(r.headers.get('ratelimit-limit'), '1');
    } finally { srv.close(); }
  } finally { store.restore(); }
});
