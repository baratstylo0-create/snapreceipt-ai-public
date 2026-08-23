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
const { sbSelect, sbSelectGlobal, sbInsertReturning, sbInsert, sbUpdate } = require('./supabase');
const { hashPassword } = require('./auth');
const { passwordPolicy } = require('./branches'); // reuse the app's one SEC-1 password standard

// 2026-08-08: the connect link used to expire after 7 days (BIND_TOKEN_TTL_MS) with no way
// to get a fresh one short of a developer querying the DB by hand — a real user got
// permanently stuck this way. Binding is now permanent once made; token_expires_at is no
// longer set on new signups (see signupOwner below). BIND_TTL_MS is kept only so any already-
// deployed row that still has an expiry set doesn't need a schema change to stop enforcing it
// (lib/bot.js's bindWithToken no longer checks token_expires_at either).
const BIND_TTL_MS = Number(process.env.BIND_TOKEN_TTL_MS) || 7 * 24 * 60 * 60 * 1000; // legacy, unused for new rows

// Deliberately loose — real email validation is "does mail deliver," which nothing
// synchronous can check. Just rejects obviously-not-an-email input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function genBindingToken() { return crypto.randomBytes(24).toString('base64url'); }

// 2026-08-14 SECURITY FIX: every signup used to leave `account_id` unset, so it fell back to
// the `users` table's own DB column default ('default') — the SAME literal value for every
// single personal account. Since lib/auth.js's scopeForUser gives an 'owner' role no filter
// beyond account_id, every personal user ended up reading/editing/deleting every OTHER
// personal user's receipts. genAccountId() gives each new owner a genuinely unique id, which
// lib/supabase.js's existing account_id-scoping (already used everywhere, every table) then
// isolates for free — no other query-layer change needed, only correctly POPULATING the
// column at the two places a new owner account is created (here, and routes/googleAuth.js's
// mirror-image new-account branch).
function genAccountId() { return 'p_' + crypto.randomUUID(); }

// signupOwner({ email, password }) -> { user:{id,username,role}, bindToken }
// Throws Error with a user-safe .message on any validation/conflict failure — the route
// maps that straight to a 400.
async function signupOwner({ email, password } = {}) {
  const username = normaliseEmail(email);
  if (!username || !EMAIL_RE.test(username)) throw new Error('a valid email address is required');
  const pol = passwordPolicy(password);
  if (!pol.ok) throw new Error(pol.error);

  // sbSelectGlobal (2026-08-22): a duplicate-email check must be tenant-independent — see its
  // doc comment in lib/supabase.js. A scoped sbSelect here would go blind to any already-
  // migrated owner (unique account_id != cfg.ACCOUNT_ID) and silently create a duplicate.
  const existing = await sbSelectGlobal('users', { eq: { username }, limit: 1 });
  if (existing.length) throw new Error('an account with that email already exists');

  const password_hash = await hashPassword(password);
  const account_id = genAccountId(); // 2026-08-14 fix — see genAccountId's doc comment
  const user = await sbInsertReturning('users', {
    account_id,
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
    account_id, // must match the user row — lib/bot.js's bindingMeta() reads it from here
    user_id: user.id,
    branch_id: null,
    company_id: null,
    role: 'owner',
    bind_token: bindToken,
    token_expires_at: null, // permanent — see the 2026-08-08 note above BIND_TTL_MS
    active: true,
  });

  return { user: { id: user.id, username, role: 'owner' }, bindToken };
}

// signupOwnerDirect({ email, password, chatId }) -> { user, bindToken }
// Same as signupOwner, but called from INSIDE a Telegram conversation where we already have
// the chat's id — so there's no reason to make the user tap a separate link. Binds the fresh
// bot_bindings row to this chat immediately, in one extra update after signupOwner creates it.
async function signupOwnerDirect({ email, password, chatId } = {}) {
  const result = await signupOwner({ email, password });
  const now = new Date().toISOString();
  const rows = await sbSelect('bot_bindings', { eq: { user_id: result.user.id }, limit: 1 });
  if (rows[0]) {
    await sbUpdate('bot_bindings', { id: rows[0].id }, { chat_id: String(chatId), bound_at: now, last_active_at: now });
  }
  return result;
}

// reconnectBinding(userId, chatId) -> boolean (true if a binding row was found and rebound)
// Used both for "I already have one" (dashboard link lost/expired) and for the 30-day
// inactivity re-verify flow — in both cases the user has already proven ownership of the
// account (email verification code), so we just re-point the existing binding row's chat_id.
async function reconnectBinding(userId, chatId) {
  const rows = await sbSelect('bot_bindings', { eq: { user_id: userId }, limit: 1 });
  if (!rows[0]) return false;
  const now = new Date().toISOString();
  await sbUpdate('bot_bindings', { id: rows[0].id }, { chat_id: String(chatId), bound_at: now, last_active_at: now, active: true });
  return true;
}

module.exports = { signupOwner, signupOwnerDirect, reconnectBinding, normaliseEmail, genBindingToken, genAccountId, BIND_TTL_MS };
