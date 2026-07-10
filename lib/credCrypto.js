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
const { cfg } = require('./config');

function key() {
  if (!cfg.CRED_ENC_KEY) return null;
  return crypto.createHash('sha256').update(String(cfg.CRED_ENC_KEY)).digest();
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

module.exports = { encryptSecret, decryptSecret };
