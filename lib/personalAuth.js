'use strict';
// Personal-mode signup (2026-07-25). Flag-gated by capabilities.personalAuth — the ONLY
// web-exposed user-creation path in the app (business's equivalent, setup/provision.js, is
// deliberately CLI-only since a personal user has no operator to run it for them).
//
// Creates a bare `users` row (role:'owner', no branch_id/company_id — a personal account is
// single-tenant already) + a `bot_bindings` row with chat_id null (unbound until the user
// taps the returned deep link). Deliberately NOT lib/branches.js's createBranch() — that
// function forces a `branches` row onto every new user, which has no meaning for a personal
// account and would pollute business route surfaces if ever turned on for that account later.
const crypto = require('node:crypto');
const { sbSelect, sbInsertReturning, sbInsert } = require('./supabase');
const { hashPassword } = require('./auth');
const { passwordPolicy } = require('./branches'); // reuse the app's one SEC-1 password standard

const BIND_TTL_MS = Number(process.env.BIND_TOKEN_TTL_MS) || 7 * 24 * 60 * 60 * 1000; // 7 days

// Deliberately loose — real email validation is "does mail deliver," which nothing
// synchronous can check. Just rejects obviously-not-an-email input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function genBindingToken() { return crypto.randomBytes(24).toString('base64url'); }

// signupOwner({ email, password }) -> { user:{id,username,role}, bindToken }
// Throws Error with a user-safe .message on any validation/conflict failure — the route
// maps that straight to a 400.
async function signupOwner({ email, password } = {}) {
  const username = normaliseEmail(email);
  if (!username || !EMAIL_RE.test(username)) throw new Error('a valid email address is required');
  const pol = passwordPolicy(password);
  if (!pol.ok) throw new Error(pol.error);

  const existing = await sbSelect('users', { eq: { username }, limit: 1 });
  if (existing.length) throw new Error('an account with that email already exists');

  const password_hash = await hashPassword(password);
  const user = await sbInsertReturning('users', {
    branch_id: null,
    company_id: null,
    role: 'owner',
    username,
    password_hash,
    display_name: username,
    active: true,
  });
  if (!user) throw new Error('signup failed');

  const bindToken = genBindingToken();
  await sbInsert('bot_bindings', {
    user_id: user.id,
    branch_id: null,
    company_id: null,
    role: 'owner',
    bind_token: bindToken,
    token_expires_at: new Date(Date.now() + BIND_TTL_MS).toISOString(),
    active: true,
  });

  return { user: { id: user.id, username, role: 'owner' }, bindToken };
}

module.exports = { signupOwner, normaliseEmail, genBindingToken, BIND_TTL_MS };
