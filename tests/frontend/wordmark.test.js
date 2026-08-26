const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

test('shared SnapReceipt wordmark assets preserve the supplied three-part brand', () => {
  const light = fs.readFileSync(path.join(root, 'public', 'icons', 'snapreceipt-wordmark.svg'), 'utf8');
  const dark = fs.readFileSync(path.join(root, 'public', 'icons', 'snapreceipt-wordmark-dark.svg'), 'utf8');

  for (const svg of [light, dark]) {
    assert.ok(svg.includes('Snap'));
    assert.ok(svg.includes('Receipt'));
    assert.ok(svg.includes('AI'));
    assert.ok(svg.includes('#2563eb'));
  }
  assert.ok(light.includes('fill="#101826"'));
  assert.ok(dark.includes('fill="#ffffff">Snap</text>'));
});

// 2026-08-25 FIX: this test used to assert the OPPOSITE (that landing.js uses
// wordmark-dark.svg) — that was the bug itself. landing.js's nav is LIGHT
// (--lp-paper, see landing.css), and wordmark-dark.svg renders "Snap" in WHITE
// (meant for a dark navy nav) — white-on-white made it invisible (Barat, live:
// "why the snap become white"). The light nav needs the NAVY-text variant,
// i.e. the plain (non "-dark") file. See project-snapreceipt-official-wordmark-logo
// memory for the exact, permanent-reference SVG geometry/colors.
test('landing uses the light-background (navy-text) wordmark asset, not the dark-background one', () => {
  const landing = fs.readFileSync(path.join(root, 'public', 'js', 'components', 'landing.js'), 'utf8');
  assert.ok(landing.includes('icons/snapreceipt-wordmark.svg'));
  assert.ok(!landing.includes('icons/snapreceipt-wordmark-dark.svg'));
});
