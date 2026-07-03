'use strict';
// lib/groqkeys.js — Groq multi-key pool (ADR-016). Pure, dependency-free, no network.
// OWNER: Jeevan. Consumed by lib/groq.js's call-site loop (Barat) to fall through to a
// fresh account's quota on a 429, at $0, same model / same output quality.
//
// Config (server-side secrets only — never logged, never sent to the browser):
//   GROQ_KEYS = "k1,k2,k3,k4"   comma-separated pool (trimmed, empties dropped).
//   GROQ_KEY  = "k1"            single-key fallback, used ONLY when GROQ_KEYS is unset/empty.
//
// SUPERSEDE (not union) is deliberate (Barat's call-site question #3): when GROQ_KEYS is set,
// GROQ_KEY is ignored. Rationale — the failure mode is benign: a stale GROQ_KEY left set
// alongside GROQ_KEYS simply goes UNUSED (less quota, no error), whereas unioning it would
// keep a possibly-revoked key in rotation and cause intermittent hard failures (a dead key
// throws non-429, which per ADR-016 does NOT rotate). Documented loudly in .env.example.
//
// Env is read FRESH on each call (not cached at load): trivial cost (one split), keeps the
// module pure/stateless and testable, and means no per-request state lives here — the caller
// owns the `tried` Set for one call's fall-through (ADR-016).

function keyPool() {
  const multi = String(process.env.GROQ_KEYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = String(process.env.GROQ_KEY || '').trim();
  return single ? [single] : [];
}

// A RANDOM key from the pool, or null if the pool is empty.
function pickKey() {
  const pool = keyPool();
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// A RANDOM key NOT already in `tried`, or null when every pooled key has been tried.
// `tried` may be a Set (normal), or null/undefined (treated as "none tried") for safety.
function nextKey(tried) {
  const used = tried instanceof Set ? tried : new Set();
  const candidates = keyPool().filter(k => !used.has(k));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { keyPool, pickKey, nextKey };
