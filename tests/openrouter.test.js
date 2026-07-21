'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orChat } = require('../lib/openrouter');
const { cfg } = require('../lib/config');

// Stub global.fetch so orChat -> hreq -> fetch never hits the network.
// Same hermetic pattern as tests/ocr.test.js / tests/groq.test.js.
function stubOpenRouter(respond) {
  const realFetch = global.fetch;
  let lastUrl = null;
  let lastOpt = null;
  global.fetch = async (url, opt) => {
    lastUrl = url;
    lastOpt = opt;
    return { text: async () => JSON.stringify(respond(JSON.parse(opt.body))) };
  };
  return {
    restore: () => { global.fetch = realFetch; },
    url: () => lastUrl,
    sent: () => JSON.parse(lastOpt.body),
    headers: () => lastOpt.headers,
  };
}

test('orChat posts to the OpenRouter chat-completions endpoint with a Bearer key', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { content: 'hi there' } }] }));
  try {
    const content = await orChat([{ role: 'user', content: 'hello' }], { model: 'meta-llama/llama-4-scout' });
    assert.strictEqual(content, 'hi there');
    assert.strictEqual(s.url(), 'https://openrouter.ai/api/v1/chat/completions');
    // cfg is a load-time snapshot (dotenv loads process.env once at startup, per lib/config.js's
    // own documented gotcha) — assert against the actual live cfg value, not a re-injected env var.
    assert.strictEqual(s.headers().Authorization, 'Bearer ' + cfg.OPENROUTER_KEY);
    assert.strictEqual(s.sent().model, 'meta-llama/llama-4-scout');
  } finally {
    s.restore();
  }
});

test('orChat sends the given max_tokens/temperature and defaults to 900/0.1', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { content: 'ok' } }] }));
  try {
    await orChat([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-4-scout' });
    assert.strictEqual(s.sent().max_tokens, 900);
    assert.strictEqual(s.sent().temperature, 0.1);
    s.restore();
    const s2 = stubOpenRouter(() => ({ choices: [{ message: { content: 'ok' } }] }));
    await orChat([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-4-scout', max_tokens: 400, temperature: 0 });
    assert.strictEqual(s2.sent().max_tokens, 400);
    assert.strictEqual(s2.sent().temperature, 0);
    s2.restore();
  } finally {
    // no-op, both stubs already restored above
  }
});

test('orChat retries on a 429-shaped error body then succeeds', async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    calls++;
    if (calls < 2) return { text: async () => JSON.stringify({ error: { message: 'rate limit exceeded' } }) };
    return { text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  };
  try {
    const content = await orChat([{ role: 'user', content: 'hi' }], { model: 'meta-llama/llama-4-scout' });
    assert.strictEqual(content, 'ok');
    assert.strictEqual(calls, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('orChat throws Error("429") when every attempt is rate-limited (matches lib/groq.js contract)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify({ error: { message: 'rate limit exceeded' } }) });
  try {
    await assert.rejects(
      () => orChat([{ role: 'user', content: 'hi' }], { model: 'meta-llama/llama-4-scout' }),
      /429/
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('orChat returns empty string on a non-rate error reply (nothing to retry)', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify({ error: { message: 'invalid model' } }) });
  try {
    const content = await orChat([{ role: 'user', content: 'hi' }], { model: 'meta-llama/llama-4-scout' });
    assert.strictEqual(content, '');
  } finally {
    global.fetch = realFetch;
  }
});
