'use strict';
// Business-account identity primitives (ADR-021, Phase 1). Flag-gated by
// capabilities.multiUser — none of this runs on the personal product.
//
// Deliberately NO new dependency: password hashing uses Node core `crypto.scrypt`
// (memory-hard KDF) and sessions are opaque random tokens whose sha-256 is stored
// (a leaked DB dump can't be replayed as a live session). The ONE thing every route
// funnels through is `scopeForUser` — the frozen isolation contract (see below);
// lib/supabase.js (Barat) enforces that scope on every query.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { cfg } = require('./config');
const { hreq } = require('./http');

const scrypt = promisify(crypto.scrypt);
const enc = encodeURIComponent;

// scrypt parameters. keylen 64 bytes; cost N=16384 (scrypt default) is a sensible
// interactive-login cost. Stored format is self-describing: `scrypt$<saltHex>$<hashHex>`
// so params can evolve without breaking existing hashes (verify reads the stored salt).
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 12 * 60 * 60 * 1000; // 12h

// ---- password hashing -------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(String(password), salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

// Constant-time verify. Returns false (never throws) on any malformed/absent stored
// hash so an unknown-user login path can call it with a dummy value without special-casing.
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch { return false; }
  if (salt.length === 0 || expected.length === 0) return false;
  let dk;
  try { dk = await scrypt(String(password), salt, expected.length); }
  catch { return false; }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// ---- sessions ---------------------------------------------------------------
// The sessions table has a non-standard primary key (token_hash), so these go
// straight through hreq rather than the generic id-keyed lib/supabase helpers.
// Every query is still account-scoped to cfg.ACCOUNT_ID (managed-silo: one account
// per instance).

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// mintSession(user) -> the RAW token (returned to the caller exactly ONCE; only its
// hash is persisted). `user` needs { id, role, branch_id? }.
async function mintSession(user, ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    token_hash: tokenHash(token),
    user_id: user.id,
    account_id: cfg.ACCOUNT_ID,
    role: user.role,
    branch_id: user.branch_id || null,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  await hreq({ method: 'POST', url: cfg.SB_REST + '/sessions',
    headers: { ...cfg.sbH, Prefer: 'return=minimal' }, body: row, json: true });
  return token;
}

// lookupSession(token) -> { user_id, account_id, role, branch_id } | null.
// Returns null for a missing/expired token (never throws for those cases).
async function lookupSession(token) {
  if (!token) return null;
  const url = cfg.SB_REST + '/sessions?token_hash=eq.' + enc(tokenHash(token))
    + '&account_id=eq.' + enc(cfg.ACCOUNT_ID) + '&limit=1';
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  const s = Array.isArray(rows) && rows[0];
  if (!s) return null;
  if (!s.expires_at || new Date(s.expires_at).getTime() <= Date.now()) return null; // expired
  return { user_id: s.user_id, account_id: s.account_id, role: s.role, branch_id: s.branch_id || null };
}

// revokeSessionsForUser(userId) — hard-deletes every session for a user (logout,
// or soft-revoking a clerk kills all their live sessions at once).
async function revokeSessionsForUser(userId) {
  const url = cfg.SB_REST + '/sessions?user_id=eq.' + enc(userId)
    + '&account_id=eq.' + enc(cfg.ACCOUNT_ID);
  await hreq({ method: 'DELETE', url, headers: { ...cfg.sbH, Prefer: 'return=minimal' }, json: true });
}

// ---- the frozen isolation contract -----------------------------------------
// scopeForUser(user) -> { account_id, branch_id?, role }.
//   role='admin' -> { account_id, role }             (NO branch filter → sees all branches)
//   role='clerk' -> { account_id, branch_id, role }  (HARD-filtered to that branch)
// lib/supabase.js helpers accept this scope and apply branch_id when present. This is
// the ONE choke-point: no route hand-rolls its own scope filter. `staff` never logs in,
// so producing a scope for a staff identity is a programming error (throw loudly).
function scopeForUser(user) {
  if (!user || !user.role) throw new Error('scopeForUser: a user with a role is required');
  const account_id = user.account_id || cfg.ACCOUNT_ID;
  if (user.role === 'admin') return { account_id, role: 'admin' };
  if (user.role === 'clerk') {
    if (!user.branch_id) throw new Error('scopeForUser: a clerk must have a branch_id');
    return { account_id, branch_id: user.branch_id, role: 'clerk' };
  }
  throw new Error('scopeForUser: unsupported role "' + user.role + '"');
}

module.exports = {
  hashPassword, verifyPassword,
  mintSession, lookupSession, revokeSessionsForUser, tokenHash,
  scopeForUser,
};
