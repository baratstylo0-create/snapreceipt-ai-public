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
// hash is persisted). `user` needs { id, role, branch_id?, company_id? }.
// 2026-08-14 SECURITY FIX: this used to hardcode `account_id: cfg.ACCOUNT_ID` — the ONE
// server-wide constant — on every session, regardless of the actual user's own account_id.
// That silently discarded per-user tenancy: every personal ("owner") signup shares this one
// deployment's DB, and each got a genuinely unique `users.account_id` (personalAuth.js /
// routes/googleAuth.js, same date) specifically so lib/supabase.js's existing scope
// machinery could isolate them — but the session (the thing every request actually reads
// scope from, via checkDashSession -> lookupSession -> scopeForUser) never carried it,
// so every owner's scope resolved to the same shared cfg.ACCOUNT_ID anyway and two real
// accounts could read/edit/delete each other's receipts.
//
// CAUGHT LIVE (2026-08-14, before deploy — verified against the real production .env, not
// just a local one): `schema.sql`'s `users.account_id` DB column default is the LITERAL
// string 'default' — a static schema default, it can NEVER be aware of a deployment's own
// `ACCOUNT_ID` env var. This deployment sets `ACCOUNT_ID=snapreceiptai` (not 'default'), so
// every EXISTING user row (created before this fix) has `account_id: 'default'` on the
// `users` table while every one of their actual expense/data rows carries
// `account_id: 'snapreceiptai'` (the old hardcoded fallback, used everywhere else). A plain
// `user.account_id || cfg.ACCOUNT_ID` would treat that literal 'default' as a REAL value
// (it's a non-empty string, so `||` never falls through) and mint a session for
// 'default' — which matches NOTHING in that user's existing data. Their own dashboard would
// go blank on first login after deploy. `accountIdFor()` below treats the literal 'default'
// as "never actually assigned" and falls back to cfg.ACCOUNT_ID in that case, so an existing
// (pre-fix) user's session keeps resolving to exactly what their existing rows already use.
// A NEW signup's account_id is always a `p_<uuid>` (lib/personalAuth.js genAccountId) —
// never literally 'default' — so it always takes the real-isolation branch, never this one.
function accountIdFor(user) {
  return (user && user.account_id && user.account_id !== 'default') ? user.account_id : cfg.ACCOUNT_ID;
}

async function mintSession(user, ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    token_hash: tokenHash(token),
    user_id: user.id,
    account_id: accountIdFor(user),
    role: user.role,
    branch_id: user.branch_id || null,
    company_id: user.company_id || null,  // ADR-023: denormalised like branch_id (one-lookup scope)
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  await hreq({ method: 'POST', url: cfg.SB_REST + '/sessions',
    headers: { ...cfg.sbH, Prefer: 'return=minimal' }, body: row, json: true });
  return token;
}

// lookupSession(token) -> { user_id, account_id, role, branch_id, company_id? } | null.
// company_id is included only when the session row carries one (multi-company clients); it is
// OMITTED otherwise so pre-Phase-8/single-company sessions keep the exact prior shape.
// Returns null for a missing/expired token (never throws for those cases).
//
// 2026-08-14 SECURITY FIX: dropped the `account_id=eq.cfg.ACCOUNT_ID` predicate — it forced
// every lookup to only ever match sessions stamped with the one server-wide constant, which
// is exactly the bug mintSession's comment above describes (a session correctly minted with
// its OWNER's own account_id would then fail to be found at all). `token_hash` is the
// table's primary key (sha-256 of a crypto-random 32-byte token) and is therefore already
// globally unique on its own — no account_id predicate was ever needed for correctness, only
// for (redundant) defense-in-depth that had the side effect of breaking per-user account_id.
async function lookupSession(token) {
  if (!token) return null;
  const url = cfg.SB_REST + '/sessions?token_hash=eq.' + enc(tokenHash(token)) + '&limit=1';
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  // A Supabase error (network blip, 5xx, rate limit) comes back as a non-array value.
  // Returning null here would be indistinguishable from "token not found" → triggers a
  // real 401 → frontend clears the session → random logout for a user whose token is valid.
  // Throwing instead lets checkDashSession's existing catch return a 502 (retryable) not 401.
  if (!Array.isArray(rows)) throw new Error('lookupSession: unexpected response from Supabase: ' + String(rows).slice(0, 100));
  const s = rows[0];
  if (!s) return null;
  if (!s.expires_at || new Date(s.expires_at).getTime() <= Date.now()) return null; // expired
  const out = { user_id: s.user_id, account_id: s.account_id, role: s.role, branch_id: s.branch_id || null };
  if (s.company_id) out.company_id = s.company_id;
  return out;
}

