'use strict';
// ADR-019 — pending-proposal store is the security boundary of the agentic
// write-actions feature: it decides which action kinds may auto-execute vs
// must always be confirmed, and it holds proposals single-use with a TTL.
const test = require('node:test');
const assert = require('node:assert');
const {
  KINDS,
  canAutoConfirm,
  createProposal,
  consumeProposal,
  peekProposal,
  _reset,
  _size,
} = require('../lib/agentProposals');

test.beforeEach(() => {
  _reset();
});

test('KINDS exposes exactly the 4 proposal kinds', () => {
  assert.deepStrictEqual(
    Object.values(KINDS).sort(),
    ['add-template-field', 'delete', 'edit', 'review-decision'].sort()
  );
});

test('canAutoConfirm: true for edit/review-decision', () => {
  assert.strictEqual(canAutoConfirm('edit'), true);
  assert.strictEqual(canAutoConfirm('review-decision'), true);
});

test('canAutoConfirm: false for delete/add-template-field — always require explicit confirm', () => {
  assert.strictEqual(canAutoConfirm('delete'), false);
  assert.strictEqual(canAutoConfirm('add-template-field'), false);
});

test('canAutoConfirm: false for unknown/garbage kinds', () => {
  for (const bad of ['admin', '', undefined, null, 'EDIT', 42, {}]) {
    assert.strictEqual(canAutoConfirm(bad), false, 'kind=' + JSON.stringify(bad) + ' must not be auto-confirmable');
  }
});

test('createProposal: returns an id shaped p_<uuid> and stores kind/args/summary/diff', () => {
  const p = createProposal({
    kind: 'edit',
    args: { id: 'exp_1', patch: { merchant: 'Shell' } },
    summary: 'Change merchant to Shell',
    diff: [{ field: 'merchant', from: 'Esso', to: 'Shell' }],
  });
  assert.strictEqual(p.error, undefined);
  assert.match(p.id, /^p_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.strictEqual(p.kind, 'edit');
  assert.deepStrictEqual(p.args, { id: 'exp_1', patch: { merchant: 'Shell' } });
  assert.strictEqual(p.summary, 'Change merchant to Shell');
  assert.deepStrictEqual(p.diff, [{ field: 'merchant', from: 'Esso', to: 'Shell' }]);
  assert.strictEqual(typeof p.expiresAt, 'number');
});

test('createProposal: unknown kind returns {error}, does not throw, and stores nothing', () => {
  const before = _size();
  const r = createProposal({ kind: 'admin-nuke', args: {}, summary: 'x', diff: {} });
  assert.deepStrictEqual(r, { error: 'unknown proposal kind' });
  assert.strictEqual(_size(), before);
});

test('createProposal: distinct ids across multiple calls', () => {
  const a = createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} });
  const b = createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} });
  assert.notStrictEqual(a.id, b.id);
});

test('createProposal: covers all 4 kinds successfully', () => {
  for (const kind of Object.values(KINDS)) {
    const p = createProposal({ kind, args: { a: 1 }, summary: 'sum', diff: { d: 1 } });
    assert.strictEqual(p.error, undefined, 'kind=' + kind + ' should be accepted');
    assert.strictEqual(p.kind, kind);
  }
});

test('consumeProposal: returns the proposal once, then null on a second consume (single-use)', () => {
  const created = createProposal({ kind: 'delete', args: { id: 'exp_9' }, summary: 'Delete exp_9', diff: null });
  const first = consumeProposal(created.id);
  assert.deepStrictEqual(first, created);
  const second = consumeProposal(created.id);
  assert.strictEqual(second, null);
});

test('consumeProposal: null for an unknown id', () => {
  assert.strictEqual(consumeProposal('p_does-not-exist'), null);
});

test('consumeProposal: null for garbage ids (null/number/object/array/undefined) without throwing', () => {
  for (const bad of [null, undefined, 42, {}, [], true, NaN]) {
    assert.doesNotThrow(() => consumeProposal(bad));
    assert.strictEqual(consumeProposal(bad), null, 'id=' + JSON.stringify(bad) + ' must yield null');
  }
});

test('consumeProposal: removes the proposal from the store on successful consume', () => {
  const created = createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} });
  assert.strictEqual(_size(), 1);
  consumeProposal(created.id);
  assert.strictEqual(_size(), 0);
});

test('expiry: consuming before expiresAt returns the proposal; after, returns null (injected clock)', () => {
  let t = 1_000_000;
  const clock = () => t;
  const created = createProposal(
    { kind: 'review-decision', args: { id: 'exp_5', decision: 'approve' }, summary: 'Approve exp_5', diff: {} },
    { now: clock, ttlMs: 1000 }
  );
  assert.strictEqual(created.expiresAt, 1_000_000 + 1000);

  // Still valid just before expiry.
  t = 1_000_000 + 999;
  const stillValid = consumeProposal(created.id, { now: clock });
  assert.deepStrictEqual(stillValid, created);
});

test('expiry: consuming strictly at/after expiresAt returns null and evicts the entry', () => {
  let t = 0;
  const clock = () => t;
  const created = createProposal(
    { kind: 'add-template-field', args: { field: 'x' }, summary: 'Add field x', diff: {} },
    { now: clock, ttlMs: 500 }
  );
  t = 500; // exactly at expiresAt -> expired
  assert.strictEqual(consumeProposal(created.id, { now: clock }), null);
  // Confirm it was evicted, not just reported expired.
  t = -1000; // even rewinding the clock can't resurrect an evicted entry
  assert.strictEqual(consumeProposal(created.id, { now: clock }), null);
});

test('default TTL is ~10 minutes when opts.ttlMs is not supplied', () => {
  const realNow = Date.now();
  const created = createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} });
  const delta = created.expiresAt - realNow;
  assert.ok(delta > 9 * 60 * 1000 && delta <= 10 * 60 * 1000 + 1000, 'expected ~10 minute TTL, got ' + delta + 'ms');
});

test('peekProposal: returns the proposal without removing it (repeatable read)', () => {
  const created = createProposal({ kind: 'edit', args: { id: 'exp_2' }, summary: 's', diff: {} });
  const peek1 = peekProposal(created.id);
  const peek2 = peekProposal(created.id);
  assert.deepStrictEqual(peek1, created);
  assert.deepStrictEqual(peek2, created);
  // Still consumable afterwards since peek never removed it.
  const consumed = consumeProposal(created.id);
  assert.deepStrictEqual(consumed, created);
});

test('peekProposal: null for unknown/garbage ids without throwing', () => {
  assert.strictEqual(peekProposal('p_nope'), null);
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => peekProposal(bad));
    assert.strictEqual(peekProposal(bad), null);
  }
});

test('peekProposal: expired entries return null and are evicted (injected clock)', () => {
  let t = 0;
  const clock = () => t;
  const created = createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} }, { now: clock, ttlMs: 100 });
  t = 200;
  assert.strictEqual(peekProposal(created.id, { now: clock }), null);
  assert.strictEqual(_size(), 0);
});

test('_reset isolates state between tests', () => {
  createProposal({ kind: 'edit', args: {}, summary: 's', diff: {} });
  createProposal({ kind: 'delete', args: {}, summary: 's', diff: {} });
  assert.strictEqual(_size(), 2);
  _reset();
  assert.strictEqual(_size(), 0);
});
