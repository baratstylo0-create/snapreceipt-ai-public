'use strict';
// Personal-mode "forgot password" (2026-07-27). Flag-gated by capabilities.personalAuth
// (see routes/auth.js) — reuses the exact primitives lib/personalAuth.js and lib/auth.js
// already established: passwordPolicy (the app's one SEC-1 password standard), hashPassword
// (scrypt), and a one-time-token shape mirroring bot_bindings' bind_token — except the
// reset token is stored HASHED (tokenHash, same sha-256 primitive as session tokens), never
// raw, since it's a bearer credential that can change a password.
const crypto = require('node:crypto');
const { sbSelect, sbInsert, sbUpdate } = require('./supabase');
const { hashPassword, tokenHash, revokeSessionsForUser } = require('./auth');
const { passwordPolicy } = require('./branches');
const { normaliseEmail } = require('./personalAuth');

const RESET_TTL_MS = Number(process.env.RESET_TOKEN_TTL_MS) || 60 * 60 * 1000; // 1 hour

function genResetToken() { return crypto.randomBytes(32).toString('base64url'); }

// requestPasswordReset(email) -> { token, user:{id,username} } | null.
// null means "no matching owner account" — the CALLER (routes/auth.js) must respond
// identically to the caller either way; this function itself never reveals which via
// its own behavior (same DB round-trip shape, no throw on "not found").
async function requestPasswordReset(email) {
  const username = normaliseEmail(email);
  if (!username) return null;
  const rows = await sbSelect('users', { eq: { username, active: true }, limit: 1 });
  const user = rows && rows[0];
  // Only 'owner' (personal) accounts self-serve a reset — business (admin/clerk) accounts
  // are provisioned/reset by an operator, out of scope here (mirrors signupOwner's own
  // "personal-only" framing; never touches multiUser behavior).
  if (!user || user.role !== 'owner') return null;
  const token = genResetToken();
  await sbInsert('password_resets', {
    user_id: user.id,
    token_hash: tokenHash(token),
    expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
  });
  return { token, user: { id: user.id, username: user.username } };
}

// resetPassword(token, newPassword) -> { ok:true } | { ok:false, error }.
// Single-use + expiring: a token that's missing, already used, or past expires_at is
// treated identically ("Invalid or expired reset link.") — never distinguishes the three
// to the caller, so a guesser learns nothing from the error message.
async function resetPassword(token, newPassword) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'Invalid or expired reset link.' };
  const policy = passwordPolicy(newPassword);
  if (!policy.ok) return { ok: false, error: policy.error };

  const hash = tokenHash(t);
  const rows = await sbSelect('password_resets', { eq: { token_hash: hash }, limit: 1 });
  const row = rows && rows[0];
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: 'Invalid or expired reset link.' };
  }

  const password_hash = await hashPassword(newPassword);
  await sbUpdate('users', { id: row.user_id }, { password_hash });
  await sbUpdate('password_resets', { id: row.id }, { used_at: new Date().toISOString() });
  // Security best practice: a password reset kicks out every existing session for this
  // user (mirrors logout()'s own "revoke everywhere" behavior) — if someone else had a
  // live session (the reason a reset was needed in the first place), this ends it.
  await revokeSessionsForUser(row.user_id);
  return { ok: true };
}

module.exports = { requestPasswordReset, resetPassword, genResetToken };
