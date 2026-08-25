'use strict';
// Verified-email challenge service (P-01, 2026-08-24 — docs/FULL_APP_EXECUTION_PLAN.md
// Gate 1, issue #34). The durable half of "prove you own this address."
//
// WHY THIS EXISTS: before it, the app's only proof-of-ownership was lib/bot.js's in-bot
// signup code — held in a per-process in-memory Map, in plaintext, lost on restart, and
// reachable only from Telegram. Web signup (POST /api/signup) minted a session with no
// email check whatsoever. Both web (W-01) and Android (M-02) now verify against THIS.
//
// It reuses the primitives this codebase already standardised on rather than inventing
// any: `tokenHash` (the same sha-256 used for sessions.token_hash and password_resets),
// `normaliseEmail` from lib/personalAuth.js, and the lib/supabase.js helpers. No new
// dependency, no new crypto.
//
// SECURITY CONTRACT (the parts a reviewer should check first):
//   * Neither the 6-digit code nor the magic-link token is EVER stored raw — only their
//     sha-256. A leaked DB dump yields no usable challenge.
//   * A challenge is single-use, and "used" is claimed with a CONDITIONAL update
//     (`consumed_at=is.null` folded into the WHERE) — one atomic Postgres UPDATE. Zero
//     rows back means somebody else already consumed it, which is the replay defense.
//     This is deliberately NOT the read-then-write pattern lib/passwordReset.js uses;
//     that non-atomicity is a recorded medium finding in the 2026-08-24 gap audit.
//   * The per-challenge guess budget (attempts/max_attempts) is bumped by the same
//     compare-and-swap trick BEFORE the code is compared, so a lost race costs an attempt
//     rather than granting a free guess. It layers UNDER the per-IP rate limiter: a
//     limiter alone resets every window and would let a patient attacker keep guessing
//     one long-lived code forever.
//   * Every confirm failure — unknown email, no challenge, expired, consumed, wrong code,
//     budget exhausted — returns the SAME message. A guesser learns nothing from it.
//   * The code is compared in constant time (timingSafeEqual over the hashes).
//   * `email` is snapshotted on the row, so a challenge issued before an email change
//     cannot be used to verify the new address.
const crypto = require('node:crypto');
const { sbSelect, sbSelectGlobal, sbInsertReturning, sbUpdate } = require('./supabase');
const { tokenHash } = require('./auth');
const { normaliseEmail } = require('./personalAuth');

// Short-lived by design. 15 minutes is long enough to switch to a mail app and back,
// short enough that a code sitting in an unattended inbox stops working quickly.
const VERIFY_TTL_MS = Number(process.env.EMAIL_VERIFY_TTL_MS) || 15 * 60 * 1000;
// Resend cooldown — the per-challenge half of anti-mailbomb (the per-IP limiter in
// routes/auth.js is the other half; this one binds to the ACCOUNT, so rotating IPs
// still cannot flood one person's inbox).
const RESEND_COOLDOWN_MS = Number(process.env.EMAIL_VERIFY_RESEND_COOLDOWN_MS) || 60 * 1000;
const MAX_ATTEMPTS = Number(process.env.EMAIL_VERIFY_MAX_ATTEMPTS) || 5;
const PURPOSE = 'verify_email';

// ONE message for every confirm failure — see the enumeration note in the header.
const GENERIC_FAIL = 'That code is invalid or has expired. Request a new one.';

// 6 digits, zero-padded. randomInt is the CSPRNG (Math.random would be a real finding).
// Padding matters: String(randomInt(0, 1000000)) would emit variable-length codes and
// leak a little entropy to anyone counting characters.
function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// 32 random bytes — the magic-link half. Same size/encoding as mintSession's token.
function genToken() { return crypto.randomBytes(32).toString('base64url'); }

// Constant-time compare of two hex digests. Length-checks first because timingSafeEqual
// THROWS on a length mismatch (it does not return false), which would turn a malformed
// input into a 502 instead of a clean rejection.
function hashesEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// findOwner(email) -> the active personal-account user row, or null.
// Scoped to role 'owner' on purpose: business (admin/clerk) identities are provisioned by
// an operator through setup/provision.js and have no self-serve email flow — exactly the
// same boundary lib/passwordReset.js draws. This keeps every existing business deployment
// out of the new code path entirely.
// 2026-08-25: was a scoped sbSelect with no `eq.account_id`/scope, which defaults to
// account_id=cfg.ACCOUNT_ID (the old shared bucket) -- so this ALWAYS came up empty for
// any migrated personal account (their real row lives under their own unique account_id).
// findOwner runs BEFORE any account_id is known (that's the whole point -- it's how one
// gets discovered from just an email), so sbSelectGlobal is the correct tool here, same
// as every other pre-session identity lookup fixed this session (routes/auth.js's own
// login handler, lib/personalAuth.js, routes/googleAuth.js -- see lib/supabase.js's doc
// comment on sbSelectGlobal).
async function findOwner(email) {
  const username = normaliseEmail(email);
  if (!username) return null;
  const rows = await sbSelectGlobal('users', { eq: { username, active: true }, limit: 1 });
  const user = rows && rows[0];
  if (!user || user.role !== 'owner') return null;
  return user;
}

