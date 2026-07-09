'use strict';
// components/nav.js Phase 6 (ADR-021): sectionsFor picks the nav for the mode. Personal ->
// exactly the classic sections (byte-identical to SECTIONS). Business -> + Team + Payments, both
// roles (clerk gets read-only/own-branch behaviour inside the views; the server enforces
// regardless). Pure, node-testable, no DOM.
// NB (2026-07-09): the excel-lite grid is NO LONGER a top-level "Ledger" section — it moved
// into the Manage sub-page (components/manage.js). So the nav no longer includes 'ledger' and
// the excelLiteGrid flag no longer affects sectionsFor (see manage.test.js for the sub-page
// gating).
const test = require('node:test');
const assert = require('node:assert');
const { sectionsFor, SECTIONS } = require('../../public/js/components/nav');

test('personal mode -> exactly the classic sections (same reference semantics)', () => {
  assert.deepStrictEqual(sectionsFor({ business: false }), SECTIONS);
  assert.deepStrictEqual(sectionsFor(), SECTIONS);
  assert.deepStrictEqual(sectionsFor({}), SECTIONS);
});

test('business mode -> Team + Payments appear, classic sections all kept, Settings stays last', () => {
  const ids = sectionsFor({ business: true, role: 'admin' }).map((s) => s.id);
  assert.ok(ids.includes('team'));
  assert.ok(ids.includes('payments'));
  for (const s of SECTIONS) assert.ok(ids.includes(s.id), s.id + ' kept');
  assert.strictEqual(ids[ids.length - 1], 'settings');
});

test('no standalone "ledger" section any more (it lives under Manage now)', () => {
  assert.ok(!sectionsFor({ business: true, role: 'admin' }).map((s) => s.id).includes('ledger'));
});

test('no standalone "reports" section any more (Reports lives under Overview -> Trends)', () => {
  const personal = sectionsFor({ business: false }).map((s) => s.id);
  const business = sectionsFor({ business: true, role: 'admin' }).map((s) => s.id);
  assert.ok(!personal.includes('reports'));
  assert.ok(!business.includes('reports'));
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

// The excelLiteGrid flag is now inert at the nav layer (kept accepted for caller back-compat).
test('excelLiteGrid flag no longer changes the nav (grid moved under Manage)', () => {
  const off = sectionsFor({ business: true, excelLiteGrid: false }).map((s) => s.id);
  const on = sectionsFor({ business: true, excelLiteGrid: true }).map((s) => s.id);
  assert.deepStrictEqual(off, on);
  assert.ok(off.includes('team') && off.includes('payments'));
});

test('excelLiteGrid flag is irrelevant in personal mode (classic sections regardless)', () => {
  assert.deepStrictEqual(sectionsFor({ business: false, excelLiteGrid: false }), SECTIONS);
});
