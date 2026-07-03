'use strict';
// GET /api/config now includes the REAL category list (lib/categorize.js CATEGORIES) so
// the frontend can build its filter/edit dropdowns + pill colours dynamically instead of
// keeping a second, driftable hardcoded copy — the root cause of the
// Food/Petrol/Software/Inventory/Others vs. real-18-category mismatch bug.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountExpenses = require('../routes/expenses');
const { CATEGORIES } = require('../lib/categorize');

function get(app, path) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0);
    const base = 'http://127.0.0.1:' + srv.address().port;
    fetch(base + path)
      .then((r) => r.json().then((json) => { srv.close(); resolve({ status: r.status, json }); }))
      .catch((e) => { srv.close(); reject(e); });
  });
}

test('GET /api/config returns the real CATEGORIES list from lib/categorize.js', async () => {
  const app = express();
  mountExpenses(app);
  const { status, json } = await get(app, '/api/config');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json.categories));
  assert.deepStrictEqual(json.categories, CATEGORIES);
  // Confirms this is the REAL 18-category chart of accounts, not the old 5-name stub.
  assert.ok(json.categories.includes('Meals & Entertainment'));
  assert.ok(json.categories.includes('Others'));
  assert.ok(json.categories.length > 5);
});

test('GET /api/config still returns auth_required + default_currency unchanged', async () => {
  const app = express();
  mountExpenses(app);
  const { json } = await get(app, '/api/config');
  assert.strictEqual(typeof json.auth_required, 'boolean');
  assert.strictEqual(typeof json.default_currency, 'string');
});
