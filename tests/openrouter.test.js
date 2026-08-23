'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orChat, orChatTools } = require('../lib/openrouter');
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

// 2026-07-22 (Owner-reported live incident): a non-rate API error used to be TOTALLY
// silent — a live batch failed with zero explanation, not even in server logs. Confirmed
// live that THIS incident's actual cause was a stale VISION_MODEL env override, not this
// gap — but the gap is real regardless: any future non-rate API error (bad model id,
// insufficient balance, access revoked) would vanish the same way. Must be logged.
test('a non-rate error reply is logged with the model and a snippet of the error, not silently swallowed', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify({ error: { message: 'invalid model ID', code: 400 } }) });
  const realError = console.error;
  const errored = [];
  console.error = (line) => errored.push(line);
  try {
    await orChat([{ role: 'user', content: 'hi' }], { model: 'some/bad-model' });
    assert.strictEqual(errored.length, 1, 'exactly one error log for the unrecovered API error');
    const rec = JSON.parse(errored[0]);
    assert.strictEqual(rec.level, 'error');
    assert.strictEqual(rec.where, 'openrouter.callOpenRouter');
    assert.strictEqual(rec.model, 'some/bad-model');
    assert.ok(rec.msg.includes('invalid model ID'), 'carries the actual API error, not a generic message');
  } finally {
    console.error = realError;
    global.fetch = realFetch;
  }
});

test('a successful call never logs an error', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { content: 'ok' } }] }));
  const realError = console.error;
  const errored = [];
  console.error = (line) => errored.push(line);
  try {
    await orChat([{ role: 'user', content: 'hi' }], { model: 'meta-llama/llama-4-scout' });
    assert.strictEqual(errored.length, 0);
  } finally {
    console.error = realError;
    s.restore();
  }
});

// --- orChatTools (2026-08-19, Falc moved off Groq — the account's only GROQ_KEY was
// invalid, a full outage for every user). Mirrors lib/groq.js's groqChatTools contract
// byte-for-byte: same call shape, returns the FULL assistant message (incl. tool_calls),
// defaults to a blank assistant stub on failure — see tests/groq.test.js's equivalent suite.

test('orChatTools forwards tools/tool_choice and returns the full assistant message on a plain-text reply', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: 'the total is $42' } }] }));
  try {
    const tools = [{ type: 'function', function: { name: 'getReport', parameters: {} } }];
    const msg = await orChatTools([{ role: 'user', content: 'how much did I spend?' }], { model: 'meta-llama/llama-3.3-70b-instruct', tools, tool_choice: 'auto' });
    assert.strictEqual(msg.role, 'assistant');
    assert.strictEqual(msg.content, 'the total is $42');
    assert.strictEqual(msg.tool_calls, undefined);
    assert.deepStrictEqual(s.sent().tools, tools);
    assert.strictEqual(s.sent().tool_choice, 'auto');
  } finally { s.restore(); }
});

test('orChatTools returns tool_calls when the model emits them', async () => {
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'getReport', arguments: '{"period":"month"}' } }];
  const s = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] }));
  try {
    const msg = await orChatTools([{ role: 'user', content: 'monthly report please' }], { model: 'meta-llama/llama-3.3-70b-instruct', tools: [{ type: 'function', function: { name: 'getReport' } }] });
    assert.deepStrictEqual(msg.tool_calls, toolCalls);
  } finally { s.restore(); }
});

test('orChatTools does not send tools/tool_choice when not provided', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  try {
    await orChatTools([{ role: 'user', content: 'hi' }], { model: 'meta-llama/llama-3.3-70b-instruct' });
    assert.strictEqual('tools' in s.sent(), false);
    assert.strictEqual('tool_choice' in s.sent(), false);
  } finally { s.restore(); }
});

test('orChatTools degrades safely on malformed/empty responses (no throw)', async () => {
  const shapes = [
    {},                                          // no choices, no error
    { choices: [] },                             // empty choices array
    { choices: [{}] },                           // choice present but no message
    { error: { message: 'invalid_api_key' } },   // a non-429 error shape
  ];
  for (const shape of shapes) {
    const realFetch = global.fetch;
    global.fetch = async () => ({ text: async () => JSON.stringify(shape) });
    try {
      const msg = await orChatTools([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-3.3-70b-instruct' });
      assert.strictEqual(msg.role, 'assistant', `role fallback for ${JSON.stringify(shape)}`);
      assert.strictEqual(msg.content, '', `content fallback for ${JSON.stringify(shape)}`);
      assert.strictEqual(msg.tool_calls, undefined);
    } finally { global.fetch = realFetch; }
  }
});

test('orChatTools sends provider.ignore when avoidProviders is given (steers OpenRouter away from a confirmed-bad backend)', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  try {
    await orChatTools([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-3.3-70b-instruct', avoidProviders: ['DeepInfra'] });
    assert.deepStrictEqual(s.sent().provider, { ignore: ['DeepInfra'] });
  } finally { s.restore(); }
});

test('orChatTools omits provider entirely when avoidProviders is absent/empty (default OpenRouter routing, unchanged)', async () => {
  const s = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  try {
    await orChatTools([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-3.3-70b-instruct' });
    assert.strictEqual('provider' in s.sent(), false);
    s.restore();
    const s2 = stubOpenRouter(() => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    await orChatTools([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-3.3-70b-instruct', avoidProviders: [] });
    assert.strictEqual('provider' in s2.sent(), false);
    s2.restore();
  } finally { /* both already restored */ }
});

test('orChatTools logs (not silently swallows) a non-rate API error, same as orChat', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }) });
  const realError = console.error;
  const errored = [];
  console.error = (line) => errored.push(line);
  try {
    await orChatTools([{ role: 'user', content: 'x' }], { model: 'meta-llama/llama-3.3-70b-instruct' });
    assert.strictEqual(errored.length, 1);
    const rec = JSON.parse(errored[0]);
    assert.ok(rec.msg.includes('Invalid API Key'));
  } finally { console.error = realError; global.fetch = realFetch; }
});
