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
  assert.match(html, /https:\/\/snapreceiptai\.friction\.com\.my\/privacypolicy/);
  assert.doesNotMatch(html, /snapreceiptai\.friction\.com\.my\/privacy\.html/);
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

  assert.match(html, /href="\/privacypolicy"/);
  assert.match(html, />Privacy Policy<\/a>/);
});

test('server exposes clean privacy policy URL for Play Console', async () => {
  const express = require('express');
  const mountMisc = require('../routes/misc');
  const app = express();
  mountMisc(app);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/privacypolicy`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(await res.text(), /SnapReceipt AI Privacy Policy/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('account deletion page is public and gives web-accessible deletion instructions', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'accountdeletion.html'), 'utf8');

  assert.match(html, /<title>SnapReceipt AI Account Deletion<\/title>/);
  assert.match(html, /https:\/\/snapreceiptai\.friction\.com\.my\/accountdeletion/);
  assert.match(html, /Settings/);
  assert.match(html, /Delete account/);
  assert.match(html, /jeevank1811@gmail\.com/);
  assert.match(html, /delete specific receipts/i);
});

test('server exposes clean account deletion URL for Google Play', async () => {
  const express = require('express');
  const mountMisc = require('../routes/misc');
  const app = express();
  mountMisc(app);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/accountdeletion`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(await res.text(), /SnapReceipt AI Account Deletion/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