// latestChallenge(userId, accountId) -> the newest challenge row for this user/purpose, or
// null. accountId scopes the read to match issueChallenge's write below (a migrated
// personal account's challenges live under their own account_id, not the shared default).
async function latestChallenge(userId, accountId) {
  const rows = await sbSelect('email_challenges', {
    eq: { user_id: userId, purpose: PURPOSE },
    order: 'created_at.desc',
    limit: 1,
    scope: { account_id: accountId },
  });
  return (rows && rows[0]) || null;
}

// issueChallenge(user) -> { code, token, challengeId } — the RAW code and token, returned
// to the caller exactly ONCE (only their hashes are persisted). The caller mails them and
// then must drop them; nothing can recover them afterwards.
//
// 2026-08-25: scope was missing on the insert, so every challenge silently landed under
// the DB column's own default ('default') instead of the issuing user's real account_id
// -- harmless in isolation (every OTHER call in this file was equally unscoped, so reads
// and writes agreed on the same wrong bucket), but it meant every migrated account's
// challenges were indistinguishable from each other in the table. Now stamped properly;
// latestChallenge/claim/spendAttempt below scope their own reads/writes to match.
async function issueChallenge(user, now = Date.now()) {
  const code = genCode();
  const token = genToken();
  const row = await sbInsertReturning('email_challenges', {
    user_id: user.id,
    purpose: PURPOSE,
    email: user.username,
    code_hash: tokenHash(code),
    token_hash: tokenHash(token),
    expires_at: new Date(now + VERIFY_TTL_MS).toISOString(),
    attempts: 0,
    max_attempts: MAX_ATTEMPTS,
  }, { account_id: user.account_id });
  if (!row) throw new Error('could not issue verification challenge');
  return { code, token, challengeId: row.id };
}

// requestVerification(email) -> { code, token, user } | null.
// null covers ALL of: not an email, no such account, not a personal account, already
// verified, and still inside the resend cooldown. The caller (routes/auth.js) MUST answer
// identically in every case — this function never reveals which one via its own behaviour
// (no throw, same shape). Returning null for an already-verified address also stops this
// being used to mailbomb somebody who has finished verifying.
async function requestVerification(email, now = Date.now()) {
  const user = await findOwner(email);
  if (!user) return null;
  if (user.email_verified_at) return null;
  const last = await latestChallenge(user.id, user.account_id);
  if (last && last.created_at && (now - new Date(last.created_at).getTime()) < RESEND_COOLDOWN_MS) return null;
  const issued = await issueChallenge(user, now);
  return { ...issued, user: { id: user.id, username: user.username } };
}

// markVerified(userId, now, accountId) — idempotent. `email_verified_at=is.null` in the
// WHERE means a second confirm never rewrites the original timestamp (the audit trail of
// WHEN the address was proven has to stay stable — P-07 retention/evidence depends on it).
// accountId is required: without it the update falls back to the shared default bucket
// and matches zero rows for any migrated personal account (2026-08-25 fix).
async function markVerified(userId, now, accountId) {
  await sbUpdate('users', { id: userId, extra: 'email_verified_at=is.null', scope: { account_id: accountId } },
    { email_verified_at: new Date(now).toISOString() });
}

// claim(row) -> true if THIS caller won the single-use claim. A conditional UPDATE, so
// two concurrent confirms of the same challenge cannot both succeed: Postgres serialises
// them and the loser matches zero rows. sbUpdate returns `representation`, so a
// zero-length array is an unambiguous "matched nothing" (that contract was hardened after
// the 2026-07-22 live incident — see lib/supabase.js). Scoped by the row's OWN account_id
// (2026-08-25 fix, matches issueChallenge's write) rather than the shared default.
async function claim(row, now = Date.now()) {
  const claimed = await sbUpdate('email_challenges',
    { id: row.id, extra: 'consumed_at=is.null', scope: { account_id: row.account_id } },
    { consumed_at: new Date(now).toISOString() });
  return Array.isArray(claimed) && claimed.length > 0;
}

// spendAttempt(row) -> true if this caller successfully booked one guess.
// Compare-and-swap on the observed count: if a concurrent request bumped it first, this
// matches zero rows and the guess is refused rather than silently sharing a slot.
async function spendAttempt(row, now = Date.now()) {
  const bumped = await sbUpdate('email_challenges',
    { id: row.id, extra: 'attempts=eq.' + Number(row.attempts || 0), scope: { account_id: row.account_id } },
    { attempts: Number(row.attempts || 0) + 1 });
  return Array.isArray(bumped) && bumped.length > 0;
}

function usable(row, now) {
  if (!row) return false;
  if (row.consumed_at) return false;
  if (!row.expires_at || new Date(row.expires_at).getTime() <= now) return false;
  return true;
}

