'use strict';
// Phase 6 (ADR-021): business-mode login. Two pure surfaces, node-testable with no DOM:
//  - authgate.authState gains a multiUser branch: business + no token → 'login' (a username/
//    password screen, NOT the token box); business + a session token → 'enter'. Personal
//    (multiUser falsy) is byte-for-byte the old decision table.
//  - components/login.js validateCredentials: trims and requires both fields (mirrors the
//    server's 400 rule so the form can fail fast without a round-trip).
const test = require('node:test');
const assert = require('node:assert');
const { authState } = require('../../public/js/authgate');
const { validateCredentials } = require('../../public/js/components/login');

test('business mode + no token → login (never the token prompt)', () => {
  assert.strictEqual(authState({ authRequired: true, multiUser: true, storedToken: null }), 'login');
  assert.strictEqual(authState({ authRequired: true, multiUser: true, storedToken: '  ' }), 'login');
});

test('business mode + a stored session token → enter', () => {
  assert.strictEqual(authState({ authRequired: true, multiUser: true, storedToken: 'sess-abc' }), 'enter');
});

test('business mode wins even when authRequired is false (login is the only gate)', () => {
  assert.strictEqual(authState({ authRequired: false, multiUser: true, storedToken: null }), 'login');
});

test('personal mode (multiUser falsy/absent) keeps the old table exactly', () => {
  assert.strictEqual(authState({ authRequired: true, storedToken: null }), 'prompt');
  assert.strictEqual(authState({ authRequired: true, multiUser: false, storedToken: null }), 'prompt');
  assert.strictEqual(authState({ authRequired: false, storedToken: null }), 'enter');
});

test('validateCredentials: trims, requires both fields', () => {
  assert.deepStrictEqual(validateCredentials('  bob  ', 'hunter22xx'), { ok: true, username: 'bob', password: 'hunter22xx' });
  assert.strictEqual(validateCredentials('', 'x').ok, false);
  assert.strictEqual(validateCredentials('bob', '').ok, false);
  assert.strictEqual(validateCredentials('   ', 'pw').ok, false);
  assert.strictEqual(validateCredentials(null, null).ok, false);
  assert.ok(validateCredentials('', '').error, 'carries a user-facing error message');
});

test('validateCredentials: password is NOT trimmed (spaces may be intentional)', () => {
  const r = validateCredentials('bob', '  pw with spaces  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.password, '  pw with spaces  ');
});
