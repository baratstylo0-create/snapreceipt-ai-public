'use strict';
// Tests for lib/groqkeys.js (ADR-016 Groq multi-key pool). Pure, no network.
// We toggle process.env around each case; keyPool reads env fresh each call.
const { test } = require('node:test');
const assert = require('node:assert');
const { keyPool, pickKey, nextKey } = require('../lib/groqkeys');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('keyPool: parses comma list, trims, drops empties', () => {
  withEnv({ GROQ_KEYS: ' k1 , k2,, k3 ,', GROQ_KEY: undefined }, () => {
    assert.deepStrictEqual(keyPool(), ['k1', 'k2', 'k3']);
  });
});

test('keyPool: falls back to GROQ_KEY when GROQ_KEYS unset', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: 'solo' }, () => {
    assert.deepStrictEqual(keyPool(), ['solo']);
  });
});

test('keyPool: falls back to GROQ_KEY when GROQ_KEYS is empty/whitespace-only', () => {
  withEnv({ GROQ_KEYS: '  , ,', GROQ_KEY: 'solo' }, () => {
    assert.deepStrictEqual(keyPool(), ['solo']);
  });
});

test('keyPool: SUPERSEDE — GROQ_KEYS wins, GROQ_KEY ignored when GROQ_KEYS is non-empty', () => {
  // Owner/Barat decision (spec): GROQ_KEYS supersedes GROQ_KEY (benign failure mode —
  // a stale GROQ_KEY just goes unused rather than poisoning the pool with a dead key).
  withEnv({ GROQ_KEYS: 'a,b', GROQ_KEY: 'stale-old-key' }, () => {
    const pool = keyPool();
    assert.deepStrictEqual(pool, ['a', 'b']);
    assert.ok(!pool.includes('stale-old-key'), 'GROQ_KEY must NOT leak into a set GROQ_KEYS pool');
  });
});

test('keyPool: [] when neither is set', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: undefined }, () => {
    assert.deepStrictEqual(keyPool(), []);
  });
});

test('keyPool: [] when GROQ_KEY is empty and GROQ_KEYS unset', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: '   ' }, () => {
    assert.deepStrictEqual(keyPool(), []);
  });
});

test('pickKey: returns a member of the pool', () => {
  withEnv({ GROQ_KEYS: 'a,b,c', GROQ_KEY: undefined }, () => {
    for (let i = 0; i < 50; i++) assert.ok(['a', 'b', 'c'].includes(pickKey()));
  });
});

test('pickKey: null on empty pool', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: undefined }, () => {
    assert.strictEqual(pickKey(), null);
  });
});

test('pickKey: single-key pool always returns that key', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: 'solo' }, () => {
    for (let i = 0; i < 10; i++) assert.strictEqual(pickKey(), 'solo');
  });
});

test('pickKey: statistically uses more than one key over many calls', () => {
  withEnv({ GROQ_KEYS: 'a,b,c,d', GROQ_KEY: undefined }, () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(pickKey());
    assert.ok(seen.size > 1, 'random pick should exercise more than one key across 200 calls');
  });
});

test('nextKey: never returns a tried key; returns null when all tried', () => {
  withEnv({ GROQ_KEYS: 'a,b,c', GROQ_KEY: undefined }, () => {
    const tried = new Set();
    for (let i = 0; i < 3; i++) {
      const k = nextKey(tried);
      assert.ok(k !== null && !tried.has(k), 'nextKey returned a fresh untried key');
      tried.add(k);
    }
    assert.deepStrictEqual([...tried].sort(), ['a', 'b', 'c']); // fell through all keys once each
    assert.strictEqual(nextKey(tried), null); // exhausted
  });
});

test('nextKey: random among the untried', () => {
  withEnv({ GROQ_KEYS: 'a,b,c,d', GROQ_KEY: undefined }, () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(nextKey(new Set(['a']))); // 'a' always excluded
    assert.ok(!seen.has('a'), 'never returns the tried key');
    assert.ok(seen.size > 1, 'random among the untried across many calls');
  });
});

test('nextKey: null on empty pool', () => {
  withEnv({ GROQ_KEYS: undefined, GROQ_KEY: undefined }, () => {
    assert.strictEqual(nextKey(new Set()), null);
  });
});

test('nextKey: tolerates a non-Set / undefined tried arg (treats as none tried)', () => {
  withEnv({ GROQ_KEYS: 'a,b', GROQ_KEY: undefined }, () => {
    assert.ok(['a', 'b'].includes(nextKey()));         // undefined
    assert.ok(['a', 'b'].includes(nextKey(null)));     // null
  });
});
