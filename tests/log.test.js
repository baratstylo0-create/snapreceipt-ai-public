'use strict';
// #12 structured logging (Phase 1). lib/log emits ONE parseable JSON line per event so a
// host's aggregator can search/alert. ADR-002 is the hard rule: it must NEVER emit request
// bodies, receipt bytes, PII, or nested objects — message text (capped) + scalar extras only.
const test = require('node:test');
const assert = require('node:assert');
const { logError, logWarn } = require('../lib/log');

// capture console.error / console.warn for one call, return the emitted string
function capture(method, fn) {
  const orig = console[method];
  let out = null;
  console[method] = (s) => { out = s; };
  try { fn(); } finally { console[method] = orig; }
  return out;
}

test('logError emits a single line of valid JSON with ts/level/where/msg', () => {
  const line = capture('error', () => logError('unhandled', new Error('boom')));
  assert.ok(!line.includes('\n'), 'single line');
  const o = JSON.parse(line);
  assert.strictEqual(o.level, 'error');
  assert.strictEqual(o.where, 'unhandled');
  assert.strictEqual(o.msg, 'boom');
  assert.ok(!Number.isNaN(Date.parse(o.ts)), 'ts is an ISO timestamp');
});

test('logError accepts a plain string message too (not just Error)', () => {
  const o = JSON.parse(capture('error', () => logError('ready', 'db unreachable')));
  assert.strictEqual(o.msg, 'db unreachable');
});

test('scalar extras are included; NESTED OBJECTS are dropped (ADR-002 — never log bodies/PII)', () => {
  const o = JSON.parse(capture('error', () => logError('route', new Error('x'), {
    status: 400, method: 'POST', body: { card: '4111111111111111', merchant: 'ACME' },
  })));
  assert.strictEqual(o.status, 400);
  assert.strictEqual(o.method, 'POST');
  assert.ok(!('body' in o), 'a nested object extra must never be serialized (PII guard)');
});

test('msg is length-capped (a giant error string cannot flood the logs)', () => {
  const o = JSON.parse(capture('error', () => logError('x', 'y'.repeat(5000))));
  assert.ok(o.msg.length <= 500, 'msg capped');
});

test('where is length-capped', () => {
  const o = JSON.parse(capture('error', () => logError('w'.repeat(300), 'm')));
  assert.ok(o.where.length <= 60);
});

test('logWarn emits level=warn on console.warn', () => {
  const o = JSON.parse(capture('warn', () => logWarn('ready', 'slow')));
  assert.strictEqual(o.level, 'warn');
  assert.strictEqual(o.where, 'ready');
});
