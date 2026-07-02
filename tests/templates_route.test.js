'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountTemplates = require('../routes/templates');

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

test('QA: invalid (non-UTF-8) byte sequences in the body are lossily decoded and persisted, not rejected', async () => {
  // Sending raw invalid UTF-8 bytes gets silently decoded to U+FFFD
  // replacement characters and stored -- no validation/rejection of malformed
  // text encoding happens at the boundary.
  await withServer(emptyDb, async (base) => {
    const buf = Buffer.from([0xFF, 0xFE, 0x41, 0x2C, 0x42, 0x2C, 0x43]); // invalid lead bytes + "A,B,C"
    const r = await fetch(base + '/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: buf,
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(j.columns[0].label.includes('�'), 'expected lossy-decoded replacement character in the stored label');
  });
});
