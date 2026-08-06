'use strict';
// Route tests for /api/settings/category-colors (owner request 2026-07-05:
// custom donut colours synced server-side). Stubs the shared lib/supabase.js
// helpers (same pattern as reports.route.test.js) so nothing hits a real DB.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const supabase = require('../lib/supabase');
const mountSettings = require('../routes/settings');
const { sanitizeColorMap } = mountSettings;

function withApp(fn) {
  const app = express();
  mountSettings(app);
  const server = app.listen(0);
  const port = server.address().port;
  return Promise.resolve(fn(port)).finally(() => server.close());
}

// --- sanitizeColorMap (pure) ---------------------------------------------------

test('sanitizeColorMap: keeps valid #rrggbb, normalises the key (trim+lowercase)', () => {
  assert.deepStrictEqual(sanitizeColorMap({ ' Rent & Lease ': '#AABBCC' }), { 'rent & lease': '#AABBCC' });
});

test('sanitizeColorMap: drops non-hex values, blank keys, and non-string values', () => {
  assert.deepStrictEqual(sanitizeColorMap({ x: 'red', '': '#ffffff', y: 123, z: '#12345' }), {});
});

test('sanitizeColorMap: tolerates null / array / non-object input (never throws)', () => {
  assert.deepStrictEqual(sanitizeColorMap(null), {});
  assert.deepStrictEqual(sanitizeColorMap([1, 2]), {});
  assert.deepStrictEqual(sanitizeColorMap('nope'), {});
});

test('sanitizeColorMap: caps at 200 entries', () => {
  const big = {};
  for (let i = 0; i < 250; i++) big['cat' + i] = '#010203';
  assert.strictEqual(Object.keys(sanitizeColorMap(big)).length, 200);
});

// --- GET ----------------------------------------------------------------------

test('GET: returns the stored colours (sanitized) from the account_settings row', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => ([{ id: 'x', value: { 'rent & lease': '#aabbcc', bad: 'nothex' } }]);
  try {
    await withApp(async (port) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors');
      const body = await r.json();
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(body, { colors: { 'rent & lease': '#aabbcc' } });
    });
  } finally { supabase.sbSelect = orig; }
});

test('GET: no row yet → empty colours map', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => ([]);
  try {
    await withApp(async (port) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors');
      assert.deepStrictEqual(await r.json(), { colors: {} });
    });
  } finally { supabase.sbSelect = orig; }
});

test('GET: DB error → graceful 502, no internal leak', async () => {
  const orig = supabase.sbSelect;
  supabase.sbSelect = async () => { throw new Error('boom at /srv/secret.js'); };
  try {
    await withApp(async (port) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors');
      assert.strictEqual(r.status, 502);
      const body = await r.json();
      assert.strictEqual(body.error, 'load failed');
      assert.ok(!/secret/.test(JSON.stringify(body)));
    });
  } finally { supabase.sbSelect = orig; }
});

// --- PUT ----------------------------------------------------------------------

test('PUT: inserts when no row exists; stores the sanitized map', async () => {
  const origSel = supabase.sbSelect, origIns = supabase.sbInsert, origUpd = supabase.sbUpdate;
  let inserted = null, updated = null;
  supabase.sbSelect = async () => ([]);
  supabase.sbInsert = async (table, row) => { inserted = { table, row }; };
  supabase.sbUpdate = async () => { updated = true; };
  try {
    await withApp(async (port) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colors: { Groceries: '#112233', junk: 'red' } }),
      });
      const body = await r.json();
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(body, { colors: { groceries: '#112233' } });
      assert.strictEqual(inserted.table, 'account_settings');
      assert.deepStrictEqual(inserted.row.value, { groceries: '#112233' });
      assert.strictEqual(updated, null, 'should insert, not update, when no row exists');
    });
  } finally { supabase.sbSelect = origSel; supabase.sbInsert = origIns; supabase.sbUpdate = origUpd; }
});

test('PUT: updates the existing row when one is already stored', async () => {
  const origSel = supabase.sbSelect, origIns = supabase.sbInsert, origUpd = supabase.sbUpdate;
  let updatedWith = null, insertCalled = false;
  supabase.sbSelect = async () => ([{ id: 'row-1', value: {} }]);
  supabase.sbInsert = async () => { insertCalled = true; };
  supabase.sbUpdate = async (table, sel, patch) => { updatedWith = { table, sel, patch }; return []; };
  try {
    await withApp(async (port) => {
      const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colors: { Fuel: '#0a0b0c' } }),
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(insertCalled, false);
      assert.strictEqual(updatedWith.sel.id, 'row-1');
      assert.deepStrictEqual(updatedWith.patch.value, { fuel: '#0a0b0c' });
    });
  } finally { supabase.sbSelect = origSel; supabase.sbInsert = origIns; supabase.sbUpdate = origUpd; }
});

test('PUT: malformed JSON body → 400, never crashes', async () => {
  await withApp(async (port) => {
    const r = await fetch('http://127.0.0.1:' + port + '/api/settings/category-colors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    assert.strictEqual(r.status, 400);
  });
});
