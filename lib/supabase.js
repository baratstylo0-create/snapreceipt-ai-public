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

async function sbUpdate(table, { id, scope }, patch) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
  const or = scopeOr(scope);                       // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbSoftDelete(table, { id, scope }) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
  const or = scopeOr(scope);                       // null-tolerant company_id group (issue #133)
  if (or) url += '&' + or;
  await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=minimal' }, body: { deleted_at: new Date().toISOString() }, json: true });
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

module.exports = { sbSelect, sbInsert, sbInsertReturning, sbUpdate, sbSoftDelete, sbRpc };
