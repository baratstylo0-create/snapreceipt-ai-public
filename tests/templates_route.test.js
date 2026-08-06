'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountTemplates = require('../routes/templates');
const { adminWriteOnly } = mountTemplates;

// Spin up the route on an ephemeral port and hit it with real fetch (same shape
// as tests/smoke.test.js). Supabase calls (getFieldSpec/saveTemplate -> REST) are
// stubbed by URL so no network happens — but the test's OWN request to 127.0.0.1
// must pass through to the real server, so we only intercept non-local URLs.
function withServer(supabaseHandler, run) {
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
      return realFetch(url, opt); // the test's request to our own express app
    }
    return supabaseHandler(u, opt); // intercept Supabase REST
  };
  const app = express();
  mountTemplates(app);
  const server = app.listen(0);
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  return Promise.resolve(run(base))
    .finally(() => { server.close(); global.fetch = realFetch; });
}

// Supabase REST stub: GET field_templates -> [] (no stored template),
// POST/PATCH -> minimal empty body. hreq JSON-parses the text.
function emptyDb(_u, opt) {
  const method = (opt && opt.method) || 'GET';
  const body = method === 'GET' ? '[]' : '';
  return { text: async () => body };
}

test('GET /api/templates returns the DEFAULT FieldSpec when none stored', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates');
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.strictEqual(spec.updated_at, null);
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount', 'currency', 'category']);
  });
});

test('POST /api/templates with a text/csv body parses + stores + returns the FieldSpec', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Vendor,Purchase Date,Grand Total,GST',
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount', 'tax']);
    assert.strictEqual(spec.columns[0].label, 'Vendor'); // exact customer header preserved
  });
});

test('POST /api/templates accepts a JSON body { csv }', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount' }),
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount']);
  });
});

test('POST /api/templates accepts a real .xlsx file (binary body) and reads its header row', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(['Supplier', 'Purchase Date', 'Grand Total']);
  sheet.addRow(['Acme Co', '2026-01-01', 42.5]); // a data row — must be ignored (headers only)
  const buffer = await wb.xlsx.writeBuffer();

  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: buffer,
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount']);
    assert.strictEqual(spec.columns[0].label, 'Supplier'); // exact customer header preserved, same as CSV
  });
});

test('POST /api/templates: an .xlsx sent as application/octet-stream (browser omitted the real MIME) still works', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').addRow(['Store', 'Date', 'Amount']);
  const buffer = await wb.xlsx.writeBuffer();

  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant', 'expense_date', 'amount']);
  });
});

test('POST /api/templates rejects an empty .xlsx-typed body with 400, not a 500/crash', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: Buffer.alloc(0),
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /CSV|Excel/i);
  });
});

test('POST /api/templates rejects a non-Excel binary blob sent with the .xlsx content type (400, not 500)', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), // garbage, not a real zip/xlsx
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /parseExcelTemplate/);
  });
});

test('POST /api/templates rejects an empty body with 400 (no DB write attempted)', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: '   ',
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /provide CSV/i);
  });
});

test('POST /api/templates returns 400 (not 500) on an all-blank-header CSV', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: ',,,\nx,y,z',
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /parseTemplate/);
  });
});

// ---------------------------------------------------------------------------
// QA adversarial pass (Tier-2 review, SOP §4.7/§4.8, docs/roles/QA.md).
// Findings below are written as tests, per the QA contract ("committed tests,
// not a prose report"). Do NOT weaken these to make them pass — a failing
// test here documents a real bug for the Debug loop to fix.
// ---------------------------------------------------------------------------

