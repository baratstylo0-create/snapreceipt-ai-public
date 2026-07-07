'use strict';
// components/nav.js Phase 6 (ADR-021): sectionsFor picks the nav for the mode. Personal ->
// exactly the classic six (byte-identical to SECTIONS). Business -> + Payments and Ledger
// (the excel-lite grid), both roles (clerk gets read-only/own-branch behaviour inside the
// views; the server enforces regardless). Pure, node-testable, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const { sectionsFor, SECTIONS } = require('../../public/js/components/nav');

test('personal mode -> exactly the classic sections (same reference semantics)', () => {
  assert.deepStrictEqual(sectionsFor({ business: false }), SECTIONS);
  assert.deepStrictEqual(sectionsFor(), SECTIONS);
  assert.deepStrictEqual(sectionsFor({}), SECTIONS);
});

test('business mode -> Payments + Ledger appear, classic sections all kept, Settings stays last', () => {
  const ids = sectionsFor({ business: true, role: 'admin' }).map((s) => s.id);
  assert.ok(ids.includes('payments'));
  assert.ok(ids.includes('ledger'));
  for (const s of SECTIONS) assert.ok(ids.includes(s.id), s.id + ' kept');
  assert.strictEqual(ids[ids.length - 1], 'settings');
});

test('business clerk gets the same sections (views themselves render role-aware)', () => {
  const admin = sectionsFor({ business: true, role: 'admin' }).map((s) => s.id);
  const clerk = sectionsFor({ business: true, role: 'clerk' }).map((s) => s.id);
  assert.deepStrictEqual(clerk, admin);
});

test('every returned section has an id and a label', () => {
  for (const s of sectionsFor({ business: true, role: 'admin' })) {
    assert.strictEqual(typeof s.id, 'string');
    assert.ok(s.label && typeof s.label === 'string');
  }
});
