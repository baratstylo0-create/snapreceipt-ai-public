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

// telegramLink (2026-07-14): the nav bar's "open the bot" icon. Same URL for
// every role (one bot per client account) — never a per-user bind_token (that
// stays a one-time secret shown only via Team's credential panel).
test('telegramLink: builds https://t.me/<handle> for a configured bot username', () => {
  assert.strictEqual(Nav.telegramLink('my_receipts_bot'), 'https://t.me/my_receipts_bot');
});

test('telegramLink: trims whitespace', () => {
  assert.strictEqual(Nav.telegramLink('  my_bot  '), 'https://t.me/my_bot');
});

test('telegramLink: percent-encodes a hostile handle (no raw markup, no bare slash)', () => {
  const hostile = '../evil?x=<script>';
  const out = Nav.telegramLink(hostile);
  assert.strictEqual(out.indexOf('https://t.me/'), 0);
  assert.ok(out.indexOf('<script>') === -1, 'must not carry raw markup');
  assert.strictEqual(out, 'https://t.me/' + encodeURIComponent(hostile));
});

test('telegramLink: empty/null/undefined -> null (omit the icon, never link to a dead handle)', () => {
  assert.strictEqual(Nav.telegramLink(''), null);
  assert.strictEqual(Nav.telegramLink('   '), null);
  assert.strictEqual(Nav.telegramLink(null), null);
  assert.strictEqual(Nav.telegramLink(undefined), null);
});