test('QA: malformed JSON body must not leak a stack trace / internal file paths to the client', async () => {
  // CRITICAL: express.json() throws synchronously on invalid JSON. That throw
  // happens in body-parser middleware BEFORE the route's own try/catch runs,
  // so it falls through to Express's default error handler, which (outside
  // NODE_ENV=production) writes the full stack trace -- including absolute
  // server file paths -- straight into the HTTP response body. SOP §7.2:
  // "Errors never leak internals (stack traces, queries, keys) to the client."
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    assert.strictEqual(r.status, 400);
    const text = await r.text();
    // Must not be an Express HTML error page.
    assert.ok(!/<!DOCTYPE html>/i.test(text), 'route must not fall through to the default Express HTML error page; got: ' + text.slice(0, 200));
    // Must not contain a filesystem path or stack frame.
    assert.ok(!/node_modules[\\/]/.test(text), 'response leaked an internal file path:\n' + text.slice(0, 300));
    assert.ok(!/\bat \S+ \(/.test(text), 'response leaked a stack trace frame:\n' + text.slice(0, 300));
    // Should be the route's own clean JSON error contract.
    let j;
    assert.doesNotThrow(() => { j = JSON.parse(text); }, 'expected a JSON error body, got: ' + text.slice(0, 200));
    assert.strictEqual(typeof j.error, 'string');
  });
});

test('QA: an unsupported charset on the JSON content-type must not leak a stack trace to the client', async () => {
  // Same root cause as the malformed-JSON case: body-parser's charset check
  // throws synchronously (UnsupportedMediaTypeError) outside the route's
  // try/catch, and the response is again an Express HTML error page with a
  // full stack trace / file paths.
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=bogus-charset-xyz' },
      body: JSON.stringify({ csv: 'Vendor,Date,Amount' }),
    });
    const text = await r.text();
    assert.ok(!/<!DOCTYPE html>/i.test(text), 'route must not fall through to the default Express HTML error page; got: ' + text.slice(0, 200));
    assert.ok(!/node_modules[\\/]/.test(text), 'response leaked an internal file path:\n' + text.slice(0, 300));
  });
});

test('QA: a column label containing HTML/script content is stored and echoed back verbatim (stored-XSS supply risk)', async () => {
  // IMPORTANT: routes/templates.js and lib/templates.js perform no sanitization
  // of header/label content beyond a length cap. lib/templates.js documents
  // that `label` is "the exact header the customer wrote... what Excel emits"
  // and is read by the dashboard. If any downstream consumer (Excel export,
  // dashboard UI) renders `column.label` as HTML without escaping, an
  // attacker-controlled CSV header becomes a stored-XSS payload. This test
  // documents that the HTTP layer does not neutralize this input; downstream
  // renderers MUST treat `label` as untrusted and escape on output (SOP §7.2).
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: '<script>alert(1)</script>,Date,Amount',
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    // Documents current (risky) behavior: raw script tag passes through unescaped.
    assert.strictEqual(j.columns[0].label, '<script>alert(1)</script>');
  });
});

test('QA: an embedded NUL/control byte in a header is STRIPPED at the boundary (P6 fix, parse-side of #17)', () => {
  // UPDATED 2026-07-02 (Barat, P6 hardening): this previously locked the gap where
  // control bytes survived into the stored label. lib/templates.js parseTemplate now
  // strips C0/C1 control chars (stripControls) at the parse boundary, so unvalidated
  // control-character data no longer flows into storage or back over the API
  // (SOP §7.2 "validate at the boundary"). This closes the CONTROL-CHAR part of #17.
  // NOTE — the HTML/`<script>` supply case above is intentionally NOT changed here:
  // printable tags still pass through by design; neutralising them is RENDER-side
  // output-escaping in the frontend lane (the remaining part of issue #17).
  return withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'Vendor\x00Evil,Date,Amount',
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(!j.columns[0].label.includes('\x00'), 'the NUL byte must not survive into the stored label');
    assert.strictEqual(j.columns[0].label, 'VendorEvil'); // control byte removed, visible text kept
  });
});

