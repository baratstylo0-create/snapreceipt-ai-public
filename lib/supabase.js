'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const enc = encodeURIComponent;
function qEq(obj) { return Object.entries(obj).map(([k, v]) => k + '=eq.' + enc(v)).join('&'); }

// All helpers inject account_id so callers can never forget tenant scoping.
async function sbSelect(table, { eq = {}, order, limit, extra } = {}) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ account_id: cfg.ACCOUNT_ID, ...eq });
  if (extra) url += '&' + extra;                 // e.g. 'deleted_at=is.null'
  if (order) url += '&order=' + order;
  if (limit) url += '&limit=' + limit;
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbInsert(table, row) {
  await hreq({ method: 'POST', url: cfg.SB_REST + '/' + table, headers: { ...cfg.sbH, Prefer: 'return=minimal' },
    body: { account_id: cfg.ACCOUNT_ID, ...row }, json: true });
}

// Like sbInsert, but echoes the inserted row back (ADR-017: reading a DB-generated
// column like voucher_no, which a trigger fills in and the caller never set).
// Returns the inserted row, or null on an unexpected/empty response shape.
async function sbInsertReturning(table, row) {
  const rows = await hreq({ method: 'POST', url: cfg.SB_REST + '/' + table, headers: { ...cfg.sbH, Prefer: 'return=representation' },
    body: { account_id: cfg.ACCOUNT_ID, ...row }, json: true });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function sbUpdate(table, { id }, patch) {
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID });
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbSoftDelete(table, { id }) {
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID });
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