// revokeSessionsForUser(userId) — hard-deletes every session for a user (logout,
// or soft-revoking a clerk kills all their live sessions at once).
// 2026-08-14 SECURITY FIX: dropped the same `account_id=eq.cfg.ACCOUNT_ID` predicate as
// lookupSession, for the same reason — `user_id` is already a foreign key to a single,
// globally-unique `users.id`, so filtering by it alone is sufficient and correct; the old
// predicate would silently fail to revoke a session whose account_id wasn't the one global
// constant (i.e. exactly the sessions this fix now mints for per-user personal accounts).
async function revokeSessionsForUser(userId) {
  const url = cfg.SB_REST + '/sessions?user_id=eq.' + enc(userId);
  await hreq({ method: 'DELETE', url, headers: { ...cfg.sbH, Prefer: 'return=minimal' }, json: true });
}

// ---- the frozen isolation contract -----------------------------------------
// scopeForUser(user) -> { account_id, company_id?, branch_id?, role }.
//   role='admin' -> { account_id, role }                          (NO filter → sees all companies + branches)
//   role='clerk' -> { account_id, company_id?, branch_id, role }  (HARD-filtered to that branch)
// lib/supabase.js helpers accept this scope and apply branch_id when present. This is
// the ONE choke-point: no route hand-rolls its own scope filter. `staff` never logs in,
// so producing a scope for a staff identity is a programming error (throw loudly).
// ADR-023 Phase 8: a clerk's scope OPTIONALLY carries company_id when the session denormalises one
// (multi-company clients). It is OMITTED (not null-keyed) when absent so pre-Phase-8 clerks and the
// single-company product keep the exact frozen shape. Admin is unchanged (cross-company by design).
function scopeForUser(user) {
  if (!user || !user.role) throw new Error('scopeForUser: a user with a role is required');
  const account_id = user.account_id || cfg.ACCOUNT_ID;
  if (user.role === 'admin') return { account_id, role: 'admin' };
  // 'owner' (2026-07-25, personal-mode signup): same "no filter" shape as admin — a
  // personal account has exactly one user and no branches/companies to scope by. Kept as
  // its own branch (not merged into the admin check) so it stays a distinct, auditable role
  // rather than silently becoming an admin — see lib/account.js personalAuth + schema.sql's
  // users_role_check migration for why 'owner' exists as its own value.
  if (user.role === 'owner') return { account_id, role: 'owner' };
  // 'guest' (2026-07-28, Guest Mode): the ONE role whose scope carries a user_id — that's
  // the isolation key expense-listing routes filter on via guestVisibilityExtra below, since
  // (unlike every other role here) a guest must NOT see the account's real data, and the real
  // account must NOT see guest rows. Everything else about a guest's scope (account_id) is
  // identical to owner/admin — same shared account_id, no separate tenant.
  // NOTE: the real (and only) caller passes lookupSession()'s return shape, which carries
  // `user_id` (not `id`) — confirmed via live testing 2026-07-28 (a guest's first manual
  // expense insert silently had owner_user_id:null because this originally read `user.id`,
  // which is undefined on that shape; JSON.stringify drops an undefined-valued key entirely,
  // so the column just kept its default instead of erroring — worth remembering next time a
  // scope needs a field lookupSession doesn't already carry under that exact name).
  if (user.role === 'guest') return { account_id, role: 'guest', user_id: user.user_id || user.id };
  if (user.role === 'clerk') {
    if (!user.branch_id) throw new Error('scopeForUser: a clerk must have a branch_id');
    const scope = { account_id, branch_id: user.branch_id, role: 'clerk' };
    if (user.company_id) scope.company_id = user.company_id;
    return scope;
  }
  throw new Error('scopeForUser: unsupported role "' + user.role + '"');
}

// ---- Guest Mode read-isolation (2026-07-28) ---------------------------------
// This codebase has no per-user data isolation otherwise (see the schema.sql Guest Mode
// migration comment) — every expenses query is scoped only by account_id. These two small
// helpers are the ONLY isolation Guest Mode needs on the read side, layered on top of the
// existing scope contract without touching lib/supabase.js's query builder (its `extra`
// param already accepts an arbitrary raw PostgREST filter fragment).
//
// guestVisibilityExtra(scope) -> a PostgREST filter fragment for the `extra` param, or null:
//   - a guest's own scope -> only THEIR tagged rows.
//   - any other real scope (owner/admin/clerk) -> NEVER see guest-tagged rows.
//   - no scope at all (plain legacy DASHBOARD_TOKEN mode, no session) -> null (no-op) — that
//     mode never has req.scope set at all, so this keeps it byte-for-byte unchanged rather
//     than adding a filter no existing deployment's queries ever had.
function guestVisibilityExtra(scope) {
  if (!scope) return null;
  if (scope.role === 'guest') return 'owner_user_id=eq.' + enc(scope.user_id);
  return 'owner_user_id=is.null';
}

// mergeExtra(...parts) -> joins non-empty PostgREST `extra` fragments with '&'. Route call
// sites already have their own `extra` string (or none); this appends guestVisibilityExtra
// without each site hand-rolling the join.
function mergeExtra() {
  return Array.prototype.filter.call(arguments, Boolean).join('&');
}

module.exports = {
  hashPassword, verifyPassword,
  mintSession, lookupSession, revokeSessionsForUser, tokenHash, accountIdFor,
  scopeForUser, guestVisibilityExtra, mergeExtra,
};