// confirmByCode(email, code) -> { ok:true, userId } | { ok:false, error }.
// Order is deliberate: the attempt is SPENT before the code is compared, so a crash or a
// lost race costs the guesser a slot instead of handing them a free one.
async function confirmByCode(email, code, now = Date.now()) {
  const fail = { ok: false, error: GENERIC_FAIL };
  // Type-check BEFORE coercing. A JSON body is attacker-shaped, and String(['123456'])
  // === '123456' — so a bare String() would quietly accept an ARRAY as a valid code. Nothing
  // dangerous follows from it here, but type confusion at a credential boundary is a habit
  // worth refusing outright rather than reasoning about case by case.
  if (typeof code !== 'string') return fail;
  const entered = code.trim();
  if (!/^[0-9]{6}$/.test(entered)) return fail;

  const user = await findOwner(email);
  if (!user) return fail;
  // NOTE (deliberate, do not "fix" this back): there is NO early
  // `if (user.email_verified_at) return ok` short-circuit here, tempting as it is for
  // idempotency. Answering success before checking the code would turn this endpoint into an
  // oracle — anyone could submit a junk code and learn from the response alone whether an
  // address has an account AND whether it is already verified. An already-verified user's
  // challenge is necessarily consumed, so they fall through to the same generic failure as
  // everyone else. The idempotent re-tap case is handled in confirmByToken instead, where
  // holding the 256-bit token is itself proof of ownership.
  const row = await latestChallenge(user.id, user.account_id);
  if (!usable(row, now)) return fail;
  if (Number(row.attempts || 0) >= Number(row.max_attempts || MAX_ATTEMPTS)) return fail;
  // The address must still be the one the challenge was issued to.
  if (normaliseEmail(row.email) !== normaliseEmail(user.username)) return fail;

  if (!(await spendAttempt(row, now))) return fail;
  if (!hashesEqual(tokenHash(entered), row.code_hash)) return fail;
  if (!(await claim(row, now))) return fail;   // lost the single-use race -> replay, refuse

  await markVerified(user.id, now, user.account_id);
  return { ok: true, userId: user.id };
}

// confirmByToken(token) -> { ok:true, userId } | { ok:false, error }.
// The magic-link half. No attempt budget here on purpose: the token is 256 bits, so
// guessing is not a threat model, and every miss simply finds no row. Looking up directly
// by token_hash is safe for the same reason (it would NOT be for the 6-digit code, whose
// 10^6 space is why confirmByCode scopes its lookup to one user first).
async function confirmByToken(token, now = Date.now()) {
  const fail = { ok: false, error: GENERIC_FAIL };
  if (typeof token !== 'string') return fail;   // same type-confusion refusal as confirmByCode
  const raw = token.trim();
  if (!raw) return fail;

  // token_hash carries a UNIQUE index (schema.sql) — globally unique, same reasoning as
  // sessions.token_hash — so this is a pre-account-id identity lookup, not a scoped read
  // (2026-08-25 fix: was a scoped sbSelect defaulting to the shared bucket, silently
  // matching nothing for any migrated account's challenge).
  const rows = await sbSelectGlobal('email_challenges', { eq: { token_hash: tokenHash(raw), purpose: PURPOSE }, limit: 1 });
  const row = rows && rows[0];
  if (!row) return fail;

  // Idempotent re-tap: a mail client that prefetches links, a user who taps twice, or a
  // confirm on phone then laptop must not be shown an error for a state that is already
  // correct. Safe to answer honestly ONLY here, because presenting the raw 256-bit token is
  // itself proof of ownership — this is not an oracle the way the 6-digit path would be. And
  // it is still gated on the account genuinely being verified, so a consumed-but-unverified
  // row (which should not exist) reports failure rather than inventing success.
  if (row.consumed_at) {
    // Identity lookup by primary key `id` — same sbSelectGlobal reasoning as above
    // (2026-08-25 fix; was unscoped-but-scoped-by-default, matching nothing for a
    // migrated account).
    const owners = await sbSelectGlobal('users', { eq: { id: row.user_id }, limit: 1 });
    const owner = owners && owners[0];
    return (owner && owner.email_verified_at)
      ? { ok: true, userId: row.user_id, already: true }
      : fail;
  }

  if (!usable(row, now)) return fail;
  if (!(await claim(row, now))) return fail;

  await markVerified(row.user_id, now, row.account_id);
  return { ok: true, userId: row.user_id };
}

// verificationState(user) -> { email, verified, verified_at } for a users row.
// The shape W-01 (web) and M-02 (Android) both render from — one place, so the two
// clients can never drift on what "verified" means.
function verificationState(user) {
  const verified_at = (user && user.email_verified_at) || null;
  return { email: (user && user.username) || null, verified: Boolean(verified_at), verified_at };
}

module.exports = {
  requestVerification, confirmByCode, confirmByToken, verificationState,
  issueChallenge, findOwner, latestChallenge,
  genCode, genToken,
  VERIFY_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, PURPOSE, GENERIC_FAIL,
};
