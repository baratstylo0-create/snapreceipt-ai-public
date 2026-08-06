'use strict';
// Encrypted-at-rest, RECOVERABLE secret storage (ADR-025 amendment, Owner-approved
// 2026-07-11 QA round: admins need to view a branch's password again, not just once —
// the original ADR-025 hash-only design made that structurally impossible). AES-256-GCM
// keyed by CRED_ENC_KEY (any operator-chosen secret string, normalised to 32 bytes via
// sha256 so any length works). Deliberately SEPARATE from password_hash (scrypt,
// one-way) — password_hash remains the ONLY thing login checks; this module exists
// purely so the plaintext can be shown to an admin again later.
//
// Fail-safe by design: if CRED_ENC_KEY isn't configured, encryptSecret returns null
// (nothing stored — same as a legacy/pre-this-feature branch) rather than ever storing
// plaintext as a fallback. decryptSecret returns null on ANY failure (missing key,
// wrong key, tampered/corrupt ciphertext) — never throws into a caller.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cfg } = require('./config');

function key() {
  if (!cfg.CRED_ENC_KEY) return null;
  return crypto.createHash('sha256').update(String(cfg.CRED_ENC_KEY)).digest();
}

// The persisted auto-key file. Overridable via CRED_ENC_KEY_FILE (used by tests + operators
// who want a specific location); defaults to a gitignored file in the app root that survives
// redeploys (git archive never includes it; the deploy's tar-extract never deletes untracked
// files). Read live so tests can point it at a temp path per run.
function keyFilePath() {
  return process.env.CRED_ENC_KEY_FILE || path.join(__dirname, '..', '.cred_key');
}

// ensureCredKey() -> the active key string. Auto-provisions a persistent key so the
// recoverable-password feature works on the server with zero manual config (Owner-approved
// 2026-07-11). Precedence: an explicit CRED_ENC_KEY env var ALWAYS wins (operator override);
// otherwise reuse the persisted key file, or generate one and persist it (mode 0600) on first
// boot. Stamps cfg.CRED_ENC_KEY so key()/encrypt/decrypt pick it up. Idempotent, synchronous.
// Fail-safe: if the file can't be written, still returns an in-memory key (that boot's data
// stays encryptable) rather than throwing — a persistence failure must never crash startup.
// Called once at server boot (server.js); unit tests that require credCrypto directly and set
// CRED_ENC_KEY explicitly never hit the generate path.
function ensureCredKey() {
  if (cfg.CRED_ENC_KEY) return cfg.CRED_ENC_KEY;
  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing) { cfg.CRED_ENC_KEY = existing; return existing; }
    }
  } catch (e) { console.error('[credCrypto] read key file:', e && e.message); }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('[credCrypto] could not persist key file (using in-memory key this boot):', e && e.message);
  }
  cfg.CRED_ENC_KEY = generated;
  return generated;
}

// encryptSecret(plaintext) -> "<ivHex>:<tagHex>:<encHex>" | null.
function encryptSecret(plaintext) {
  const k = key();
  if (!k || plaintext == null) return null;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
  } catch (e) {
    console.error('[credCrypto] encrypt', e && e.message);
    return null;
  }
}

// decryptSecret(ciphertext) -> plaintext string | null.
function decryptSecret(ciphertext) {
  const k = key();
  if (!k || !ciphertext || typeof ciphertext !== 'string') return null;
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivHex, tagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null; // tampered / wrong key / corrupt ciphertext — never throw, just unavailable
  }
}

module.exports = { encryptSecret, decryptSecret, ensureCredKey };
