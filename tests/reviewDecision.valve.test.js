'use strict';
// lib/reviewDecision.js Phase 4 (ADR-021): the staff-first decision gate. In business mode the
// branch CLERK decides their own branch's flagged items first; the ADMIN may override an EXISTING
// decision at any time, but may not ORIGINATE one until the row has waited ANOMALY_VALVE_DAYS
// (the safety valve — nothing rots unreviewed forever). Carve-outs: rows on the admin's own
// branch (Head Office — no clerk beneath) and untagged rows are admin-first immediately.
// Personal mode (no scope) is byte-for-byte the old canDecide behaviour.
const test = require('node:test');
const assert = require('node:assert');
const { canRoleDecide, buildReviewAudit } = require('../lib/reviewDecision');

const NOW = Date.parse('2026-07-07T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const pending = (over = {}) => ({ status: 'needs_review', branch_id: 'bA', created_at: daysAgo(1), ...over });
const CLERK_A = { role: 'clerk', branch_id: 'bA', account_id: 'default' };
const ADMIN = { role: 'admin', branch_id: 'bHQ', account_id: 'default' };
const OPTS = { valveDays: 7, now: () => NOW };

test('personal mode (no scope): pending row decidable, decided row 409 (unchanged)', () => {
  assert.strictEqual(canRoleDecide(pending(), null, OPTS).ok, true);
  const r = canRoleDecide(pending({ status: 'approved' }), null, OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 409);
});

test('clerk decides a pending row on their OWN branch', () => {
  assert.strictEqual(canRoleDecide(pending(), CLERK_A, OPTS).ok, true);
});

test('clerk cannot decide another branch\'s row (403) or re-decide a decided row (409)', () => {
  const cross = canRoleDecide(pending({ branch_id: 'bB' }), CLERK_A, OPTS);
  assert.strictEqual(cross.ok, false);
  assert.strictEqual(cross.code, 403);
  const redecide = canRoleDecide(pending({ status: 'rejected' }), CLERK_A, OPTS);
  assert.strictEqual(redecide.ok, false);
  assert.strictEqual(redecide.code, 409);
});

test('admin cannot ORIGINATE on a clerk\'s branch before the valve opens (403 with wait info)', () => {
  const r = canRoleDecide(pending({ created_at: daysAgo(2) }), ADMIN, OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 403);
  assert.match(r.error, /clerk/i);
});

test('admin CAN originate once the row has waited valveDays (valve fires)', () => {
  assert.strictEqual(canRoleDecide(pending({ created_at: daysAgo(8) }), ADMIN, OPTS).ok, true);
  assert.strictEqual(canRoleDecide(pending({ created_at: daysAgo(7) }), ADMIN, OPTS).ok, true, 'exactly at the boundary counts');
});

test('admin is FIRST decider on their own branch (Head Office) and on untagged rows', () => {
  assert.strictEqual(canRoleDecide(pending({ branch_id: 'bHQ' }), ADMIN, OPTS).ok, true);
  assert.strictEqual(canRoleDecide(pending({ branch_id: null }), ADMIN, OPTS).ok, true);
});

test('admin may OVERRIDE an already-decided row at any time (flagged as an override)', () => {
  const r = canRoleDecide(pending({ status: 'approved', created_at: daysAgo(1) }), ADMIN, OPTS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.override, true);
});

test('admin cannot decide a never-flagged saved row (409)', () => {
  const r = canRoleDecide(pending({ status: 'saved' }), ADMIN, OPTS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 409);
});

test('missing row -> 404 for every caller', () => {
  assert.strictEqual(canRoleDecide(null, ADMIN, OPTS).code, 404);
  assert.strictEqual(canRoleDecide(undefined, null, OPTS).code, 404);
});

test('buildReviewAudit records decided_by_role and override when given', () => {
  const a = buildReviewAudit({}, 'approve', 'ok', { role: 'clerk' });
  assert.strictEqual(a.review.decided_by_role, 'clerk');
  assert.ok(!('overrode' in a.review));
  const b = buildReviewAudit({}, 'reject', null, { role: 'admin', override: true });
  assert.strictEqual(b.review.decided_by_role, 'admin');
  assert.strictEqual(b.review.overrode, true);
});

test('buildReviewAudit with no role info stays shaped as before (personal mode)', () => {
  const a = buildReviewAudit({}, 'approve', 'fine');
  assert.deepStrictEqual(Object.keys(a.review).sort(), ['at', 'decision', 'note']);
});
