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
const { cfg } = require('../lib/config');

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

test('GET /api/config exposes C1 packaging flags with Premala-safe defaults', async () => {
  const saved = {
    CAP_PAYMENTS_PAGE: process.env.CAP_PAYMENTS_PAGE,
    CAP_TEMPLATE_BUILDER: process.env.CAP_TEMPLATE_BUILDER,
    CAP_COMPANIES_UI: process.env.CAP_COMPANIES_UI,
  };
  try {
    delete process.env.CAP_PAYMENTS_PAGE;
    delete process.env.CAP_TEMPLATE_BUILDER;
    delete process.env.CAP_COMPANIES_UI;
    let { json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config');
    assert.strictEqual(json.payments_page, false);
    assert.strictEqual(json.template_builder, false);
    assert.strictEqual(json.companies_ui, false);

    process.env.CAP_PAYMENTS_PAGE = 'true';
    process.env.CAP_TEMPLATE_BUILDER = 'true';
    process.env.CAP_COMPANIES_UI = 'true';
    ({ json } = await get((() => { const a = express(); mountExpenses(a); return a; })(), '/api/config'));
    assert.strictEqual(json.payments_page, true);
    assert.strictEqual(json.template_builder, true);
    assert.strictEqual(json.companies_ui, true);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('GET /api/config exposes bot_username (Team view deep-link) — fixed at process start like BOT_TOKEN, always a string, matches cfg', async () => {
  const app = express();
  mountExpenses(app);
  const { json } = await get(app, '/api/config');
  assert.strictEqual(typeof json.bot_username, 'string');
  assert.strictEqual(json.bot_username, cfg.BOT_USERNAME);
  // Never the raw token — only the public @handle is ever exposed here.
  assert.strictEqual(json.bot_username.includes(cfg.BOT_TOKEN || ' no-token '), false);
});

// --- account-aware categories (docs/clients/premala.md: "categories via template
// import" — a client's own chart of accounts, e.g. Premala's "Touch n Go", must
// actually reach the dashboard once imported, not just the OCR categoriser which
// already preferred it). Stubs the field_templates Supabase call the same way
// tests/branches.route.test.js stubs /rest/v1/* — only that one table is faked;
// everything else (including this test's own HTTP call to the express server)
// passes through to the real fetch. ---

// A syntactically valid FieldSpec.columns array — getFieldSpec() early-returns the
// DEFAULT_COLUMNS/no-categories shape when columns is empty/invalid (lib/templates.js
// isValidColumn), so the stub row needs real columns to ever reach the categories logic.
const VALID_COLUMNS = [
  { key: 'merchant', label: 'Merchant', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'currency', required: true },
];

function withFieldSpecCategories(categories, fn) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/field_templates')) return realFetch(url, opt);
    return { text: async () => JSON.stringify([{ columns: VALID_COLUMNS, categories }]) };
  };
  return fn().finally(() => { global.fetch = realFetch; });
}

test('GET /api/config prefers the account\'s own field_templates.categories when set (Premala\'s real chart of accounts)', () => withFieldSpecCategories(
  ['Petrol/Diesel', 'Touch n Go', 'Entertainment', 'Printing & Stationery', 'Sundry Expenses', 'Travelling Expenses', 'Accommodation', 'Hardware & Loose Tools', 'Parking Fee'],
  async () => {
    const app = express();
    mountExpenses(app);
    const { json } = await get(app, '/api/config');
    // sanitizeCategories (lib/templates.js) always appends 'Others' when absent — the
    // categorizer fallback + the picker's "type a note" escape hatch both assume it exists.
    assert.deepStrictEqual(json.categories, [
      'Petrol/Diesel', 'Touch n Go', 'Entertainment', 'Printing & Stationery', 'Sundry Expenses',
      'Travelling Expenses', 'Accommodation', 'Hardware & Loose Tools', 'Parking Fee', 'Others',
    ]);
    assert.ok(!json.categories.every((c) => CATEGORIES.includes(c)), 'must be the account\'s own set, not the generic default');
  },
));

test('GET /api/config falls back to the generic CATEGORIES when the account has no custom set (empty array)', () => withFieldSpecCategories([], async () => {
  const app = express();
  mountExpenses(app);
  const { json } = await get(app, '/api/config');
  assert.deepStrictEqual(json.categories, CATEGORIES);
}));
