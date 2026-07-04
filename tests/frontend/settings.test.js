'use strict';
// settings.js pure logic (Phase 2): settingsModel distils /api/config into the
// small, safe shape the Settings view renders; currentTheme reads the active
// theme. Both must be junk-tolerant and never throw. No DOM, no network.
const test = require('node:test');
const assert = require('node:assert');

const Settings = require('../../public/js/components/settings');
const { settingsModel, currentTheme } = Settings;

// --- settingsModel -----------------------------------------------------------

test('settingsModel: reads currency + auth flag from config, signedIn from token', () => {
  const m = settingsModel({ default_currency: 'SGD', auth_required: true }, true);
  assert.deepStrictEqual(m, { currency: 'SGD', authRequired: true, signedIn: true });
});

test('settingsModel: falls back to MYR when currency missing/blank', () => {
  assert.strictEqual(settingsModel({}, false).currency, 'MYR');
  assert.strictEqual(settingsModel({ default_currency: '   ' }, false).currency, 'MYR');
});

test('settingsModel: trims the currency string', () => {
  assert.strictEqual(settingsModel({ default_currency: '  EUR ' }, false).currency, 'EUR');
});

test('settingsModel: tolerates a null/garbage config', () => {
  const m = settingsModel(null, false);
  assert.deepStrictEqual(m, { currency: 'MYR', authRequired: false, signedIn: false });
  const m2 = settingsModel('nope', true);
  assert.deepStrictEqual(m2, { currency: 'MYR', authRequired: false, signedIn: true });
});

test('settingsModel: coerces truthy/falsy token into a boolean signedIn', () => {
  assert.strictEqual(settingsModel({}, 'a-token').signedIn, true);
  assert.strictEqual(settingsModel({}, null).signedIn, false);
  assert.strictEqual(settingsModel({}, undefined).signedIn, false);
});

// --- currentTheme ------------------------------------------------------------

test('currentTheme: defaults to light with no document (Node)', () => {
  assert.strictEqual(currentTheme(), 'light');
});

// --- module surface ----------------------------------------------------------

test('mount: no-op (null) outside a browser', () => {
  assert.strictEqual(Settings.mount(null), null);
});
