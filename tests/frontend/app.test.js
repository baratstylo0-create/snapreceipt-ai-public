'use strict';
// app.js pure logic: storedAutoMode/setAutoMode persist the Agent auto-mode
// flag (ADR-019) to sessionStorage using the exact same ss()-guarded,
// try/catch-safe pattern as storedTheme/setTheme. No DOM, no network, never
// throw on junk or a missing/broken sessionStorage.
//
// app.js resolves its `root` (used for root.sessionStorage) from
// `typeof self !== 'undefined' ? self : this` at UMD-wrapper time. Node has no
// `self` global, so we define one (a plain object) BEFORE requiring the
// module, then attach/detach a fake `sessionStorage` on it per test — this
// mirrors how a real browser's `self.sessionStorage` works, without needing to
// touch app.js's production code path at all.
const test = require('node:test');
const assert = require('node:assert');

if (typeof global.self === 'undefined') global.self = {};

const App = require('../../public/js/app');
const { storedAutoMode, setAutoMode, toggleTheme, setTheme, storedDefaultView, setDefaultView } = App;

function fakeStorage() {
  var store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// --- storedAutoMode -----------------------------------------------------------

test('storedAutoMode: defaults to false with no sessionStorage', () => {
  delete global.self.sessionStorage;
  assert.strictEqual(storedAutoMode(), false);
});

test('storedAutoMode: missing key -> false', () => {
  global.self.sessionStorage = fakeStorage();
  try {
    assert.strictEqual(storedAutoMode(), false);
  } finally { delete global.self.sessionStorage; }
});

test('storedAutoMode: stored "true"/"false" strings -> correct booleans', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    s.setItem('auto_mode', 'true');
    assert.strictEqual(storedAutoMode(), true);
    s.setItem('auto_mode', 'false');
    assert.strictEqual(storedAutoMode(), false);
  } finally { delete global.self.sessionStorage; }
});

test('storedAutoMode: garbage stored value -> safe false, never throws', () => {
  global.self.sessionStorage = { getItem: () => 'garbage-not-a-boolean' };
  try {
    assert.strictEqual(storedAutoMode(), false);
  } finally { delete global.self.sessionStorage; }
});

test('storedAutoMode: tolerates a throwing sessionStorage.getItem, never throws', () => {
  global.self.sessionStorage = { getItem: () => { throw new Error('boom'); } };
  try {
    assert.strictEqual(storedAutoMode(), false);
  } finally { delete global.self.sessionStorage; }
});

// --- setAutoMode ---------------------------------------------------------------

test('setAutoMode: coerces truthy/falsy input to a strict boolean before persisting', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    assert.strictEqual(setAutoMode(true), true);
    assert.strictEqual(s._store.auto_mode, 'true');
    assert.strictEqual(setAutoMode(false), false);
    assert.strictEqual(s._store.auto_mode, 'false');
    assert.strictEqual(setAutoMode('yes'), true); // truthy string coerces true
    assert.strictEqual(s._store.auto_mode, 'true');
    assert.strictEqual(setAutoMode(0), false); // falsy number coerces false
    assert.strictEqual(s._store.auto_mode, 'false');
    assert.strictEqual(setAutoMode(undefined), false);
  } finally { delete global.self.sessionStorage; }
});

test('setAutoMode: a sessionStorage write failure never throws, still returns the coerced boolean', () => {
  global.self.sessionStorage = { setItem: () => { throw new Error('quota exceeded'); } };
  try {
    assert.strictEqual(setAutoMode(true), true);
    assert.strictEqual(setAutoMode(false), false);
  } finally { delete global.self.sessionStorage; }
});

test('setAutoMode: works with no sessionStorage at all (Node/SSR), never throws', () => {
  delete global.self.sessionStorage;
  assert.strictEqual(setAutoMode(true), true);
  assert.strictEqual(setAutoMode(false), false);
});

// --- setTheme (3-way: light/warm/dark, owner request 2026-07-07) -------------

test('setTheme: persists a valid value and returns it unchanged', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    assert.strictEqual(setTheme('warm'), 'warm');
    assert.strictEqual(s._store.theme, 'warm');
    assert.strictEqual(setTheme('dark'), 'dark');
    assert.strictEqual(s._store.theme, 'dark');
    assert.strictEqual(setTheme('light'), 'light');
    assert.strictEqual(s._store.theme, 'light');
  } finally { delete global.self.sessionStorage; }
});

