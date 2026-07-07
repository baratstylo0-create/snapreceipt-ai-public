'use strict';
// lib/supabase.js's M2 scope hook (ADR-021, issue #107) — the ONE isolation
// choke-point every business query filters/stamps through. `scope` mirrors
// lib/auth.js's frozen scopeForUser() contract: admin -> { account_id, role }
// (no branch_id key -> sees every branch); clerk -> { account_id, branch_id,
// role } (hard-filtered to their branch). Mirrors the stub style already used
// in tests/supabase.insertreturning.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { sbSelect, sbUpdate, sbSoftDelete, sbInsert, sbInsertReturning } = require('../lib/supabase');

function stubFetch(respond) {
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opt = {}) => {
    seen = { url, method: opt.method || 'GET', headers: opt.headers, body: opt.body ? JSON.parse(opt.body) : undefined };
    return { text: async () => JSON.stringify(respond(seen)) };
  };
  return { restore: () => { global.fetch = realFetch; }, seen: () => seen };
}

// Faithfully simulate PostgREST applying this URL's filters to a candidate row set:
// top-level `col=eq.val` params are AND-ed; an `or=(a.eq.X,b.is.null)` group is AND-ed
// as a whole and matches a row if ANY disjunct matches. Just enough to PROVE the
// null-tolerant company filter actually returns legacy company_id=null rows (a bare
// company_id=eq.<x> would drop them) — the real bug Jeevan traced through the clerk
// petty-cash statement, which no URL-string assertion would catch on its own.
function applyFilters(url, rows) {
  const eqs = [];        // AND-ed equalities
  let orGroup = null;    // one or() disjunction
  for (const p of (url.split('?')[1] || '').split('&')) {
    const orM = p.match(/^or=\((.+)\)$/);
    if (orM) {
      orGroup = orM[1].split(',').map((d) => {
        const [col, op, ...rest] = d.split('.');
        return { col, op, val: decodeURIComponent(rest.join('.')) };
      });
      continue;
    }
    const m = p.match(/^([a-z_]+)=eq\.(.+)$/);
    if (m) eqs.push({ col: m[1], val: decodeURIComponent(m[2]) });
  }
  return rows.filter((r) => {
    for (const { col, val } of eqs) if (String(r[col]) !== val) return false;
    if (orGroup && !orGroup.some(({ col, op, val }) =>
      op === 'is' && val === 'null' ? r[col] == null : String(r[col]) === val)) return false;
    return true;
  });
}

const ADMIN_SCOPE = { account_id: 'default', role: 'admin' };
const CLERK_A = { account_id: 'default', branch_id: 'branch-A', role: 'clerk' };
const CLERK_B = { account_id: 'default', branch_id: 'branch-B', role: 'clerk' };
// Multi-company clients (ADR-023 Phase 8): a clerk scope carries BOTH company_id and
// branch_id. Two clerks in different companies must each filter/stamp to their own company.
const CLERK_CO1 = { account_id: 'default', company_id: 'co-1', branch_id: 'branch-A', role: 'clerk' };
const CLERK_CO2 = { account_id: 'default', company_id: 'co-2', branch_id: 'branch-Z', role: 'clerk' };

// --- sbSelect ------------------------------------------------------------------

test('sbSelect with a clerk scope filters by branch_id=eq.<their branch> in the URL', async () => {
  const stub = stubFetch(() => [{ id: 'e1', branch_id: 'branch-A' }]);
  try {
    await sbSelect('expenses', { scope: CLERK_A });
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
  } finally { stub.restore(); }
});

// The actual isolation guarantee: a clerk-A query and a clerk-B query must each
// scope to THEIR OWN branch only — never bleed into or omit the other's filter.
test('sbSelect: clerk A and clerk B produce URLs scoped to their own branch only (isolation)', async () => {
  const seenUrls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { seenUrls.push(url); return { text: async () => JSON.stringify([{ id: 'a1' }]) }; };
  try {
    await sbSelect('expenses', { scope: CLERK_A });
    await sbSelect('expenses', { scope: CLERK_B });
    assert.match(seenUrls[0], /branch_id=eq\.branch-A/);
    assert.doesNotMatch(seenUrls[0], /branch_id=eq\.branch-B/);
    assert.match(seenUrls[1], /branch_id=eq\.branch-B/);
    assert.doesNotMatch(seenUrls[1], /branch_id=eq\.branch-A/);
  } finally { global.fetch = realFetch; }
});

test('sbSelect with an admin scope applies NO branch_id filter (sees all branches)', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { scope: ADMIN_SCOPE });
    assert.doesNotMatch(stub.seen().url, /branch_id=/);
  } finally { stub.restore(); }
});

// --- company isolation (ADR-023 Phase 8, issue #107 mandatory SEC-2) --------------

