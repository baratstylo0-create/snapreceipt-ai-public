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

test('landing uses the shared dark wordmark asset', () => {
  const landing = fs.readFileSync(path.join(root, 'public', 'js', 'components', 'landing.js'), 'utf8');
  assert.ok(landing.includes("icons/snapreceipt-wordmark-dark.svg"));
});
