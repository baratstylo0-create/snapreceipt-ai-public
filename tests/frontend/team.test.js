'use strict';
// components/team.js (ADR-021 Phase 2/8): the pure logic behind the Team view —
// branch/staff/company normalisation, admin-role gating, the one-time credential
// panel model, and branch sort order. Node-testable, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const {
  isAdmin, normalizeBranch, normalizeStaff, normalizeCompany, credentialPanel, sortedBranches, botDeepLink,
  viewedCredentialPanel, copyBlockText,
} = require('../../public/js/components/team');

test('isAdmin: true only for role admin, false for clerk/staff/missing/garbage', () => {
  assert.strictEqual(isAdmin({ role: 'admin' }), true);
  assert.strictEqual(isAdmin({ role: 'clerk' }), false);
  assert.strictEqual(isAdmin({ role: 'staff' }), false);
  assert.strictEqual(isAdmin(null), false);
  assert.strictEqual(isAdmin(undefined), false);
  assert.strictEqual(isAdmin({}), false);
});

test('normalizeBranch: maps the real /api/branches row shape, tolerant of missing fields', () => {
  const b = normalizeBranch({ id: 'b1', office: 'Ipoh', state: 'Perak', clerk_name: 'Ali', active: true, company_id: 'c1' });
  assert.deepStrictEqual(b, { id: 'b1', office: 'Ipoh', state: 'Perak', clerkName: 'Ali', companyId: 'c1', active: true });
});

test('normalizeBranch: garbage/partial input never throws, sensible fallbacks', () => {
  assert.deepStrictEqual(normalizeBranch(null), { id: '', office: 'Untitled branch', state: '', clerkName: '', companyId: null, active: true });
  assert.deepStrictEqual(normalizeBranch({}), { id: '', office: 'Untitled branch', state: '', clerkName: '', companyId: null, active: true });
  // active:false must survive (a soft-deleted branch is still meaningful to show, dimmed)
  assert.strictEqual(normalizeBranch({ active: false }).active, false);
});

test('normalizeStaff: maps display_name, tolerant of missing fields', () => {
  assert.deepStrictEqual(normalizeStaff({ id: 's1', display_name: 'Siti' }), { id: 's1', name: 'Siti' });
  assert.deepStrictEqual(normalizeStaff(null), { id: '', name: 'Unnamed' });
});

test('normalizeCompany: maps name/currency, tolerant of missing fields', () => {
  assert.deepStrictEqual(normalizeCompany({ id: 'c1', name: 'Acme Sdn Bhd', currency: 'MYR' }), { id: 'c1', name: 'Acme Sdn Bhd', currency: 'MYR' });
  assert.deepStrictEqual(normalizeCompany({}), { id: '', name: 'Untitled company', currency: '' });
});

test('credentialPanel: builds the one-time shown-once model from a real POST /api/branches response', () => {
  const resp = { branch: { office: 'Ipoh' }, credentials: { username: 'ipoh-ab12', password: 'Str0ngPass!!' }, bindToken: 'tok-xyz' };
  assert.deepStrictEqual(credentialPanel('Ipoh', resp), { office: 'Ipoh', username: 'ipoh-ab12', password: 'Str0ngPass!!', bindToken: 'tok-xyz' });
});

test('credentialPanel: falls back to resp.branch.office when no office arg given', () => {
  const resp = { branch: { office: 'Ipoh' }, credentials: { username: 'u', password: 'p' } };
  assert.strictEqual(credentialPanel(null, resp).office, 'Ipoh');
});

test('credentialPanel: missing/garbage credentials -> null (never fabricates a password)', () => {
  assert.strictEqual(credentialPanel('Ipoh', {}), null);
  assert.strictEqual(credentialPanel('Ipoh', { credentials: {} }), null);
  assert.strictEqual(credentialPanel('Ipoh', { credentials: { username: 'u' } }), null); // no password
  assert.strictEqual(credentialPanel('Ipoh', null), null);
});

test('sortedBranches: active branches first, then alphabetical by office within each group', () => {
  const branches = [
    normalizeBranch({ office: 'Zebra', active: true }),
    normalizeBranch({ office: 'Alpha', active: false }),
    normalizeBranch({ office: 'Bravo', active: true }),
  ];
  const ids = sortedBranches(branches).map((b) => b.office);
  assert.deepStrictEqual(ids, ['Bravo', 'Zebra', 'Alpha']);
});

