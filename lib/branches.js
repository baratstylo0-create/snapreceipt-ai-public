'use strict';
// Branch + staff provisioning (ADR-021 Phase 2, ADR-023 company dimension). Flag-gated
// by capabilities.multiUser — unused on the personal product. The admin creates a branch;
// we auto-generate a clerk login (shown ONCE) + a one-time Telegram bot-binding token.
// Staff are a name-only directory (attribution; no login, no bot).
//
// Security (ADR-025): passwords are auto-generated strong + scrypt-hashed (only the hash is
// stored); the plaintext is returned to the caller exactly once. Soft-delete only (active=false)
// + session revoke — nothing is hard-deleted. Every write is account-scoped by lib/supabase.
const crypto = require('node:crypto');
const { sbInsert, sbInsertReturning, sbSelect, sbUpdate } = require('./supabase');
const { hashPassword, revokeSessionsForUser } = require('./auth');
const { encryptSecret, decryptSecret } = require('./credCrypto');

const BIND_TTL_MS = Number(process.env.BIND_TOKEN_TTL_MS) || 7 * 24 * 60 * 60 * 1000; // 7 days
// Human-friendly, unambiguous character classes (no 0/O/1/l/I) — creds are shown once and
// typed by a clerk. Split by class so genPassword can GUARANTEE the letters+digits policy.
const PW_LOWER = 'abcdefghijkmnpqrstuvwxyz';   // no l
const PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I, O
const PW_DIGIT = '23456789';                   // no 0, 1
const PW_ALL = PW_LOWER + PW_UPPER + PW_DIGIT;  // 56 chars
const PW_LEN = 14;

// ---- credential generation --------------------------------------------------

function randFrom(alphabet, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(alphabet[crypto.randomInt(alphabet.length)]);
  return out.join('');
}

// A strong auto-generated password: 14 chars from a 56-char unambiguous alphabet (~80 bits),
// GUARANTEED to contain a lowercase, an uppercase, and a digit so it always satisfies the
// SEC-1 policy (a purely-random pick would ~11% of the time omit a digit and fail).
function genPassword() {
  const chars = [
    PW_LOWER[crypto.randomInt(PW_LOWER.length)],
    PW_UPPER[crypto.randomInt(PW_UPPER.length)],
    PW_DIGIT[crypto.randomInt(PW_DIGIT.length)],
  ];
  while (chars.length < PW_LEN) chars.push(PW_ALL[crypto.randomInt(PW_ALL.length)]);
  // Fisher–Yates shuffle so the guaranteed chars aren't always in positions 0-2.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// SEC-1 password policy for an ADMIN-SET/reset password (auto-gen always passes). Returns
// { ok, error? }. Min 10, must mix letters + digits, not a single repeated char.
function passwordPolicy(pw) {
  const s = String(pw || '');
  if (s.length < 10) return { ok: false, error: 'password must be at least 10 characters' };
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: 'password must include letters and digits' };
  if (/^(.)\1+$/.test(s)) return { ok: false, error: 'password is too weak' };
  return { ok: true };
}