test('QA: invalid (non-UTF-8) byte sequences in a header are REJECTED at the boundary (fix, remaining part of #17)', async () => {
  // UPDATED 2026-07-08 (Barat, #17 follow-up): body-parser lossily decodes invalid
  // UTF-8 lead/continuation bytes to U+FFFD replacement characters BEFORE
  // parseTemplate ever sees a string -- the raw bytes are gone by then. Rather than
  // silently persisting the lossy result, parseTemplate now treats any U+FFFD in a
  // header as a sign of malformed input and rejects the request (400), same
  // boundary-validation convention as the too-many-columns / empty-header checks.
  await withServer(emptyDb, async (base) => {
    const buf = Buffer.from([0xFF, 0xFE, 0x41, 0x2C, 0x42, 0x2C, 0x43]); // invalid lead bytes + "A,B,C"
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: buf,
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.ok(!/�/.test(j.error || ''), 'error message must not itself carry the replacement char through');
  });
});

// --- business category set via the JSON body (ADR-021 Phase 5) --------------------------

test('POST /api/templates JSON { csv, categories } stores + echoes the sanitized category set', async () => {
  // Capture what got written to Supabase so we can assert the category set persisted.
  let written = null;
  const db = (_u, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') return { text: async () => '[]' };
    written = opt.body ? JSON.parse(opt.body) : null;
    return { text: async () => '' };
  };
  await withServer(db, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount', categories: ['Petrol/Diesel', 'petrol/diesel', 'Touch-n-Go'] }),
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.categories, ['Petrol/Diesel', 'Touch-n-Go', 'Others']);
    assert.deepStrictEqual(written.categories, ['Petrol/Diesel', 'Touch-n-Go', 'Others']);
  });
});

test('POST /api/templates text/csv body never sets categories (personal path unchanged)', async () => {
  let written = null;
  const db = (_u, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') return { text: async () => '[]' };
    written = opt.body ? JSON.parse(opt.body) : null;
    return { text: async () => '' };
  };
  await withServer(db, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'Store,Date,Amount',
    });
    assert.strictEqual(r.status, 200);
    assert.ok(!('categories' in written), 'a CSV upload must not write a categories field');
  });
});

test('POST /api/templates JSON with a non-array categories is a 400 (reject-and-explain)', async () => {
  await withServer(emptyDb, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount', categories: 'Fuel,Meals' }),
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /categories must be an array/);
  });
});

// --- adminWriteOnly (2026-07-09, independent-review finding #3: ADR-021 HQ-owned template) ---

test('adminWriteOnly: no scope (personal/static-token mode) -> next() called, no 403', () => {
  let called = false;
  adminWriteOnly({ scope: undefined }, { status() { throw new Error('must not respond'); } }, () => { called = true; });
  assert.strictEqual(called, true);
});

test('adminWriteOnly: scope.role admin -> next() called', () => {
  let called = false;
  adminWriteOnly({ scope: { role: 'admin' } }, { status() { throw new Error('must not respond'); } }, () => { called = true; });
  assert.strictEqual(called, true);
});

test('adminWriteOnly: scope.role clerk -> 403, next() never called', () => {
  let called = false;
  let sentStatus, sentBody;
  const res = { status(s) { sentStatus = s; return { json(b) { sentBody = b; } }; } };
  adminWriteOnly({ scope: { role: 'clerk' } }, res, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(sentStatus, 403);
  assert.match(sentBody.error, /admin/i);
});

// Wiring proof: with a business session already resolved (req.scope set, as checkDashSession
// would do), a clerk's real HTTP POST is rejected by the full route BEFORE any DB write.
test('POST /api/templates: a clerk-scoped session is rejected end-to-end (403), no write attempted', async () => {
  let dbWriteHappened = false;
  const db = (_u, opt) => {
    if ((opt.method || 'GET') !== 'GET') dbWriteHappened = true;
    return { text: async () => '[]' };
  };
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opt);
    return db(u, opt);
  };
  const app = express();
  app.use((req, res, next) => { req.scope = { account_id: 'default', role: 'clerk', branch_id: 'b1' }; next(); }); // simulates checkDashSession's business path
  mountTemplates(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount' }),
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(dbWriteHappened, false);
  } finally { server.close(); global.fetch = realFetch; }
});

