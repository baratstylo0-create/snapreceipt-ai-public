'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const enc = encodeURIComponent;
function qEq(obj) { return Object.entries(obj).map(([k, v]) => k + '=eq.' + enc(v)).join('&'); }

// M2 isolation bouncer (ADR-021/ADR-023, issue #107/#133): the ONE choke-point every
// business query filters/stamps through. `scope` is `lib/auth.js`'s frozen
// scopeForUser() output: admin -> { account_id, role } (no company_id/branch_id
// keys -> no filter, sees every company + branch); clerk -> { account_id,
// company_id?, branch_id, role } (hard-filtered). role is metadata only, never a
// column filter. Callers that omit `scope` entirely (every existing personal call
// site) get scopeEq(undefined) === {} and scopeOr(undefined) === '' — a no-op
// spread + no extra param, so behaviour is byte-identical to before this hook
// existed. Table-awareness is the CALLER's responsibility (issue #131): only pass a
// scope to helpers hitting tables that actually carry the column(s) filtered on.
//
// scopeEq builds the HARD (AND-ed) equality filters: account_id always, and
// branch_id when the clerk has one. A branch lives inside exactly one company, so
// branch_id already gives a clerk transitive company isolation.
function scopeEq(scope) {
  if (!scope) return {};
  const out = { account_id: scope.account_id };
  if (scope.branch_id) out.branch_id = scope.branch_id;
  return out;
}

// scopeOr builds the company_id filter as a NULL-TOLERANT PostgREST or() group
// (issue #133 note 1), returning a raw '&'-appendable query fragment ('' when no
// company filter applies). Rows created before the company dimension existed carry
// company_id = null; a hard company_id=eq.<x> would HIDE them from a clerk who now
// has a company_id in scope — a visibility regression, not a leak (branch_id still
// hard-isolates the clerk, so no other company's real rows can be seen). So company
// is matched as (company_id = <theirs> OR company_id IS NULL) until a backfill
// stamps the legacy rows, after which the null branch matches nothing and this is a
// plain company equality. Admin / pre-Phase-8 clerk (no company_id) -> '' (no filter).
// CAVEAT for a FUTURE company-scoped-only role (company_id but no branch_id): the
// is.null tolerance would let it see legacy null-company rows across companies until
// the backfill runs — acceptable transitionally per #133, revisit before that role ships.
function scopeOr(scope) {
  return scope && scope.company_id
    ? 'or=(company_id.eq.' + enc(scope.company_id) + ',company_id.is.null)'
    : '';
}

// All helpers inject account_id so callers can never forget tenant scoping.
async function sbSelect(table, { eq = {}, order, limit, extra, scope } = {}) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ account_id: cfg.ACCOUNT_ID, ...eq, ...scopeEq(scope) });
  const or = scopeOr(scope);                      // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  if (extra) url += '&' + extra;                 // e.g. 'deleted_at=is.null'
  if (order) url += '&order=' + order;
  if (limit) url += '&limit=' + limit;
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  return Array.isArray(rows) ? rows : [];
}

// scope (optional 3rd arg, NOT part of `row`): auto-stamps account_id + company_id
// + branch_id from the caller's own scope, ALL injected AFTER row's own fields so a
// clerk can never smuggle a different account_id/company_id/branch_id by putting one
// in `row` — scope always wins on a write (account_id is stamped last too, for the
// same override-protection as company_id/branch_id). company_id/branch_id are each
// stamped only when the scope carries them (admin rows may be company-/branch-less).
function stampScope(row, scope) {
  return scope
    ? { ...row,
        account_id: scope.account_id,
        ...(scope.company_id ? { company_id: scope.company_id } : {}),
        ...(scope.branch_id ? { branch_id: scope.branch_id } : {}) }
    : { account_id: cfg.ACCOUNT_ID, ...row };
}

async function sbInsert(table, row, scope) {
  await hreq({ method: 'POST', url: cfg.SB_REST + '/' + table, headers: { ...cfg.sbH, Prefer: 'return=minimal' },
    body: stampScope(row, scope), json: true });
}

// Like sbInsert, but echoes the inserted row back (ADR-017: reading a DB-generated
// column like voucher_no, which a trigger fills in and the caller never set).
// Returns the inserted row, or null on an unexpected/empty response shape.
async function sbInsertReturning(table, row, scope) {
  const rows = await hreq({ method: 'POST', url: cfg.SB_REST + '/' + table, headers: { ...cfg.sbH, Prefer: 'return=representation' },
    body: stampScope(row, scope), json: true });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function sbUpdate(table, { id, scope, extra }, patch) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
  const or = scopeOr(scope);                       // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  if (extra) url += '&' + extra;
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
  return Array.isArray(rows) ? rows : [];
}

