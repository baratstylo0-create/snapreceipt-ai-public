'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

test('privacy policy is a public static Play Console URL', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'privacy.html'), 'utf8');

  assert.match(html, /<title>SnapReceipt AI Privacy Policy<\/title>/);
  assert.match(html, /Last updated: August 13, 2026/);
  assert.match(html, /https:\/\/snapreceiptai\.friction\.com\.my\/privacy\.html/);
  assert.match(html, /jeevank1811@gmail\.com/);
});

test('privacy policy discloses SnapReceipt data categories and processors', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'privacy.html'), 'utf8');

  for (const required of [
    'receipt images',
    'expense records',
    'Telegram',
    'Groq',
    'Supabase',
    'account deletion',
    'data export',
    'Google Play',
    'not intended for children',
  ]) {
    assert.match(html, new RegExp(required, 'i'), required);
  }
});

test('main app exposes the privacy policy link for in-app access', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

  assert.match(html, /href="privacy\.html"/);
  assert.match(html, />Privacy Policy<\/a>/);
});