test('setTheme: an invalid/garbage value normalizes to "light", never throws', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    assert.strictEqual(setTheme('sepia'), 'light');
    assert.strictEqual(s._store.theme, 'light');
    assert.strictEqual(setTheme(undefined), 'light');
    assert.strictEqual(setTheme(null), 'light');
  } finally { delete global.self.sessionStorage; }
});

test('setTheme: a sessionStorage write failure never throws, still returns the normalized value', () => {
  global.self.sessionStorage = { setItem: () => { throw new Error('quota exceeded'); } };
  try {
    assert.strictEqual(setTheme('warm'), 'warm');
  } finally { delete global.self.sessionStorage; }
});

// --- toggleTheme (cycles Light -> Warm -> Dark -> Light) --------------------

test('toggleTheme: cycles light -> warm -> dark -> light', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    s.setItem('theme', 'light');
    assert.strictEqual(toggleTheme(), 'warm');
    assert.strictEqual(toggleTheme(), 'dark');
    assert.strictEqual(toggleTheme(), 'light');
  } finally { delete global.self.sessionStorage; }
});

test('toggleTheme: with no stored value yet (fresh session), the first click advances to "warm"', () => {
  // No stored theme == the visual baseline is 'light' (applyTheme's default),
  // so the first toggle must move forward to 'warm', not silently no-op back
  // to 'light'.
  delete global.self.sessionStorage;
  global.self.sessionStorage = fakeStorage();
  try {
    assert.strictEqual(toggleTheme(), 'warm');
  } finally { delete global.self.sessionStorage; }
});

test('toggleTheme: an unrecognised stored value is treated like "light" before advancing', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    s.setItem('theme', 'garbage');
    assert.strictEqual(toggleTheme(), 'warm');
  } finally { delete global.self.sessionStorage; }
});

// --- storedDefaultView / setDefaultView (Settings' "Default page" picker) ---
// Same ss()-guarded, try/catch-safe sessionStorage pattern as theme/auto-mode.
// The picker's OPTIONS are validated against the current section list in
// app.js's enterApp() (business vs personal) — these two helpers are pure
// storage plumbing and never validate the id themselves, mirroring
// storedTheme/setTheme's own division of labor (setTheme normalizes against
// THEME_CYCLE; storedTheme does not).

test('storedDefaultView: defaults to null with no sessionStorage', () => {
  delete global.self.sessionStorage;
  assert.strictEqual(storedDefaultView(), null);
});

test('storedDefaultView: missing key -> null', () => {
  global.self.sessionStorage = fakeStorage();
  try {
    assert.strictEqual(storedDefaultView(), null);
  } finally { delete global.self.sessionStorage; }
});

test('setDefaultView: persists the given id, storedDefaultView reads it back', () => {
  const s = fakeStorage();
  global.self.sessionStorage = s;
  try {
    setDefaultView('team');
    assert.strictEqual(storedDefaultView(), 'team');
  } finally { delete global.self.sessionStorage; }
});

test('setDefaultView: a sessionStorage write failure never throws', () => {
  global.self.sessionStorage = {
    getItem: () => { throw new Error('broken'); },
    setItem: () => { throw new Error('broken'); },
  };
  try {
    assert.doesNotThrow(() => setDefaultView('overview'));
    assert.doesNotThrow(() => storedDefaultView());
  } finally { delete global.self.sessionStorage; }
});

// --- module surface ----------------------------------------------------------

test('App exposes storedAutoMode and setAutoMode', () => {
  assert.strictEqual(typeof App.storedAutoMode, 'function');
  assert.strictEqual(typeof App.setAutoMode, 'function');
});

test('App exposes toggleTheme, applyTheme, and setTheme', () => {
  assert.strictEqual(typeof App.toggleTheme, 'function');
  assert.strictEqual(typeof App.applyTheme, 'function');
  assert.strictEqual(typeof App.setTheme, 'function');
});

test('App exposes storedDefaultView and setDefaultView', () => {
  assert.strictEqual(typeof App.storedDefaultView, 'function');
  assert.strictEqual(typeof App.setDefaultView, 'function');
});
