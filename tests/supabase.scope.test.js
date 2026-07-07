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
