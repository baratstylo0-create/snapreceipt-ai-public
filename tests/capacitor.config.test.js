'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isAllowedServerUrl,
  isProductionServerUrl,
  requireProductionServerUrl,
} = require('../scripts/mobile-config');

const repoRoot = path.resolve(__dirname, '..');

test('accepts HTTPS production URLs', () => {
  assert.equal(isAllowedServerUrl('https://receipts.example.com'), true);
  assert.equal(isProductionServerUrl('https://receipts.example.com'), true);
});

test('accepts emulator localhost URLs only for development', () => {
  for (const url of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://10.0.2.2:3001']) {
    assert.equal(isAllowedServerUrl(url), true, url);
    assert.equal(isProductionServerUrl(url), false, url);
  }
});

test('rejects non-local HTTP URLs', () => {
  assert.equal(isAllowedServerUrl('http://receipts.example.com'), false);
  assert.equal(isAllowedServerUrl('https://'), false);
});

test('requires a production URL for release configuration', () => {
  assert.throws(() => requireProductionServerUrl(''), /CAPACITOR_SERVER_URL/);
  assert.throws(() => requireProductionServerUrl('http://10.0.2.2:3001'), /HTTPS/);
  assert.equal(requireProductionServerUrl('https://receipts.example.com'), 'https://receipts.example.com');
});

test('declares the immutable Android identity and web source', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'capacitor.config.ts'), 'utf8');
  assert.match(config, /appId:\s*['"]com\.snapreceiptai\.app['"]/);
  assert.match(config, /appName:\s*['"]SnapReceipt AI['"]/);
  assert.match(config, /webDir:\s*['"]public['"]/);
});

test('release Gradle task requires production URL and upload signing variables', () => {
  const gradle = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'build.gradle'), 'utf8');
  for (const name of [
    'CAPACITOR_SERVER_URL',
    'ANDROID_KEYSTORE_PATH',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'bundleRelease',
    'capacitor.config.json',
    'server?.url',
  ]) {
    assert.match(gradle, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
  }
});