test('POST /api/templates: an admin-scoped session still succeeds end-to-end (200)', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opt);
    return { text: async () => '[]' };
  };
  const app = express();
  app.use((req, res, next) => { req.scope = { account_id: 'default', role: 'admin' }; next(); });
  mountTemplates(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Store,Date,Amount' }),
    });
    assert.strictEqual(r.status, 200);
  } finally { server.close(); global.fetch = realFetch; }
});

// --- categories-only save (2026-07-09, independent-review finding #4) -----------------------

test('POST /api/templates: JSON { categories } with NO csv -> categories-only save, columns untouched', async () => {
  let written = null;
  const db = (u, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') {
      // 'Fuel' is dropped by this save; the delete-in-use guard queries `expenses` too —
      // table-scoped so that lookup correctly sees no expenses (not an echo of the
      // field_templates fixture, which would wrongly block the save as "still in use").
      if (String(u).includes('/rest/v1/field_templates')) {
        return { text: async () => JSON.stringify([{ id: 'row1', columns: [{ key: 'merchant', label: 'Vendor', type: 'text', required: true }], categories: ['Fuel'], updated_at: 'old' }]) };
      }
      return { text: async () => '[]' };
    }
    written = { method, body: opt.body ? JSON.parse(opt.body) : null };
    return { text: async () => '' };
  };
  await withServer(db, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: ['Petrol/Diesel', 'Touch-n-Go'] }),
    });
    assert.strictEqual(r.status, 200);
    const spec = await r.json();
    assert.deepStrictEqual(spec.columns.map(c => c.key), ['merchant']); // the EXISTING column, echoed unchanged
    assert.deepStrictEqual(spec.categories, ['Petrol/Diesel', 'Touch-n-Go', 'Others']);
    assert.strictEqual(written.method, 'PATCH');
    assert.ok(!('columns' in written.body), 'a categories-only save must never send a columns key');
  });
});

// 2026-07-13 round-2 plan §2.2: saveCategories' delete-in-use guard must surface as a clean
// 400 with its own message — not the generic 502 "save failed" every other saveCategories/
// saveTemplate error already avoids via the 'saveTemplate:' prefix convention.
test('POST /api/templates: removing an in-use category via the categories-only save -> 400 with the guard message, no write', async () => {
  let wrote = false;
  const db = (u, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') {
      if (String(u).includes('/rest/v1/field_templates')) {
        return { text: async () => JSON.stringify([{ id: 'row1', columns: [{ key: 'merchant', label: 'Vendor', type: 'text', required: true }], categories: ['Fuel', 'Meals'], updated_at: 'old' }]) };
      }
      // 'Meals' is being dropped and still has a live expense.
      if (String(u).includes('/rest/v1/expenses') && String(u).includes('category=eq.Meals')) {
        return { text: async () => JSON.stringify([{ id: 'e1', category: 'Meals' }]) };
      }
      return { text: async () => '[]' };
    }
    wrote = true;
    return { text: async () => '' };
  };
  await withServer(db, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: ['Fuel'] }), // drops 'Meals'
    });
    assert.strictEqual(r.status, 400, 'guard rejection is a client error, not a 502');
    const j = await r.json();
    assert.match(j.error, /Meals/);
    assert.match(j.error, /still used/i);
    assert.strictEqual(wrote, false, 'nothing written when the guard rejects');
  });
});

test('POST /api/templates: { categories, csv } together still writes both (combined path unchanged)', async () => {
  let written = null;
  const db = (_u, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') return { text: async () => '[]' };
    written = { method, body: opt.body ? JSON.parse(opt.body) : null };
    return { text: async () => '' };
  };
  await withServer(db, async (base) => {
    const r = await fetch(base + '/api/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: 'Vendor,Date,Amount', categories: ['Fuel'] }),
    });
    assert.strictEqual(r.status, 200);
    assert.ok('columns' in written.body, 'a combined csv+categories save still writes columns');
    assert.deepStrictEqual(written.body.categories, ['Fuel', 'Others']);
  });
});
