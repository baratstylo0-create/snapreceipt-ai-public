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

test('GET /api/config exposes multi_user (ADR-021 Phase 6: the frontend picks login vs token gate)', async () => {
  const saved = { CAP_MULTI_USER: process.env.CAP_MULTI_USER, ACCOUNT_TYPE: process.env.ACCOUNT_TYPE };
  try {
    process.env.CAP_MULTI_USER = 'true';
    let { json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config');
    assert.strictEqual(json.multi_user, true);

    process.env.CAP_MULTI_USER = 'false';
    process.env.ACCOUNT_TYPE = 'personal';
    ({ json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config'));
    assert.strictEqual(json.multi_user, false);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('GET /api/config exposes the ADR-022 profile flags — defaults: grid ON, submission OFF', async () => {
  const saved = { CAP_EXCEL_LITE_GRID: process.env.CAP_EXCEL_LITE_GRID, CAP_BRANCH_SUBMISSION: process.env.CAP_BRANCH_SUBMISSION };
  try {
    delete process.env.CAP_EXCEL_LITE_GRID;
    delete process.env.CAP_BRANCH_SUBMISSION;
    let { json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config');
    assert.strictEqual(json.excel_lite_grid, true, 'grid defaults ON (general product)');
    assert.strictEqual(json.branch_submission, false, 'submission defaults OFF');

    // The Premala profile combo (docs/clients/premala.md): grid OFF, submission ON.
    process.env.CAP_EXCEL_LITE_GRID = 'false';
    process.env.CAP_BRANCH_SUBMISSION = 'true';
    ({ json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config'));
    assert.strictEqual(json.excel_lite_grid, false);
    assert.strictEqual(json.branch_submission, true);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
