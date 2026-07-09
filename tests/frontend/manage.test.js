'use strict';
// components/manage.js (2026-07-09): the Manage shell hosts sub-pages behind a dropdown —
// the template/category editor (always) plus the excel-lite Data editor (unless the account's
// excelLiteGrid capability is off, surfaced as config.excel_lite_grid). subPagesFor is the pure
// routing helper; node-testable, no DOM.
const test = require('node:test');
const assert = require('node:assert');
const { subPagesFor } = require('../../public/js/components/manage');

test('personal mode -> template only (the Data editor is business-only)', () => {
  assert.deepStrictEqual(subPagesFor({}, false).map((p) => p.id), ['template']);
  assert.deepStrictEqual(subPagesFor({ excel_lite_grid: true }, false).map((p) => p.id), ['template']);
  assert.deepStrictEqual(subPagesFor().map((p) => p.id), ['template']); // no config, no business
});

test('business + excel_lite_grid omitted/true -> both sub-pages, template first', () => {
  assert.deepStrictEqual(subPagesFor({}, true).map((p) => p.id), ['template', 'data']);
  assert.deepStrictEqual(subPagesFor({ excel_lite_grid: true }, true).map((p) => p.id), ['template', 'data']);
});

test('business + excel_lite_grid:false (Premala-style off) -> data editor dropped, template kept', () => {
  assert.deepStrictEqual(subPagesFor({ excel_lite_grid: false }, true).map((p) => p.id), ['template']);
});

test('every sub-page has an id and a human label', () => {
  for (const p of subPagesFor({}, true)) {
    assert.strictEqual(typeof p.id, 'string');
    assert.ok(p.label && typeof p.label === 'string');
  }
});

test('subPagesFor never throws on garbage config', () => {
  assert.doesNotThrow(() => subPagesFor(null, true));
  assert.doesNotThrow(() => subPagesFor('garbage', true));
  assert.doesNotThrow(() => subPagesFor(42, true));
  // Only the exact `excel_lite_grid === false` turns the data editor off; anything else keeps it (in business mode).
  assert.deepStrictEqual(subPagesFor('garbage', true).map((p) => p.id), ['template', 'data']);
  assert.deepStrictEqual(subPagesFor({ excel_lite_grid: 0 }, true).map((p) => p.id), ['template', 'data']);
});
