'use strict';
// Call-site tests for Groq multi-key rotation (ADR-016), Barat's lib/groq.js half.
// lib/groqkeys.js (the pool) is unit-tested separately by Jeevan; here we prove the
// FALL-THROUGH LOOP: a 429 rotates to a different key with NO sleep; a full-pool
// exhaustion falls to the existing backoff; a single-key pool is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const { groqChat } = require('../lib/groq');

// Stub global.fetch and capture the Bearer key used on each call. `respond(key, n)`
// returns the parsed JSON body Groq would send for the given key / call number.
function stubGroq(respond) {
  const realFetch = global.fetch;
  const keysUsed = [];
  let n = 0;
  global.fetch = async (_url, opt) => {
    n += 1;
    const key = String(opt.headers.Authorization || '').replace(/^Bearer /, '');
    keysUsed.push(key);
    return { text: async () => JSON.stringify(respond(key, n)) };
  };
  return { restore: () => { global.fetch = realFetch; }, keysUsed };
}

const RATE = { error: { message: 'rate limit exceeded' } };
const okReply = txt => ({ choices: [{ message: { role: 'assistant', content: txt } }] });

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => { try { return await fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  } })();
}

test('429 on the first key rotates to a DIFFERENT key with NO sleep, then succeeds', async () => {
  await withEnv({ GROQ_KEYS: 'kA,kB,kC' }, async () => {
    // Whichever key is picked first 429s; any other key succeeds.
    let firstKey = null;
    const stub = stubGroq((key) => {
      if (!firstKey) { firstKey = key; return RATE; }
      return key === firstKey ? RATE : okReply('done');
    });
    try {
      const t0 = Date.now();
      const out = await groqChat([{ role: 'user', content: 'hi' }]);
      const elapsed = Date.now() - t0;
      assert.strictEqual(out, 'done');
      assert.strictEqual(stub.keysUsed.length, 2, 'exactly one rotation: first key + one fresh key');
      assert.notStrictEqual(stub.keysUsed[1], stub.keysUsed[0], 'the retry used a DIFFERENT key');
      assert.ok(elapsed < 500, 'rotation must NOT sleep (backoff is ~1000ms) — was ' + elapsed + 'ms');
    } finally { stub.restore(); }
  });
});

test('a key is never retried twice within one rotation round (nextKey excludes tried)', async () => {
  await withEnv({ GROQ_KEYS: 'k1,k2,k3' }, async () => {
    // First two distinct keys 429; the third distinct key succeeds.
    const seen = new Set();
    const stub = stubGroq((key) => {
      if (seen.size < 2 && !seen.has(key)) { seen.add(key); return RATE; }
      return seen.has(key) && seen.size < 3 ? RATE : okReply('ok3');
    });
    try {
      const out = await groqChat([{ role: 'user', content: 'hi' }]);
      assert.strictEqual(out, 'ok3');
      const unique = new Set(stub.keysUsed);
      assert.strictEqual(unique.size, stub.keysUsed.length, 'no key repeated within the round: ' + stub.keysUsed.join(','));
      assert.strictEqual(stub.keysUsed.length, 3, 'swept all three keys once');
    } finally { stub.restore(); }
  });
});

test('full-pool exhaustion falls to BACKOFF (sleeps), then a fresh round succeeds', async () => {
  await withEnv({ GROQ_KEYS: 'kX,kY' }, async () => {
    // Round 1: both keys 429 (calls 1-2, no sleep). Pool exhausted -> backoff sleep.
    // Round 2: first call succeeds (call 3).
    const stub = stubGroq((_key, n) => (n <= 2 ? RATE : okReply('after-backoff')));
    try {
      const t0 = Date.now();
      const out = await groqChat([{ role: 'user', content: 'hi' }]);
      const elapsed = Date.now() - t0;
      assert.strictEqual(out, 'after-backoff');
      assert.strictEqual(stub.keysUsed.length, 3, 'round1: 2 keys (rotate), then round2: 1 success');
      assert.notStrictEqual(stub.keysUsed[1], stub.keysUsed[0], 'round1 rotated across both keys');
      assert.ok(elapsed >= 1000, 'pool exhaustion must incur one backoff sleep (~1000ms) — was ' + elapsed + 'ms');
    } finally { stub.restore(); }
  });
});

test('single-key pool (GROQ_KEYS unset) is unchanged: no rotation, only the one key is ever used', async () => {
  await withEnv({ GROQ_KEYS: undefined, GROQ_KEY: 'solo-key' }, async () => {
    // First call 429 -> no other key to rotate to -> backoff -> second call succeeds.
    const stub = stubGroq((_key, n) => (n < 2 ? RATE : okReply('solo-ok')));
    try {
      const out = await groqChat([{ role: 'user', content: 'hi' }]);
      assert.strictEqual(out, 'solo-ok');
      assert.deepStrictEqual([...new Set(stub.keysUsed)], ['solo-key'], 'only the single configured key is ever used');
    } finally { stub.restore(); }
  });
});

test('success on the FIRST try never rotates and never sleeps (happy path, multi-key)', async () => {
  await withEnv({ GROQ_KEYS: 'a,b,c,d' }, async () => {
    const stub = stubGroq(() => okReply('first-try'));
    try {
      const t0 = Date.now();
      const out = await groqChat([{ role: 'user', content: 'hi' }]);
      assert.strictEqual(out, 'first-try');
      assert.strictEqual(stub.keysUsed.length, 1, 'one call, no rotation on success');
      assert.ok(Date.now() - t0 < 500, 'happy path never sleeps');
    } finally { stub.restore(); }
  });
});