test('sbSelect with a multi-company clerk scope filters company null-tolerantly + branch hard', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { scope: CLERK_CO1 });
    // company is a NULL-TOLERANT or() group (issue #133 note 1), not a hard eq that
    // would hide legacy company_id=null rows; branch stays a hard AND filter.
    assert.match(stub.seen().url, /or=\(company_id\.eq\.co-1,company_id\.is\.null\)/);
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
    // the regression form (hard company eq) must NOT be present.
    assert.doesNotMatch(stub.seen().url, /company_id=eq\./);
  } finally { stub.restore(); }
});

// Issue #133 acceptance: a clerk who now carries a company_id must STILL see rows
// created before the company dimension existed (company_id = null). The is.null
// branch of the or() group is what guarantees that visibility.
test('sbSelect: a multi-company clerk still sees legacy company_id=null rows (no visibility regression)', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { scope: CLERK_CO1 });
    assert.match(stub.seen().url, /company_id\.is\.null/);
  } finally { stub.restore(); }
});

// THE cross-company guarantee: a clerk of company 1 and a clerk of company 2 each scope
// to their OWN company only — a company-1 read can never carry company-2's filter.
test('sbSelect: clerk of company 1 vs company 2 are scoped to their own company only (isolation)', async () => {
  const seenUrls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { seenUrls.push(url); return { text: async () => JSON.stringify([]) }; };
  try {
    await sbSelect('expenses', { scope: CLERK_CO1 });
    await sbSelect('expenses', { scope: CLERK_CO2 });
    assert.match(seenUrls[0], /company_id\.eq\.co-1/);
    assert.doesNotMatch(seenUrls[0], /company_id\.eq\.co-2/);
    assert.match(seenUrls[1], /company_id\.eq\.co-2/);
    assert.doesNotMatch(seenUrls[1], /company_id\.eq\.co-1/);
  } finally { global.fetch = realFetch; }
});

// Jeevan's #133 blocker, reproduced end-to-end: petty_cash_floats / cash_in rows are
// inserted with NO company_id (null-by-design in v1, lib/pettyCash.js), and
// routes/statement.js passes a company-clerk's full scope to those reads. Under a bare
// company_id=eq.<x> the always-null float row returns zero → the clerk's statement
// silently shows no opening float. Null-tolerance must return it. Fails under bare eq.
test('sbSelect: a company-clerk STILL gets a null-company float row (the statement-breaking case, #133)', async () => {
  const floats = [
    { id: 'f1', account_id: 'default', branch_id: 'branch-A', company_id: null },    // legacy, null-by-design
    { id: 'f2', account_id: 'default', branch_id: 'branch-A', company_id: 'co-2' },   // some other company's row
  ];
  const stub = stubFetch((seen) => applyFilters(seen.url, floats));
  try {
    const rows = await sbSelect('petty_cash_floats', { eq: { branch_id: 'branch-A' }, scope: CLERK_CO1 });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('f1'), 'legacy company_id=null float must stay visible (else the statement shows no opening float)');
    assert.ok(!ids.includes('f2'), "another company's float must never leak");
  } finally { stub.restore(); }
});

// #133 note 1, at the row level: a company-clerk still sees an own-branch expense whose
// company_id IS NULL, but never another company's real (non-null) row.
test('sbSelect: a company-clerk sees own-branch company_id=null expenses, not another company\'s rows', async () => {
  const expenses = [
    { id: 'e1', account_id: 'default', branch_id: 'branch-A', company_id: null },     // legacy
    { id: 'e2', account_id: 'default', branch_id: 'branch-A', company_id: 'co-1' },    // theirs
    { id: 'e3', account_id: 'default', branch_id: 'branch-A', company_id: 'co-2' },    // another company's
  ];
  const stub = stubFetch((seen) => applyFilters(seen.url, expenses));
  try {
    const rows = await sbSelect('expenses', { eq: { branch_id: 'branch-A' }, scope: CLERK_CO1 });
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['e1', 'e2']);
  } finally { stub.restore(); }
});

test('sbSelect with an admin scope applies NO company_id filter (sees all companies)', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { scope: ADMIN_SCOPE });
    assert.doesNotMatch(stub.seen().url, /company_id/);
  } finally { stub.restore(); }
});

test('sbSelect with a branch-only clerk scope (no company_id) has no company filter — back-compat', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { scope: CLERK_A });
    assert.doesNotMatch(stub.seen().url, /company_id/);
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
  } finally { stub.restore(); }
});

test('sbSelect with NO scope arg is unchanged (personal mode, zero regression)', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSelect('expenses', { eq: { id: 'x' } });
    assert.doesNotMatch(stub.seen().url, /branch_id=/);
    assert.match(stub.seen().url, /account_id=eq\.default/);
  } finally { stub.restore(); }
});

// --- sbUpdate / sbSoftDelete -----------------------------------------------------

test('sbUpdate with a clerk scope adds branch_id=eq.<branch> — a clerk cannot patch another branch\'s row', async () => {
  const stub = stubFetch(() => [{ id: 'e1' }]);
  try {
    await sbUpdate('expenses', { id: 'e1', scope: CLERK_A }, { category: 'Food' });
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
  } finally { stub.restore(); }
});

