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
const { storedAutoMode, setAutoMode } = App;

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

// --- module surface ----------------------------------------------------------

test('App exposes storedAutoMode and setAutoMode', () => {
  assert.strictEqual(typeof App.storedAutoMode, 'function');
  assert.strictEqual(typeof App.setAutoMode, 'function');
});