// 2026-07-22 (Owner-reported live incident): used to fire-and-forget with
// Prefer:'return=minimal', so a WHERE clause that matched ZERO rows (e.g. a scope's
// branch_id filter excluding a legacy row with no branch_id) looked identical to a real
// delete -- every caller reported success while nothing was touched. Now mirrors
// sbUpdate's return=representation + array-return contract exactly, so a caller can tell
// "deleted" from "matched nothing" instead of assuming success.
async function sbSoftDelete(table, { id, scope }) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
  const or = scopeOr(scope);                       // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: { deleted_at: new Date().toISOString() }, json: true });
  return Array.isArray(rows) ? rows : [];
}

// Real (non-soft) DELETE — QA B8 (docs/qa/2026-07-09-qa-round.md): the Owner wants a genuine
// permanent-delete path for rejected bills, distinct from sbSoftDelete's deleted_at stamp. Same
// scope/company-filter shape as sbUpdate/sbSoftDelete. Optional `eq` lets a caller fold a safety
// predicate (e.g. status='rejected') into the DELETE itself, avoiding a SELECT-then-DELETE race.
async function sbHardDelete(table, { id, scope, eq = {} }) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...eq, ...scopeEq(scope) });
  const or = scopeOr(scope);                       // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  const rows = await hreq({ method: 'DELETE', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, json: true });
  return Array.isArray(rows) ? rows : [];
}

// Call a Postgres function exposed via PostgREST's RPC endpoint (POST /rpc/<fn>). Unlike
// the table helpers above, this does NOT auto-inject account_id — an RPC function's
// argument names are function-specific (e.g. `p_account`), not a generic `account_id`
// column, so the caller supplies exactly the args its target function declares. Returns
// whatever PostgREST returns (an object for a single-row-returning function, an array for
// a set-returning one) — the caller knows its own function's shape.
async function sbRpc(fnName, args = {}) {
  return hreq({ method: 'POST', url: cfg.SB_REST + '/rpc/' + fnName, headers: cfg.sbH, body: args, json: true });
}

// sbSelectGlobal: like sbSelect but WITHOUT the automatic account_id=cfg.ACCOUNT_ID filter.
// 2026-08-22: every personal (owner) account now carries its own unique account_id (the
// 2026-08-14 isolation fix + the 2026-08-22 backfill that migrated the 7 pre-existing owners
// off the old shared bucket). A "does this email already exist" identity check MUST be
// tenant-independent BY DEFINITION — that's the whole point of the check — but sbSelect's
// implicit account_id=cfg.ACCOUNT_ID filter silently limited it to the old shared bucket.
// Once a user's account_id no longer equals cfg.ACCOUNT_ID (true for every migrated real
// user, starting the moment the backfill ran), that check went blind to their own row: signup
// duplicate-check thought no such user existed and created a fresh one (confirmed live —
// baratstylo0@gmail.com got a brand-new empty account on a routine Google re-login the day
// after the backfill), and /api/login's username lookup would 401 a real user with a correct
// password. Used ONLY for pre-account identity resolution (username lookup before an
// account_id is even known) — every subsequent query on a resolved row still goes through
// the normal scoped sbSelect/sbUpdate/etc.
//
// ORDER BY created_at.asc is NOT optional here: a duplicate account created by THIS very bug
// (before this fix shipped) can still exist alongside the real one. Postgres/PostgREST make
// no row-order guarantee without an explicit ORDER BY — a `limit`-only query over duplicate
// rows can return either one, unpredictably, request to request. Oldest-first makes identity
// resolution deterministic and correct: the real, original account (always created first)
// wins every time, never the empty duplicate a later buggy login/signup accidentally spawned.
// order defaults to created_at.asc (oldest-first — correct for an identity/dup-email check,
// where the real original account always predates a buggy duplicate). 2026-08-22: a chat_id
// lookup (lib/bot.js resolveBinding) needs the OPPOSITE tie-break — when the SAME physical
// Telegram chat ends up bound to two different bot_bindings rows (e.g. a user test-bound a
// throwaway/demo account, then later bound their real one to the same chat — bindWithToken
// never cleared the earlier row's chat_id), the MOST RECENTLY bound row reflects the user's
// actual current intent, not whichever row happens to be older. Caught live: an old test
// account (demo.video@receiptanalyser.local, bound 2026-07-29) and Barat's real production
// account (bound 2026-08-09) shared one chat_id — oldest-first was about to misattribute
// every one of his future Telegram messages to the wrong, unrelated account.
async function sbSelectGlobal(table, { eq = {}, limit, order = 'created_at.asc' } = {}) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq(eq) + '&order=' + order;
  if (limit) url += '&limit=' + limit;
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  return Array.isArray(rows) ? rows : [];
}

module.exports = { sbSelect, sbSelectGlobal, sbInsert, sbInsertReturning, sbUpdate, sbSoftDelete, sbHardDelete, sbRpc };
