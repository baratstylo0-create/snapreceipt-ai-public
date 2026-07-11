'use strict';
// PWA installability guard (2026-07-11): the web-app manifest + icon that let a client
// "Install" the dashboard as a standalone app (ADR-020 per-client delivery). No service
// worker by design — financial data is never cached offline (ADR-025). These tests keep
// the manifest valid, its icons present, and the <link rel="manifest"> wired, so a future
// edit can't silently break installability.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

test('manifest: valid JSON with the fields a browser needs to offer Install', () => {
  assert.ok(manifest.name && typeof manifest.name === 'string', 'name required');
  assert.ok(manifest.short_name && typeof manifest.short_name === 'string', 'short_name required');
  assert.strictEqual(manifest.start_url, '/');
  assert.strictEqual(manifest.scope, '/');
  assert.strictEqual(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.match(manifest.background_color, /^#[0-9a-fA-F]{6}$/);
});

test('manifest: at least one icon, each referencing a file that exists with a declared type', () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1, 'need >=1 icon');
  manifest.icons.forEach((ic) => {
    assert.ok(ic.type, 'icon must declare a type: ' + JSON.stringify(ic));
    assert.ok(!ic.src.startsWith('/') && !ic.src.startsWith('http'),
      'icon src should be manifest-relative (resolves under scope): ' + ic.src);
    assert.ok(fs.existsSync(path.join(PUBLIC, ic.src)), 'missing icon file on disk: ' + ic.src);
  });
});

test('manifest: at least one maskable icon (clean adaptive/rounded launcher icon)', () => {
  const hasMaskable = manifest.icons.some((ic) => /(^|\s)maskable(\s|$)/.test(ic.purpose || ''));
  assert.ok(hasMaskable, 'expected an icon with purpose containing "maskable"');
});

test('index.html wires the manifest, theme-color and an apple-touch-icon', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"\s+href="manifest\.webmanifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon"/);
});
