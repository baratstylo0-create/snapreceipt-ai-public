'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { convertCurrency, _resetCache } = require('../lib/currency');

// Stub global.fetch so tests never hit the real FX API. Returns a Frankfurter-shaped body.
function stubFetch(ratesByTo, { fail = false } = {}) {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (fail) throw new Error('network down');
    return { text: async () => JSON.stringify({ amount: 1, base: 'X', date: '2026-06-12', rates: ratesByTo }) };
  };
  return () => calls;
}
const realFetch = global.fetch;
function restore() { global.fetch = realFetch; }

test('same currency → rate 1, no API call', async () => {
  _resetCache();
  const getCalls = stubFetch({});
  try {
    const r = await convertCurrency(100, 'USD', 'USD');
    assert.deepStrictEqual(r, { amount: 100, rate: 1, from: 'USD', to: 'USD', ok: true });
    assert.strictEqual(getCalls(), 0, 'must not call the FX API for same currency');
  } finally { restore(); }
});

test('converts using the fetched rate and rounds to 2dp', async () => {
  _resetCache();
  stubFetch({ MYR: 4.5 });
  try {
    const r = await convertCurrency(10, 'usd', 'myr'); // case-insensitive
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rate, 4.5);
    assert.strictEqual(r.amount, 45); // 10 * 4.5
    assert.strictEqual(r.from, 'USD');
    assert.strictEqual(r.to, 'MYR');
  } finally { restore(); }
});

test('caches the rate — second call does not re-fetch', async () => {
  _resetCache();
  const getCalls = stubFetch({ EUR: 0.9 });
  try {
    await convertCurrency(10, 'USD', 'EUR');
    await convertCurrency(20, 'USD', 'EUR');
    assert.strictEqual(getCalls(), 1, 'rate should be cached after the first fetch');
  } finally { restore(); }
});

test('API failure → keeps original amount, ok:false (never guesses a rate)', async () => {
  _resetCache();
  stubFetch({}, { fail: true });
  try {
    const r = await convertCurrency(10, 'USD', 'MYR');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.amount, 10, 'original amount preserved on failure');
    assert.strictEqual(r.rate, null);
    assert.strictEqual(r.reason, 'fx_unavailable');
  } finally { restore(); }
});

test('invalid currency code → ok:false, no API call', async () => {
  _resetCache();
  const getCalls = stubFetch({ MYR: 4.5 });
  try {
    const r = await convertCurrency(10, 'US', 'MYR'); // "US" is not a 3-letter code
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_currency');
    assert.strictEqual(r.amount, 10);
    assert.strictEqual(getCalls(), 0);
  } finally { restore(); }
});
