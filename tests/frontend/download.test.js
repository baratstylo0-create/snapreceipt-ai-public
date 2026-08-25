'use strict';
// download.js's detectOS() decides which install card (Windows/Mac/other) download.html
// shows a visitor. Pure, DOM-free — the browser-only DOM wiring in the same file never
// runs under node:test (guarded on `typeof document`).
const test = require('node:test');
const assert = require('node:assert');
const { detectOS } = require('../../public/js/download');

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_DESKTOP_MODE_UA = MAC_UA; // iPadOS Safari's "Request Desktop Website" sends a real Mac UA string
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

test('detectOS: a Windows UA is "windows"', () => {
  assert.strictEqual(detectOS(WIN_UA, 'Win32', 0), 'windows');
});

test('detectOS: a real Mac UA (no touch points) is "mac"', () => {
  assert.strictEqual(detectOS(MAC_UA, 'MacIntel', 0), 'mac');
});

test('detectOS: an iPhone UA is "other", never "mac", even though it contains no Windows string', () => {
  assert.strictEqual(detectOS(IPHONE_UA, 'iPhone', 5), 'other');
});

test('detectOS: an iPad in desktop mode (Mac-identical UA + multitouch) is "other", not "mac"', () => {
  // iPadOS Safari's desktop-request mode sends a byte-identical Mac UA string; the only
  // signal that distinguishes it from a real Mac is maxTouchPoints > 1 on MacIntel.
  assert.strictEqual(detectOS(IPAD_DESKTOP_MODE_UA, 'MacIntel', 5), 'other');
});

test('detectOS: Linux is "other"', () => {
  assert.strictEqual(detectOS(LINUX_UA, 'Linux x86_64', 0), 'other');
});

test('detectOS: missing/empty UA and platform default to "other", never throw', () => {
  assert.strictEqual(detectOS('', '', 0), 'other');
  assert.strictEqual(detectOS(undefined, undefined, undefined), 'other');
});

test('detectOS: Windows is checked before Mac (a UA claiming both never misfires as mac)', () => {
  assert.strictEqual(detectOS(WIN_UA + ' Macintosh', 'Win32', 0), 'windows');
});