test('sortedBranches: garbage input never throws', () => {
  assert.deepStrictEqual(sortedBranches(null), []);
  assert.deepStrictEqual(sortedBranches(undefined), []);
});

// --- botDeepLink: the clickable t.me bot-binding link (mirrors setup/provision.js's
// CLI bindingLink() optional/degrade contract, just returning a URL instead of a line) ---

test('botDeepLink: builds a t.me deep link when both a bot username and a bind token are given', () => {
  assert.strictEqual(botDeepLink('ReceiptBot', 'tok-abc123'), 'https://t.me/ReceiptBot?start=tok-abc123');
});

test('botDeepLink: strips a leading @ from the username', () => {
  assert.strictEqual(botDeepLink('@ReceiptBot', 'tok-abc123'), 'https://t.me/ReceiptBot?start=tok-abc123');
});

test('botDeepLink: URL-encodes the token', () => {
  assert.strictEqual(botDeepLink('ReceiptBot', 'a+b/c'), 'https://t.me/ReceiptBot?start=a%2Bb%2Fc');
});

test('botDeepLink: null when the bot username is unset (frontend falls back to the raw code)', () => {
  assert.strictEqual(botDeepLink('', 'tok-abc123'), null);
  assert.strictEqual(botDeepLink(null, 'tok-abc123'), null);
  assert.strictEqual(botDeepLink(undefined, 'tok-abc123'), null);
});

test('botDeepLink: null when the bind token is missing, even with a configured bot', () => {
  assert.strictEqual(botDeepLink('ReceiptBot', ''), null);
  assert.strictEqual(botDeepLink('ReceiptBot', null), null);
});

// --- viewedCredentialPanel / copyBlockText: ADR-025 amendment (view a branch's
// credentials anytime + a one-tap copy-all), Owner-approved 2026-07-11 QA round ---

test('viewedCredentialPanel: builds the model from a real GET /api/branches/:id/credentials response', () => {
  const resp = { username: 'kl-ab12', password: 'Str0ngPass!!', bindToken: 'tok-xyz' };
  assert.deepStrictEqual(viewedCredentialPanel('Ipoh', resp),
    { office: 'Ipoh', username: 'kl-ab12', password: 'Str0ngPass!!', bindToken: 'tok-xyz' });
});

test('viewedCredentialPanel: NEVER returns null — a legacy branch (password:null) still shows username/link', () => {
  const p = viewedCredentialPanel('Ipoh', { username: 'kl-ab12', password: null, bindToken: null });
  assert.strictEqual(p.password, null);
  assert.strictEqual(p.username, 'kl-ab12');
});

test('viewedCredentialPanel: garbage/missing response never throws', () => {
  assert.deepStrictEqual(viewedCredentialPanel('Ipoh', null), { office: 'Ipoh', username: '', password: null, bindToken: '' });
  assert.deepStrictEqual(viewedCredentialPanel(null, {}), { office: '', username: '', password: null, bindToken: '' });
});

test('copyBlockText: username + password + bot link, one block', () => {
  const text = copyBlockText({ username: 'kl-ab12', password: 'Str0ngPass!!', bindToken: 'tok-xyz' }, 'ReceiptBot');
  assert.strictEqual(text, 'Username: kl-ab12\nPassword: Str0ngPass!!\nBot link: https://t.me/ReceiptBot?start=tok-xyz');
});

test('copyBlockText: no password (legacy branch) -> omits the line entirely, never prints "null"', () => {
  const text = copyBlockText({ username: 'kl-ab12', password: null, bindToken: 'tok-xyz' }, 'ReceiptBot');
  assert.doesNotMatch(text, /Password/);
  assert.doesNotMatch(text, /null/);
});

test('copyBlockText: no configured bot username -> falls back to the raw bind code', () => {
  const text = copyBlockText({ username: 'kl-ab12', password: 'p', bindToken: 'tok-xyz' }, '');
  assert.match(text, /Bot link: tok-xyz/);
});

test('copyBlockText: no bindToken at all -> no Bot link line, never throws', () => {
  const text = copyBlockText({ username: 'kl-ab12', password: 'p', bindToken: null }, 'ReceiptBot');
  assert.doesNotMatch(text, /Bot link/);
});
