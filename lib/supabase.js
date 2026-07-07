'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const enc = encodeURIComponent;
function qEq(obj) { return Object.entries(obj).map(([k, v]) => k + '=eq.' + enc(v)).join('&'); }

// M2 isolation bouncer (ADR-021/ADR-023, issue #107): the ONE choke-point every
// business query filters/stamps through. `scope` is `lib/auth.js`'s frozen
// scopeForUser() output: admin -> { account_id, role } (no company_id/branch_id
// keys -> no filter, sees every company + branch); clerk -> { account_id,
// company_id?, branch_id, role } (hard-filtered). BOTH company_id and branch_id
// are applied when present (defense-in-depth: a branch lives inside one company,
// so branch_id already dominates, but the company filter is the belt to that
// suspenders for any company-scoped read/write path). role is metadata only,
// never a column filter. Callers that omit `scope` entirely (every existing
// personal call site) get scopeEq(undefined) === {} — a no-op spread, so
// behaviour is byte-identical to before this hook existed. Table-awareness is the
// CALLER's responsibility (issue #131): only pass a scope to helpers hitting
// tables that actually carry the column(s) being filtered on.
function scopeEq(scope) {
  if (!scope) return {};
  const out = { account_id: scope.account_id };
  if (scope.company_id) out.company_id = scope.company_id;
  if (scope.branch_id) out.branch_id = scope.branch_id;
  return out;
}

// All helpers inject account_id so callers can never forget tenant scoping.
async function sbSelect(table, { eq = {}, order, limit, extra, scope } = {}) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ account_id: cfg.ACCOUNT_ID, ...eq, ...scopeEq(scope) });
  if (extra) url += '&' + extra;                 // e.g. 'deleted_at=is.null'
  if (order) url += '&order=' + order;
  if (limit) url += '&limit=' + limit;
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  return Array.isArray(rows) ? rows : [];
}

// scope (optional 3rd arg, NOT part of `row`): auto-stamps account_id + company_id
// + branch_id from the caller's own scope, injected AFTER row's own fields so a clerk
// can never smuggle a different company_id/branch_id by putting one in `row` — scope
// always wins on a write. company_id/branch_id are each stamped only when the scope
// carries them (admin rows may legitimately be company-/branch-less).
function stampScope(row, scope) {
  return scope
    ? { account_id: scope.account_id, ...row,
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
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbSoftDelete(table, { id, scope }) {
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID, ...scopeEq(scope) });
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
