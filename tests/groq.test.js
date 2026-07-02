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
