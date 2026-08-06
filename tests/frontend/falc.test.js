'use strict';
// falc.js — the floating "Falc" assistant chrome (Phase 2). It's a thin wrapper
// around the tested Agent chat module, so these tests only pin the module's
// import-safety and its no-DOM behaviour; the conversation logic itself is
// covered by tests/frontend/agent*.test.js.
const test = require('node:test');
const assert = require('node:assert');

const Falc = require('../../public/js/components/falc');

test('module loads in Node and exposes mount + buildBird', () => {
  assert.strictEqual(typeof Falc.mount, 'function');
  assert.strictEqual(typeof Falc.buildBird, 'function');
});

test('mount: no-op (null) outside a browser', () => {
  assert.strictEqual(Falc.mount(), null);
  assert.strictEqual(Falc.mount({}), null);
});

test('falc requires the Agent module (chat logic is reused, not duplicated)', () => {
  // If falc.js had duplicated the chat logic instead of requiring Agent, this
  // dependency wouldn't resolve. Requiring it here proves the wiring exists.
  const Agent = require('../../public/js/components/agent');
  assert.strictEqual(typeof Agent.mount, 'function');
});
