'use strict';
// nav.js — the single source of truth for the app's sections. Phase 2 (Mugi's
// Treehouse concept) drops the Agent tab (it moved into the floating Falc
// assistant) and adds a Settings view. These tests pin that section list and
// confirm the DOM builders no-op safely in Node (no document).
const test = require('node:test');
const assert = require('node:assert');

const Nav = require('../../public/js/components/nav');

test('SECTIONS: ids are the expected Phase-2 set, in order', () => {
  const ids = Nav.SECTIONS.map((s) => s.id);
  // QA PR-F: Reports folded into Overview (Summary | Trends segment), so 'reports' is no longer a tab.
  assert.deepStrictEqual(ids, ['overview', 'activity', 'upload', 'manage', 'settings']);
});

test('SECTIONS: Agent is no longer a nav tab (it lives in Falc)', () => {
  const ids = Nav.SECTIONS.map((s) => s.id);
  assert.ok(!ids.includes('agent'), 'agent must not be a nav section');
});

test('SECTIONS: Settings is a nav tab', () => {
  const ids = Nav.SECTIONS.map((s) => s.id);
  assert.ok(ids.includes('settings'), 'settings must be a nav section');
});

test('SECTIONS: every section has a non-empty label and a unique id', () => {
  const seen = new Set();
  Nav.SECTIONS.forEach((s) => {
    assert.strictEqual(typeof s.label, 'string');
    assert.ok(s.label.length > 0);
    assert.ok(!seen.has(s.id), 'duplicate id: ' + s.id);
    seen.add(s.id);
  });
});

test('buildNav / buildEmblem / buildBrandHeader: no-op (null) outside a browser', () => {
  assert.strictEqual(Nav.buildNav(), null);
  assert.strictEqual(Nav.buildEmblem(), null);
  assert.strictEqual(Nav.buildBrandHeader(), null);
});
