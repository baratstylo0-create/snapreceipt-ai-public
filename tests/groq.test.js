'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { groqChatTools } = require('../lib/groq');

// Stub global.fetch so groqChatTools -> hreq -> fetch never hits the network.
// Same hermetic pattern as tests/ocr.test.js / tests/currency.test.js.
function stubGroq(respond) {
  const realFetch = global.fetch;
  let lastBody = null;
  global.fetch = async (_url, opt) => {
    lastBody = JSON.parse(opt.body);
    return { text: async () => JSON.stringify(respond(lastBody)) };
  };
  return { restore: () => { global.fetch = realFetch; }, sent: () => lastBody };
}

test('groqChatTools forwards tools/tool_choice and returns the full assistant message on a plain-text reply', async () => {
  const stub = stubGroq(() => ({ choices: [{ message: { role: 'assistant', content: 'the total is $42' } }] }));
  try {
    const tools = [{ type: 'function', function: { name: 'getReport', parameters: {} } }];
    const msg = await groqChatTools([{ role: 'user', content: 'how much did I spend?' }], { tools, tool_choice: 'auto' });
    assert.strictEqual(msg.role, 'assistant');
    assert.strictEqual(msg.content, 'the total is $42');
    assert.strictEqual(msg.tool_calls, undefined);
    assert.deepStrictEqual(stub.sent().tools, tools);
    assert.strictEqual(stub.sent().tool_choice, 'auto');
  } finally {
    stub.restore();
  }
});

test('groqChatTools returns tool_calls when the model emits them', async () => {
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'getReport', arguments: '{"period":"month"}' } }];
  const stub = stubGroq(() => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] }));
  try {
    const msg = await groqChatTools([{ role: 'user', content: 'monthly report please' }], { tools: [{ type: 'function', function: { name: 'getReport' } }] });
    assert.strictEqual(msg.content, null);
    assert.deepStrictEqual(msg.tool_calls, toolCalls);
  } finally {
    stub.restore();
  }
});

test('groqChatTools retries on a 429-shaped error body then succeeds', async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    calls++;
    if (calls < 2) return { text: async () => JSON.stringify({ error: { message: 'rate limit exceeded' } }) };
    return { text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
  };
  try {
    const msg = await groqChatTools([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(msg.content, 'ok');
    assert.strictEqual(calls, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('groqChatTools does not send tools/tool_choice when not provided', async () => {
  const stub = stubGroq(() => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  try {
    await groqChatTools([{ role: 'user', content: 'hi' }]);
    assert.strictEqual('tools' in stub.sent(), false);
    assert.strictEqual('tool_choice' in stub.sent(), false);
  } finally {
    stub.restore();
  }
});

// QA (Tier-2, adversarial): malformed/empty provider responses must degrade to a
// safe assistant stub rather than throw an undefined-access — the #9 agent loop
// reads msg.content / msg.tool_calls and would crash on undefined. Also confirms a
// non-rate-limit error is NOT retried (returns immediately, no 6s backoff storm).
test('groqChatTools degrades safely on malformed/empty responses (no throw)', async () => {
  const shapes = [
    {},                                   // no choices, no error
    { choices: [] },                      // empty choices array
    { choices: [{}] },                    // choice present but no message
    { error: { message: 'invalid_api_key' } } // a non-429 error shape
  ];
  for (const shape of shapes) {
    const stub = stubGroq(() => shape);
    try {
      const t0 = Date.now();
      const msg = await groqChatTools([{ role: 'user', content: 'x' }]);
      assert.strictEqual(msg.role, 'assistant', `role fallback for ${JSON.stringify(shape)}`);
      assert.strictEqual(msg.content, '', `content fallback for ${JSON.stringify(shape)}`);
      assert.strictEqual(msg.tool_calls, undefined);
      // must not have entered the retry/backoff path for a non-rate-limit shape
      assert.ok(Date.now() - t0 < 500, `should not back off for ${JSON.stringify(shape)}`);
    } finally {
      stub.restore();
    }
  }
});

// QA (Tier-2, adversarial): a persistent 429-shaped body must retry exactly 4 times
// (attempts 0..3) and then rethrow '429' — proves the backoff isn't silently dropped
// and the loop doesn't swallow a permanent rate-limit into a bogus empty success.
test('groqChatTools rethrows 429 after exhausting all 4 attempts', async () => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    calls++;
    return { text: async () => JSON.stringify({ error: { message: 'rate limit exceeded (429)' } }) };
  };
  try {
    await assert.rejects(
      () => groqChatTools([{ role: 'user', content: 'x' }]),
      /429/
    );
    assert.strictEqual(calls, 4, 'should attempt exactly 4 times');
  } finally {
    global.fetch = realFetch;
  }
});
