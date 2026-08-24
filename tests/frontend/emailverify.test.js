'use strict';
// emailverify.js — pure logic + no-DOM safety. DOM rendering (mount()'s confirm
// screen, buildBanner()'s cooldown timer/code form) is verified live in a browser
// per this repo's convention for DOM-heavy components (same approach used for
// tour.js) rather than a Node/jsdom harness — this file covers everything that
// genuinely doesn't need a real DOM.
const test = require('node:test');
const assert = require('node:assert');

const EmailVerify = require('../../public/js/components/emailverify');

// --- validateCode ---------------------------------------------------------------

test('validateCode: a plain 6-digit string is ok', () => {
  assert.deepStrictEqual(EmailVerify.validateCode('123456'), { ok: true, code: '123456' });
});

test('validateCode: trims surrounding whitespace', () => {
  assert.deepStrictEqual(EmailVerify.validateCode('  123456  '), { ok: true, code: '123456' });
});

test('validateCode: empty/whitespace-only -> not ok', () => {
  assert.strictEqual(EmailVerify.validateCode('').ok, false);
  assert.strictEqual(EmailVerify.validateCode('   ').ok, false);
});

test('validateCode: null/undefined -> not ok, never throws', () => {
  assert.strictEqual(EmailVerify.validateCode(null).ok, false);
  assert.strictEqual(EmailVerify.validateCode(undefined).ok, false);
});

test('validateCode: non-digit characters -> not ok (letters, symbols, mixed)', () => {
  assert.strictEqual(EmailVerify.validateCode('12a456').ok, false);
  assert.strictEqual(EmailVerify.validateCode('abcdef').ok, false);
  assert.strictEqual(EmailVerify.validateCode('123-456').ok, false);
});

test('validateCode: never rejects purely on length (server owns the real length gate)', () => {
  // A shorter/longer-than-6 all-digit string still passes this pre-check — only the
  // server's own attempt budget (contract §2/§5) may legitimately reject it.
  assert.strictEqual(EmailVerify.validateCode('1').ok, true);
  assert.strictEqual(EmailVerify.validateCode('1234567890').ok, true);
});

// --- DOM-safety (no `document` global in this Node test process) ----------------

test('mount: no-ops without a DOM, never throws', () => {
  assert.doesNotThrow(() => EmailVerify.mount(null, { token: 'x', Api: {} }));
  assert.doesNotThrow(() => EmailVerify.mount(undefined, {}));
});

test('mount: no-ops with a falsy container even if document existed, never throws', () => {
  assert.doesNotThrow(() => EmailVerify.mount(null, { token: 'x', Api: { apiFetch: () => Promise.resolve({}) } }));
});
