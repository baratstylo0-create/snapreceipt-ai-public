'use strict';
// lib/credCrypto.js `ensureCredKey()` — auto-provisions a persistent encryption key so the
// recoverable-password feature (ADR-025 amendment) actually works on the live server without
// anyone setting CRED_ENC_KEY by hand. Owner-approved 2026-07-11: the key lives on the server
// (same box as SB_KEY), generated once and reused across restarts/redeploys.
//
// Each test drives ensureCredKey via a temp key-file path (CRED_ENC_KEY_FILE) so the repo is
// never written to; cfg is re-required per test since ensureCredKey mutates cfg.CRED_ENC_KEY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpKeyPath() {
  return path.join(os.tmpdir(), 'credkey-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.key');
}

// Run fn with a fresh require of lib/credCrypto + lib/config under the given env, then restore.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/credCrypto')];
  try {
    return fn(require('../lib/credCrypto'));
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/credCrypto')];
  }
}

test('ensureCredKey: explicit CRED_ENC_KEY env wins — returns it and writes NO file', () => {
  const keyFile = tmpKeyPath();
  withEnv({ CRED_ENC_KEY: 'operator-chosen-secret', CRED_ENC_KEY_FILE: keyFile }, ({ ensureCredKey }) => {
    const k = ensureCredKey();
    assert.strictEqual(k, 'operator-chosen-secret');
    assert.strictEqual(fs.existsSync(keyFile), false, 'must not create a key file when the env var is set');
  });
});

test('ensureCredKey: unset + no file -> generates a key, persists it, and encryption then works', () => {
  const keyFile = tmpKeyPath();
  try {
    withEnv({ CRED_ENC_KEY: '', CRED_ENC_KEY_FILE: keyFile }, ({ ensureCredKey, encryptSecret, decryptSecret }) => {
      const k = ensureCredKey();
      assert.ok(k && k.length >= 32, 'a strong key is generated');
      assert.ok(fs.existsSync(keyFile), 'the key is persisted to the file');
      assert.strictEqual(fs.readFileSync(keyFile, 'utf8').trim(), k, 'the persisted value matches the returned key');
      // ensureCredKey stamped cfg.CRED_ENC_KEY, so encrypt/decrypt now round-trip
      const enc = encryptSecret('Str0ngPass!!');
      assert.ok(enc);
      assert.strictEqual(decryptSecret(enc), 'Str0ngPass!!');
    });
  } finally { if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile); }
});

test('ensureCredKey: unset + existing file -> reuses the file key across calls (stable, not regenerated)', () => {
  const keyFile = tmpKeyPath();
  fs.writeFileSync(keyFile, 'preexisting-key-value\n');
  try {
    withEnv({ CRED_ENC_KEY: '', CRED_ENC_KEY_FILE: keyFile }, ({ ensureCredKey }) => {
      assert.strictEqual(ensureCredKey(), 'preexisting-key-value', 'reads + trims the existing file');
      assert.strictEqual(ensureCredKey(), 'preexisting-key-value', 'idempotent — same key on a second call');
      assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), 'preexisting-key-value\n', 'the existing file is left untouched');
    });
  } finally { if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile); }
});

test('ensureCredKey: a persisted key survives a "restart" so previously-encrypted data stays readable', () => {
  const keyFile = tmpKeyPath();
  try {
    // boot 1: generate key, encrypt something
    const enc = withEnv({ CRED_ENC_KEY: '', CRED_ENC_KEY_FILE: keyFile }, ({ ensureCredKey, encryptSecret }) => {
      ensureCredKey();
      return encryptSecret('branch-password-123');
    });
    // boot 2 (fresh require, same file): must decrypt what boot 1 wrote
    withEnv({ CRED_ENC_KEY: '', CRED_ENC_KEY_FILE: keyFile }, ({ ensureCredKey, decryptSecret }) => {
      ensureCredKey();
      assert.strictEqual(decryptSecret(enc), 'branch-password-123');
    });
  } finally { if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile); }
});

test('ensureCredKey: a write failure degrades gracefully (still returns a usable key, never throws)', () => {
  // point the key file at a path whose parent dir does not exist -> write throws internally
  const badPath = path.join(os.tmpdir(), 'no-such-dir-' + Math.random().toString(36).slice(2), 'x.key');
  withEnv({ CRED_ENC_KEY: '', CRED_ENC_KEY_FILE: badPath }, ({ ensureCredKey }) => {
    let k;
    assert.doesNotThrow(() => { k = ensureCredKey(); });
    assert.ok(k && k.length >= 32, 'still returns an in-memory key even if it could not be persisted');
  });
});
