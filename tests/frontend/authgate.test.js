'use strict';
// Pure auth-gate decision logic. authState() decides whether the app enters
// directly or must prompt for a dashboard token. No DOM, no network — just the
// decision table, so it is unit-testable under node:test. Written TDD first.
const test = require('node:test');
const assert = require('node:assert');
const { authState } = require('../../public/js/authgate');

test('auth not required → enter regardless of token', () => {
  assert.strictEqual(authState({ authRequired: false, storedToken: null }), 'enter');
  assert.strictEqual(authState({ authRequired: false, storedToken: 'anything' }), 'enter');
  assert.strictEqual(authState({ authRequired: false, storedToken: '' }), 'enter');
});

test('auth required + a stored token → enter', () => {
  assert.strictEqual(authState({ authRequired: true, storedToken: 'tok-123' }), 'enter');
});

test('auth required + no token → prompt', () => {
  assert.strictEqual(authState({ authRequired: true, storedToken: null }), 'prompt');
  assert.strictEqual(authState({ authRequired: true, storedToken: undefined }), 'prompt');
});

test('auth required + empty/whitespace token → prompt (blank is not a token)', () => {
  assert.strictEqual(authState({ authRequired: true, storedToken: '' }), 'prompt');
  assert.strictEqual(authState({ authRequired: true, storedToken: '   ' }), 'prompt');
});

test('authRequired is coerced to boolean (truthy config value)', () => {
  // /api/config returns a real boolean, but be defensive about truthiness.
  assert.strictEqual(authState({ authRequired: 1, storedToken: null }), 'prompt');
  assert.strictEqual(authState({ authRequired: 0, storedToken: null }), 'enter');
});

test('missing/empty argument is safe (defaults to enter, never throws)', () => {
  assert.doesNotThrow(() => authState());
  assert.doesNotThrow(() => authState({}));
  assert.strictEqual(authState(), 'enter');
  assert.strictEqual(authState({}), 'enter');
});

test('normaliseToken trims and drops blank tokens to null', () => {
  const { normaliseToken } = require('../../public/js/authgate');
  assert.strictEqual(normaliseToken('  tok  '), 'tok');
  assert.strictEqual(normaliseToken(''), null);
  assert.strictEqual(normaliseToken('   '), null);
  assert.strictEqual(normaliseToken(null), null);
  assert.strictEqual(normaliseToken(undefined), null);
});
