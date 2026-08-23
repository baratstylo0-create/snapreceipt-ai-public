'use strict';
// legal.js pure logic: paragraphPlainText flattens the mixed string/{mailto}/{href}
// parts a paragraph is built from into plain text (used by the DOM renderer to know
// what to insert — real <a> elements for mailto/href parts, text nodes otherwise).
// Also sanity-checks the static content arrays never end up empty/malformed, since a
// typo in components/legal.js's data literal (e.g. a missing comma) is easy to miss
// by eye in a ~250-line data block. No DOM (mount-equivalent rendering is browser-only).
const test = require('node:test');
const assert = require('node:assert');

const Legal = require('../../public/js/components/legal');
const { paragraphPlainText, PRIVACY_SECTIONS, DELETION_SECTIONS } = Legal;

// --- paragraphPlainText -------------------------------------------------------

test('paragraphPlainText: a plain string passes through unchanged', () => {
  assert.strictEqual(paragraphPlainText('Hello world.'), 'Hello world.');
});

test('paragraphPlainText: joins string parts with mailto parts', () => {
  const out = paragraphPlainText(['Contact us at ', { mailto: 'a@b.com' }, '.']);
  assert.strictEqual(out, 'Contact us at a@b.com.');
});

test('paragraphPlainText: joins string parts with href parts, preferring the label', () => {
  const out = paragraphPlainText(['Visit ', { href: 'https://x.com', text: 'our site' }, '.']);
  assert.strictEqual(out, 'Visit our site.');
});

test('paragraphPlainText: an href part with no label falls back to the URL itself', () => {
  const out = paragraphPlainText([{ href: 'https://x.com' }]);
  assert.strictEqual(out, 'https://x.com');
});

test('paragraphPlainText: garbage/empty input never throws', () => {
  assert.strictEqual(paragraphPlainText(null), '');
  assert.strictEqual(paragraphPlainText(undefined), '');
  assert.strictEqual(paragraphPlainText([]), '');
  assert.strictEqual(paragraphPlainText([null, undefined, {}]), '');
});

// --- content sanity (catches a malformed data literal, not the legal wording itself) --

test('PRIVACY_SECTIONS: 19 numbered sections, each with a heading and at least one block', () => {
  assert.strictEqual(PRIVACY_SECTIONS.length, 19);
  PRIVACY_SECTIONS.forEach((s) => {
    assert.strictEqual(typeof s.h2, 'string');
    assert.ok(s.h2.length > 0);
    assert.ok(Array.isArray(s.blocks) && s.blocks.length > 0);
  });
});

test('DELETION_SECTIONS: 4 sections, each with a heading and at least one block', () => {
  assert.strictEqual(DELETION_SECTIONS.length, 4);
  DELETION_SECTIONS.forEach((s) => {
    assert.strictEqual(typeof s.h2, 'string');
    assert.ok(s.h2.length > 0);
    assert.ok(Array.isArray(s.blocks) && s.blocks.length > 0);
  });
});

test('PRIVACY_SECTIONS: the contact email appears via a real mailto part, not raw text', () => {
  const contactSection = PRIVACY_SECTIONS.find((s) => s.h2 === '1. Who We Are');
  const blockWithMailto = contactSection.blocks.find(
    (b) => Array.isArray(b.p) && b.p.some((part) => part && part.mailto)
  );
  assert.ok(blockWithMailto, 'expected a block whose paragraph contains a {mailto} part');
  const mailtoPart = blockWithMailto.p.find((part) => part && part.mailto);
  assert.strictEqual(mailtoPart.mailto, 'jeevank1811@gmail.com');
});