// username = office slug + short random suffix (collision-resistant, readable).
function genUsername(office) {
  const slug = String(office || 'branch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'branch';
  return slug + '-' + randFrom('abcdefghijkmnpqrstuvwxyz23456789', 4);
}

function genBindingToken() { return crypto.randomBytes(24).toString('base64url'); }

// ---- provisioning -----------------------------------------------------------

// createBranch({ office, state?, clerkName?, companyId?, role?, username?, password? }) -> creates
// the branch row + a clerk `users` row (scrypt-hashed password) + a one-time bot_bindings token.
// Returns { branch, user, credentials:{username,password}, bindToken } — `password` is the ONLY
// place the plaintext ever appears (show once, then it's gone). role defaults to 'clerk'.
// `username`/`password` are optional overrides: the bootstrap (setup/provision.js) reuses this with
// role:'admin' + an operator-chosen ADMIN_USERNAME (and optional ADMIN_PASSWORD) for the Head Office;
// omitted, both auto-generate as before. An explicit password must satisfy the SEC-1 policy.
async function createBranch({ office, state = null, clerkName = null, companyId = null, role = 'clerk', username = null, password = null } = {}) {
  if (!office || typeof office !== 'string') throw new Error('createBranch: office is required');
  if (role !== 'clerk' && role !== 'admin') throw new Error('createBranch: role must be clerk or admin');
  if (password != null) {
    const pol = passwordPolicy(password);
    if (!pol.ok) throw new Error('createBranch: ' + pol.error);
  }

  const branch = await sbInsertReturning('branches', {
    company_id: companyId,
    office: office.slice(0, 120),
    state: state ? String(state).slice(0, 80) : null,
    clerk_name: clerkName ? String(clerkName).slice(0, 120) : null,
    active: true,
  });
  if (!branch) throw new Error('createBranch: branch insert failed');

  const finalUsername = username != null && String(username).trim() ? String(username).trim().slice(0, 64) : genUsername(office);
  const finalPassword = password != null ? String(password) : genPassword();
  const password_hash = await hashPassword(finalPassword);
  // ADR-025 amendment: ALSO store an encrypted-recoverable copy (null if CRED_ENC_KEY
  // isn't configured — never falls back to plaintext) so an admin can view it again later.
  const password_enc = encryptSecret(finalPassword);
  const user = await sbInsertReturning('users', {
    company_id: companyId,
    branch_id: branch.id,
    role,
    username: finalUsername,
    password_hash,
    password_enc,
    display_name: clerkName || office,
    active: true,
  });
  if (!user) throw new Error('createBranch: user insert failed');

  const bindToken = genBindingToken();
  await sbInsert('bot_bindings', {
    user_id: user.id,
    company_id: companyId,
    branch_id: branch.id,
    role,
    bind_token: bindToken,
    token_expires_at: new Date(Date.now() + BIND_TTL_MS).toISOString(),
    active: true,
  });

  return {
    branch,
    user: { id: user.id, username: finalUsername, role, branch_id: branch.id, company_id: companyId },
    credentials: { username: finalUsername, password: finalPassword }, // plaintext ONCE — never stored, never logged
    bindToken,
  };
}

// The one credentialed (login-capable) user for a branch — admin or clerk, never a
// name-only staff row. A branch created by createBranch always has exactly one.
function findCredentialedUser(users) {
  return (users || []).find(u => u && (u.role === 'admin' || u.role === 'clerk'));
}

// getBranchCredentials(branchId) -> { username, password, bindToken } | null.
// ADR-025 amendment: the "view anytime" read for the Team UI's user-icon. `password` is
// null when no encrypted copy exists (a legacy branch predating this feature, or
// CRED_ENC_KEY isn't configured) — the caller shows "no password on file, use Reset"
// rather than treating that as an error. `bindToken` is the branch's latest active
// bot-binding token (re-shareable even after the one-time creation panel was dismissed).
async function getBranchCredentials(branchId) {
  if (!branchId) throw new Error('getBranchCredentials: branchId is required');
  const users = await sbSelect('users', { eq: { branch_id: branchId, active: true } });
  const user = findCredentialedUser(users);
  if (!user) return null;
  const bindings = await sbSelect('bot_bindings', {
    eq: { branch_id: branchId, active: true }, order: 'created_at.desc', limit: 1,
  });
  return {
    username: user.username || null,
    password: user.password_enc ? decryptSecret(user.password_enc) : null,
    bindToken: (bindings[0] && bindings[0].bind_token) || null,
  };
}

// resetBranchPassword(branchId) -> { username, password } (plaintext ONCE, same contract
// as createBranch). Generates a fresh password, updates both the login hash and the
// recoverable encrypted copy, and revokes the clerk's existing sessions (a stale
// browser session must not survive a password reset).
async function resetBranchPassword(branchId) {
  if (!branchId) throw new Error('resetBranchPassword: branchId is required');
  const users = await sbSelect('users', { eq: { branch_id: branchId, active: true } });
  const user = findCredentialedUser(users);
  if (!user) throw new Error('resetBranchPassword: no credentialed user for this branch');
  const finalPassword = genPassword();
  const password_hash = await hashPassword(finalPassword);
  const password_enc = encryptSecret(finalPassword);
  await sbUpdate('users', { id: user.id }, { password_hash, password_enc });
  await revokeSessionsForUser(user.id);
  return { username: user.username, password: finalPassword };
}

// listBranches({ companyId? }) -> active branches (optionally filtered to a company).
async function listBranches({ companyId = null } = {}) {
  const eq = { active: true };
  if (companyId) eq.company_id = companyId;
  return sbSelect('branches', { eq, order: 'created_at.asc' });
}

// softDeleteBranch(id) -> active=false on the branch + its users, revoke those users' sessions,
// and deactivate the branch's bot bindings. Nothing hard-deleted (recoverable). Idempotent.
async function softDeleteBranch(id) {
  if (!id) throw new Error('softDeleteBranch: id is required');
  await sbUpdate('branches', { id }, { active: false });
  const users = await sbSelect('users', { eq: { branch_id: id } });
  for (const u of users) {
    await sbUpdate('users', { id: u.id }, { active: false });
    await revokeSessionsForUser(u.id);
  }
  const bindings = await sbSelect('bot_bindings', { eq: { branch_id: id } });
  for (const b of bindings) await sbUpdate('bot_bindings', { id: b.id }, { active: false });
  return { ok: true, branch_id: id, users_revoked: users.length };
}

// ---- staff directory (name-only; no login, no bot) --------------------------

async function addStaff({ branchId, name, companyId = null }) {
  if (!branchId) throw new Error('addStaff: branchId is required');
  if (!name || typeof name !== 'string') throw new Error('addStaff: name is required');
  return sbInsertReturning('users', {
    company_id: companyId, branch_id: branchId, role: 'staff',
    display_name: name.slice(0, 120), active: true,
  });
}

async function listStaff(branchId) {
  if (!branchId) throw new Error('listStaff: branchId is required');
  return sbSelect('users', { eq: { branch_id: branchId, role: 'staff', active: true }, order: 'display_name.asc' });
}

async function removeStaff(id) {
  if (!id) throw new Error('removeStaff: id is required');
  await sbUpdate('users', { id }, { active: false });
  return { ok: true };
}

module.exports = {
  genPassword, passwordPolicy, genUsername, genBindingToken,
  createBranch, listBranches, softDeleteBranch,
  getBranchCredentials, resetBranchPassword,
  addStaff, listStaff, removeStaff,
};