test('sbUpdate with NO scope is unchanged', async () => {
  const stub = stubFetch(() => [{ id: 'e1' }]);
  try {
    await sbUpdate('expenses', { id: 'e1' }, { category: 'Food' });
    assert.doesNotMatch(stub.seen().url, /branch_id=/);
  } finally { stub.restore(); }
});

test('sbSoftDelete with a clerk scope adds the branch filter', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSoftDelete('expenses', { id: 'e1', scope: CLERK_A });
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
  } finally { stub.restore(); }
});

test('sbSoftDelete with an admin scope has no branch filter', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSoftDelete('expenses', { id: 'e1', scope: ADMIN_SCOPE });
    assert.doesNotMatch(stub.seen().url, /branch_id=/);
  } finally { stub.restore(); }
});

// --- sbInsert / sbInsertReturning (auto-stamp, not filter) ------------------------

test('sbInsert with a clerk scope auto-stamps branch_id + account_id, overriding any caller-supplied branch_id', async () => {
  const stub = stubFetch(() => ({}));
  try {
    await sbInsert('expenses', { merchant: 'Shell', branch_id: 'spoofed-branch' }, CLERK_A);
    assert.strictEqual(stub.seen().body.branch_id, 'branch-A');
    assert.strictEqual(stub.seen().body.account_id, 'default');
    assert.strictEqual(stub.seen().body.merchant, 'Shell');
  } finally { stub.restore(); }
});

test('sbInsert with a clerk scope: a spoofed account_id in the row cannot override the scope account_id', async () => {
  const stub = stubFetch(() => ({}));
  try {
    await sbInsert('expenses', { merchant: 'X', account_id: 'evil-account' }, CLERK_A);
    assert.strictEqual(stub.seen().body.account_id, 'default');
  } finally { stub.restore(); }
});

test('sbInsertReturning with an admin scope does NOT force a branch_id (admin rows may be branch-less)', async () => {
  const stub = stubFetch(() => [{ id: 'e2' }]);
  try {
    await sbInsertReturning('expenses', { merchant: 'X' }, ADMIN_SCOPE);
    assert.ok(!('branch_id' in stub.seen().body));
    assert.strictEqual(stub.seen().body.account_id, 'default');
  } finally { stub.restore(); }
});

test('sbInsert with a multi-company clerk scope auto-stamps company_id, overriding any caller-supplied one', async () => {
  const stub = stubFetch(() => ({}));
  try {
    await sbInsert('expenses', { merchant: 'Shell', company_id: 'spoofed-co', branch_id: 'spoofed-b' }, CLERK_CO1);
    assert.strictEqual(stub.seen().body.company_id, 'co-1');
    assert.strictEqual(stub.seen().body.branch_id, 'branch-A');
    assert.strictEqual(stub.seen().body.merchant, 'Shell');
  } finally { stub.restore(); }
});

test('sbUpdate with a multi-company clerk scope adds the null-tolerant company group — cannot patch another company\'s row', async () => {
  const stub = stubFetch(() => [{ id: 'e1' }]);
  try {
    await sbUpdate('expenses', { id: 'e1', scope: CLERK_CO1 }, { category: 'Food' });
    // another company's real (non-null) row is excluded by both the branch AND the
    // company-eq branch of the or(); only their own company or legacy-null rows match.
    assert.match(stub.seen().url, /or=\(company_id\.eq\.co-1,company_id\.is\.null\)/);
    assert.match(stub.seen().url, /branch_id=eq\.branch-A/);
  } finally { stub.restore(); }
});

test('sbSoftDelete with a multi-company clerk scope adds the null-tolerant company group', async () => {
  const stub = stubFetch(() => ([]));
  try {
    await sbSoftDelete('expenses', { id: 'e1', scope: CLERK_CO1 });
    assert.match(stub.seen().url, /or=\(company_id\.eq\.co-1,company_id\.is\.null\)/);
  } finally { stub.restore(); }
});

test('sbInsertReturning with an admin scope does NOT force a company_id (admin rows may be company-less)', async () => {
  const stub = stubFetch(() => [{ id: 'e9' }]);
  try {
    await sbInsertReturning('expenses', { merchant: 'X' }, ADMIN_SCOPE);
    assert.ok(!('company_id' in stub.seen().body));
  } finally { stub.restore(); }
});

test('sbInsert with NO scope arg is unchanged: only account_id is stamped (personal mode)', async () => {
  const stub = stubFetch(() => ({}));
  try {
    await sbInsert('expenses', { merchant: 'Y' });
    assert.strictEqual(stub.seen().body.account_id, 'default');
    assert.ok(!('branch_id' in stub.seen().body));
  } finally { stub.restore(); }
});

test('sbInsertReturning with NO scope arg is unchanged', async () => {
  const stub = stubFetch(() => [{ id: 'e3' }]);
  try {
    const row = await sbInsertReturning('expenses', { merchant: 'Z' });
    assert.strictEqual(stub.seen().body.account_id, 'default');
    assert.ok(!('branch_id' in stub.seen().body));
    assert.deepStrictEqual(row, { id: 'e3' });
  } finally { stub.restore(); }
});
