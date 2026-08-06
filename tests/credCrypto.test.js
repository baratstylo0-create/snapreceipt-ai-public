'use strict';
// lib/credCrypto.js: encrypted-at-rest, RECOVERABLE secret storage (ADR-025 amendment,
// Owner-approved 2026-07-11 QA round — admins need to view a branch's password again,
// not just once). Deliberately separate from password_hash (scrypt, one-way, the ONLY
// thing login checks) — this exists purely so the plaintext can be shown again later.
const test = require('node:test');
const assert = require('node:assert');

function withKey(key, fn) {
  const saved = process.env.CRED_ENC_KEY;
  process.env.CRED_ENC_KEY = key;
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/credCrypto')];
  try {
    return fn(require('../lib/credCrypto'));
  } finally {
    if (saved === undefined) delete process.env.CRED_ENC_KEY; else process.env.CRED_ENC_KEY = saved;
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/credCrypto')];
  }
}

test('encryptSecret/decryptSecret: round-trips the exact plaintext', () => {
  withKey('a-strong-operator-secret', ({ encryptSecret, decryptSecret }) => {
    const enc = encryptSecret('Str0ngPass!!');
    assert.ok(enc && typeof enc === 'string');
    assert.notStrictEqual(enc, 'Str0ngPass!!', 'never stores plaintext');
    assert.strictEqual(decryptSecret(enc), 'Str0ngPass!!');
  });
});

test('encryptSecret: two calls for the same plaintext produce DIFFERENT ciphertext (random IV)', () => {
  withKey('a-strong-operator-secret', ({ encryptSecret }) => {
    const a = encryptSecret('same-password');
    const b = encryptSecret('same-password');
    assert.notStrictEqual(a, b);
  });
});

test('decryptSecret: tampered ciphertext -> null, never throws (GCM auth tag catches it)', () => {
  withKey('a-strong-operator-secret', ({ encryptSecret, decryptSecret }) => {
    const enc = encryptSecret('Str0ngPass!!');
    const parts = enc.split(':');
    parts[2] = parts[2].slice(0, -2) + (parts[2].slice(-2) === '00' ? '11' : '00'); // flip last byte
    assert.strictEqual(decryptSecret(parts.join(':')), null);
  });
});

test('decryptSecret: garbage/malformed input -> null, never throws', () => {
  withKey('a-strong-operator-secret', ({ decryptSecret }) => {
    assert.strictEqual(decryptSecret(''), null);
    assert.strictEqual(decryptSecret(null), null);
    assert.strictEqual(decryptSecret('not-the-right-shape'), null);
    assert.strictEqual(decryptSecret('a:b'), null);
  });
});

test('encryptSecret/decryptSecret: no CRED_ENC_KEY configured -> both return null (never stores plaintext)', () => {
  withKey('', ({ encryptSecret, decryptSecret }) => {
    assert.strictEqual(encryptSecret('Str0ngPass!!'), null);
    assert.strictEqual(decryptSecret('anything'), null);
  });
});

test('decryptSecret: ciphertext encrypted under a DIFFERENT key -> null', () => {
  const enc = withKey('key-one', ({ encryptSecret }) => encryptSecret('Str0ngPass!!'));
  withKey('key-two', ({ decryptSecret }) => {
    assert.strictEqual(decryptSecret(enc), null);
  });
});
