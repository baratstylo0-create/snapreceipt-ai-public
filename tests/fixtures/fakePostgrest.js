'use strict';
// A deliberately small in-memory stand-in for PostgREST, used by the P-01 email-verification
// tests (tests/emailChallenge.test.js, tests/verifyEmail.route.test.js).
//
// WHY NOT the usual one-liner `global.fetch` stub this repo uses elsewhere: the security
// properties P-01 has to prove are single-use claim and attempt-budget compare-and-swap, and
// BOTH are expressed as filters folded into the UPDATE's WHERE clause
// (`consumed_at=is.null`, `attempts=eq.<observed>`). A stub that ignores filters and always
// echoes a row back would make those tests pass no matter what the code did — it would be
// testing nothing. So this fake actually evaluates the filters and actually returns zero rows
// when they do not match, which is exactly the signal lib/emailChallenge.js relies on.
//
// It supports only what these tests use: `eq.`, `is.null`, `order=<col>.desc`, `limit`.
// Anything else THROWS rather than silently matching — an unsupported filter must surface as
// a loud test failure, never as a false pass.

let seq = 0;

function parse(url) {
  const [path, qs = ''] = String(url).split('?');
  const table = path.split('/').filter(Boolean).pop();
  const params = new URLSearchParams(qs);
  const filters = [];
  let order = null;
  let limit = null;
  for (const [k, v] of params) {
    if (k === 'order') { order = v; continue; }
    if (k === 'limit') { limit = Number(v); continue; }
    if (k === 'select') continue;
    filters.push([k, v]);
  }
  return { table, filters, order, limit };
}

function isNullish(v) { return v === null || v === undefined; }

function matches(row, filters) {
  return filters.every(([col, expr]) => {
    if (expr === 'is.null') return isNullish(row[col]);
    if (expr === 'not.is.null') return !isNullish(row[col]);
    if (expr.startsWith('eq.')) return String(row[col]) === expr.slice(3);
    throw new Error('fakePostgrest: unsupported filter "' + col + '=' + expr + '" — extend the fake rather than loosening it');
  });
}

function sortRows(rows, order) {
  if (!order) return rows;
  const [col, dir] = order.split('.');
  const sorted = rows.slice().sort((a, b) => String(a[col] || '').localeCompare(String(b[col] || '')));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

// createFakePostgrest({ users: [...], email_challenges: [...] })
//   -> { install(), restore(), db, requests }
// install() swaps global.fetch; anything that is not a Supabase REST call is delegated to the
// real fetch, so a test can still make its own HTTP probe against a live Express server.
function createFakePostgrest(seed = {}) {
  const db = {};
  for (const [table, rows] of Object.entries(seed)) {
    db[table] = rows.map((r) => ({ account_id: 'default', ...r }));
  }
  const requests = [];
  let realFetch = null;

  async function handle(url, opt = {}) {
    const method = (opt.method || 'GET').toUpperCase();
    const { table, filters, order, limit } = parse(url);
    if (!db[table]) db[table] = [];
    const rows = db[table];
    requests.push({ table, method, filters });

    if (method === 'GET') {
      let out = rows.filter((r) => matches(r, filters));
      out = sortRows(out, order);
      if (limit) out = out.slice(0, limit);
      return out;
    }
    if (method === 'POST') {
      const body = opt.body ? JSON.parse(opt.body) : {};
      const row = {
        id: table + '-' + (++seq),
        created_at: new Date().toISOString(),
        consumed_at: null,
        ...body,
      };
      rows.push(row);
      const prefer = (opt.headers && (opt.headers.Prefer || opt.headers.prefer)) || '';
      return prefer.includes('return=representation') ? [row] : [];
    }
    if (method === 'PATCH') {
      const patch = opt.body ? JSON.parse(opt.body) : {};
      const hit = rows.filter((r) => matches(r, filters));
      for (const r of hit) Object.assign(r, patch);
      return hit;
    }
    if (method === 'DELETE') {
      const hit = rows.filter((r) => matches(r, filters));
      db[table] = rows.filter((r) => !matches(r, filters));
      return hit;
    }
    throw new Error('fakePostgrest: unsupported method ' + method);
  }

  function install() {
    realFetch = global.fetch;
    global.fetch = async (url, opt = {}) => {
      const u = String(url);
      if (!u.includes('/rest/v1/')) return realFetch(url, opt);   // the test's own probe
      const result = await handle(u, opt);
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    };
  }

  function restore() { if (realFetch) global.fetch = realFetch; }

  return { install, restore, db, requests };
}

module.exports = { createFakePostgrest };
