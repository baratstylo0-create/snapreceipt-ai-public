# #7 Mass Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user submit a batch of receipt photos at once; read every photo (each may hold several receipts), process each receipt through the existing pipeline, and return a best-effort per-receipt summary.

**Architecture:** A transport-agnostic orchestrator `lib/massupload.js` (`runBatch`) loops images, calls Barat's `extractReceipts` per image and `assembleExpense` per extracted receipt (both dependency-injected, read-only), and aggregates a summary that never throws. `routes/upload.js` is a thin dashboard adapter (`POST /api/upload`, `checkDash`, base64→Buffer, caps). Everything is DI so the whole thing is unit-testable with fakes and works before Barat's OCR branch merges (route returns 503 until then).

**Tech Stack:** Node 22, Express, `node:test`. No new dependency.

---

## Cross-lane dependency (Barat — `lib/ocr.js`, branch `feature/barat-p4-mass-ocr`)
`extractReceipts(image, fieldSpec, {maxReceipts?}) -> { receipts:[{fields,rawParsed}], truncated }` (already implemented + exported on his branch). This plan does NOT block on it: `lib/massupload.js` and both route paths are DI and fully tested with fakes; `routes/upload.js` returns **503** on the live path until his branch merges. QA his branch separately.

## File structure
- **Create** `lib/massupload.js` — `runBatch(images, fieldSpec, deps)` orchestrator (never throws; aggregates summary).
- **Create** `routes/upload.js` — `mountUpload(app, deps={})` → `POST /api/upload`.
- **Create** `tests/massupload.test.js` — hermetic unit tests (fake extractReceipts + assembleExpense).
- **Create** `tests/upload.route.test.js` — route tests (auth, caps, 503, error shapes).
- **Modify** `server.js` — mount `routes/upload.js`.
- **Modify** `tests/smoke.test.js` — add `../lib/massupload` + `../routes/upload` to the import list.
- **Modify** `.env.example` — add `MASS_MAX_IMAGES`.
- **Modify** `docs/ARCHITECTURE.md` — add the two modules to the map.

Reused unchanged: `lib/ocr.js` (`extractReceipts`, `assembleExpense` — Barat's), `lib/templates.js` (`getFieldSpec` — Barat's), `routes/expenses.js` (`checkDash`).

---

### Task 1: `lib/massupload.js` — `runBatch` orchestrator

**Files:** Create `lib/massupload.js`; Test: create `tests/massupload.test.js`.

- [ ] **Step 1: Write the failing tests**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runBatch } = require('../lib/massupload');

// Fake extractReceipts: keyed by the image value (a string here) to script per-image behavior.
function fakes(script) {
  const assembleCalls = [];
  const extractReceipts = async (image) => {
    const s = script[image];
    if (s.throw) throw new Error(s.throw);
    return { receipts: s.receipts, truncated: !!s.truncated };
  };
  const assembleExpense = async (arg) => {
    assembleCalls.push(arg);
    if (arg.fields && arg.fields.__fail) throw new Error('assemble boom');
    return { expense: { merchant: arg.fields ? arg.fields.merchant : undefined }, flagged: arg.fields ? arg.fields.__flag : false };
  };
  return { extractReceipts, assembleExpense, assembleCalls };
}
const FS = { columns: [{ key: 'merchant', type: 'text' }] };

test('all-success batch: saved == total receipts, failed empty, meta passed through', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Shell' }, rawParsed: { a: 1 } }, { fields: { merchant: 'Tesco' }, rawParsed: {} }] },
    img2: { receipts: [{ fields: { merchant: 'Aldi' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense, meta: { repName: 'Dashboard', fileId: null } });
  assert.equal(s.images, 2);
  assert.equal(s.receipts, 3);
  assert.equal(s.saved, 3);
  assert.deepEqual(s.failed, []);
  assert.equal(f.assembleCalls[0].repName, 'Dashboard');    // meta passed
  assert.equal(f.assembleCalls[0].fieldSpec, FS);           // fieldSpec passed
  assert.equal(f.assembleCalls[0].rawParsed.a, 1);          // rawParsed passed
});

test('one image extract throws: that image failed, others fully processed', async () => {
  const f = fakes({
    img1: { throw: 'blurry' },
    img2: { receipts: [{ fields: { merchant: 'Aldi' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].image_index, 0);
  assert.equal(s.failed[0].reason, 'blurry');
  assert.equal('receipt_index' in s.failed[0], false); // whole-image failure has no receipt_index
});

test('one receipt assemble throws: that receipt failed, siblings saved', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Ok' }, rawParsed: {} }, { fields: { __fail: true }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.equal(s.receipts, 2);
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.deepEqual({ i: s.failed[0].image_index, j: s.failed[0].receipt_index }, { i: 0, j: 1 });
});

test('truncated image index recorded; flagged receipts aggregated', async () => {
  const f = fakes({
    img1: { truncated: true, receipts: [{ fields: { merchant: 'Fuel', __flag: 'anomaly:dup' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.deepEqual(s.truncated_images, [0]);
  assert.equal(s.saved, 1);
  assert.equal(s.flagged.length, 1);
  assert.deepEqual({ i: s.flagged[0].image_index, m: s.flagged[0].merchant, r: s.flagged[0].reason }, { i: 0, m: 'Fuel', r: 'anomaly:dup' });
});

test('empty images -> zeroed summary, never throws', async () => {
  const f = fakes({});
  const s = await runBatch([], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.deepEqual(s, { images: 0, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/massupload.test.js`
Expected: FAIL — "Cannot find module '../lib/massupload'".

- [ ] **Step 3: Implement `lib/massupload.js`**

```js
'use strict';
/**
 * #7 Mass upload — transport-agnostic batch orchestrator.
 * Loops images, calls Barat's extractReceipts per image, runs assembleExpense per
 * extracted receipt, aggregates a best-effort summary. NEVER throws — every image and
 * every receipt is individually try/caught so one failure never blocks the rest
 * (mirrors the graceful degradation already in expenseFromPhoto). Pure orchestration:
 * all I/O is through the injected deps, so it's fully unit-testable with fakes.
 *
 * runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta?, extractOpts? })
 *   -> { images, receipts, saved, failed:[{image_index, receipt_index?, reason}],
 *        flagged:[{image_index, receipt_index, merchant, reason}], truncated_images:[i] }
 */
async function runBatch(images, fieldSpec, deps) {
  const { extractReceipts, assembleExpense, meta = {}, extractOpts } = deps;
  const list = Array.isArray(images) ? images : [];
  const summary = { images: list.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] };

  for (let i = 0; i < list.length; i++) {
    let receipts;
    try {
      const out = await extractReceipts(list[i], fieldSpec, extractOpts);
      receipts = out && Array.isArray(out.receipts) ? out.receipts : [];
      if (out && out.truncated) summary.truncated_images.push(i);
    } catch (e) {
      summary.failed.push({ image_index: i, reason: e.message });   // whole image unreadable
      continue;
    }
    for (let j = 0; j < receipts.length; j++) {
      summary.receipts += 1;
      const r = receipts[j] || {};
      try {
        const { expense, flagged } = await assembleExpense({ ...meta, fields: r.fields, rawParsed: r.rawParsed, fieldSpec });
        summary.saved += 1;
        if (flagged) summary.flagged.push({ image_index: i, receipt_index: j, merchant: expense && expense.merchant, reason: flagged });
      } catch (e) {
        summary.failed.push({ image_index: i, receipt_index: j, reason: e.message });
      }
    }
  }
  return summary;
}

module.exports = { runBatch };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/massupload.test.js`
Expected: PASS (5 tests). Then `npm test` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add lib/massupload.js tests/massupload.test.js
git commit -m "feat(mass-upload): runBatch best-effort batch orchestrator (#7)"
```

---

### Task 2: `routes/upload.js` — dashboard adapter + mount

**Files:** Create `routes/upload.js`; Modify `server.js`, `tests/smoke.test.js`; Test: create `tests/upload.route.test.js`.

- [ ] **Step 1: Write the failing tests**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { cfg } = require('../lib/config');
const mountUpload = require('../routes/upload');

// Base deps: a fake runBatch + a dummy extractReceipts function (present => not the 503 path)
// + a fake getFieldSpec. Individual tests override as needed.
function appWith(over = {}) {
  const app = express();
  const deps = {
    runBatch: async () => ({ images: 1, receipts: 2, saved: 2, failed: [], flagged: [], truncated_images: [] }),
    extractReceipts: async () => ({ receipts: [], truncated: false }),
    assembleExpense: async () => ({ expense: {}, flagged: false }),
    getFieldSpec: async () => ({ columns: [{ key: 'merchant', type: 'text' }] }),
    ...over,
  };
  mountUpload(app, deps);
  return app;
}
async function post(app, body, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}
const b64 = Buffer.from('fake-image-bytes').toString('base64');

test('happy path -> 200 + summary', async () => {
  const r = await post(appWith(), { images: [b64, b64] });
  assert.equal(r.status, 200);
  assert.equal(r.json.saved, 2);
});

test('runBatch receives decoded Buffers', async () => {
  let got;
  const app = appWith({ runBatch: async (imgs) => { got = imgs; return { images: imgs.length, receipts: 0, saved: 0, failed: [], flagged: [], truncated_images: [] }; } });
  await post(app, { images: [b64] });
  assert.ok(Buffer.isBuffer(got[0]));
  assert.equal(got[0].toString(), 'fake-image-bytes');
});

test('non-array / empty / non-string element -> 400, no stack', async () => {
  for (const body of [{ images: 'x' }, { images: [] }, { images: [123] }, { nope: 1 }]) {
    const r = await post(appWith(), body);
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.json).includes('at '));
  }
});

test('too many images -> 413 (runBatch not called)', async () => {
  let called = false;
  const app = appWith({ runBatch: async () => { called = true; return {}; } });
  const r = await post(app, { images: Array.from({ length: 11 }, () => b64) });
  assert.equal(r.status, 413);
  assert.equal(called, false);
});

test('extractReceipts unavailable -> 503', async () => {
  const r = await post(appWith({ extractReceipts: undefined }), { images: [b64] });
  assert.equal(r.status, 503);
});

test('checkDash enforced: 401 without token, 200 with token', async () => {
  const prev = cfg.DASHBOARD_TOKEN;
  cfg.DASHBOARD_TOKEN = 'secret';
  try {
    assert.equal((await post(appWith(), { images: [b64] })).status, 401);
    assert.equal((await post(appWith(), { images: [b64] }, { Authorization: 'Bearer secret' })).status, 200);
  } finally { cfg.DASHBOARD_TOKEN = prev; }
});

test('runBatch throws -> 502 JSON, no stack', async () => {
  const app = appWith({ runBatch: async () => { throw new Error('kaboom at internal/x.js:1'); } });
  const r = await post(app, { images: [b64] });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes('internal/x.js'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/upload.route.test.js`
Expected: FAIL — "Cannot find module '../routes/upload'".

- [ ] **Step 3: Implement `routes/upload.js`**

```js
'use strict';
const express = require('express');
const { checkDash } = require('./expenses');
const { runBatch: realRunBatch } = require('../lib/massupload');
const ocr = require('../lib/ocr');
const templates = require('../lib/templates');

const MAX_IMAGES = Number(process.env.MASS_MAX_IMAGES) || 10;

// Strip a data-URI prefix ("data:image/png;base64,") if the client sent one.
function stripDataUri(s) {
  const m = /^data:[^;]*;base64,/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

module.exports = function mountUpload(app, deps = {}) {
  const runBatch = deps.runBatch || realRunBatch;
  // Resolve via 'in deps' so a test can force the unavailable (503) path with an explicit undefined,
  // regardless of whether Barat's ocr.extractReceipts has merged yet.
  const extractReceipts = ('extractReceipts' in deps) ? deps.extractReceipts : ocr.extractReceipts;
  const assembleExpense = ('assembleExpense' in deps) ? deps.assembleExpense : ocr.assembleExpense;
  const getFieldSpec = deps.getFieldSpec || templates.getFieldSpec;

  app.post('/api/upload', checkDash, express.json({ limit: '10mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const images = req.body && req.body.images;
      if (!Array.isArray(images) || images.length === 0 || images.some(s => typeof s !== 'string' || s === '')) {
        return res.status(400).json({ error: 'images must be a non-empty array of base64 strings' });
      }
      if (images.length > MAX_IMAGES) return res.status(413).json({ error: 'too many images (max ' + MAX_IMAGES + ')' });
      if (typeof extractReceipts !== 'function') return res.status(503).json({ error: 'mass upload not available yet' });

      const buffers = images.map(s => Buffer.from(stripDataUri(s), 'base64'));
      const fieldSpec = await getFieldSpec();
      const meta = { repName: 'Dashboard', fileId: null };
      const summary = await runBatch(buffers, fieldSpec, { extractReceipts, assembleExpense, meta });
      res.json(summary);
    } catch (e) {
      console.error('[api/upload]', e.message);
      res.status(502).json({ error: 'upload failed' });
    }
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/upload.route.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Mount + smoke**

In `server.js`, add with the other route requires/mounts (after `mountAgent`): `const mountUpload = require('./routes/upload'); // #7 mass upload` and `mountUpload(app);`.
In `tests/smoke.test.js`, add `'../lib/massupload'` and `'../routes/upload'` to the module-import list.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: all prior + new tests PASS.

- [ ] **Step 7: Commit**

```bash
git add routes/upload.js server.js tests/upload.route.test.js tests/smoke.test.js
git commit -m "feat(mass-upload): POST /api/upload dashboard adapter with auth + caps + 503 dark-path (#7)"
```

---

### Task 3: Docs + env

**Files:** Modify `.env.example`, `docs/ARCHITECTURE.md`, `docs/WORKLOG.md`, `docs/STATUS.md`.

- [ ] **Step 1: `.env.example`** — add:

```
# #7 mass upload — max photos accepted per batch (dashboard)
MASS_MAX_IMAGES=10
```

- [ ] **Step 2: `docs/ARCHITECTURE.md`** — add `lib/massupload.js` (`runBatch`, transport-agnostic batch orchestrator) and `routes/upload.js` (`POST /api/upload`) to the §3 module map; note the Telegram multi-photo adapter as a future Barat-lane consumer of the same `runBatch`.

- [ ] **Step 3: `docs/WORKLOG.md`** — prepend a J1 entry (files, what changed, Tier-2, the cross-lane `extractReceipts` dependency + 503 dark-path, tests count, what's next).

- [ ] **Step 4: `docs/STATUS.md`** — mark #7 built/in-review; note the Telegram multi-photo follow-up (Barat) and the pending QA of `feature/barat-p4-mass-ocr`.

- [ ] **Step 5: Commit + push + PR**

```bash
git add .env.example docs/ARCHITECTURE.md docs/WORKLOG.md docs/STATUS.md
git commit -m "docs(mass-upload): architecture map + env + worklog for #7"
git push -u origin feature/jeevan-p4-massupload
gh pr create --base main --title "feat(#7): mass upload — batch orchestrator + POST /api/upload" --body "..."
```

---

## Definition of Done
- `runBatch` frozen interface; best-effort never-throw orchestration with the summary shape; `POST /api/upload` with `checkDash`, image cap (413), base64 decode, safe errors (400/502), 503 dark-path; sequential; no new dependency; env-driven cap.
- All tests green (`npm test`). Docs (ARCHITECTURE/WORKLOG/STATUS/.env.example) updated.
- **Cross-lane:** Barat's `feature/barat-p4-mass-ocr` (`extractReceipts`) opened + independently QA'd; live path stays 503 until it merges.
- PR → independent **Tier-2 QA** (untrusted image input + writes money rows) before merge, same bar as #8/#2/#9/#22.

## Self-review notes
- Spec coverage: orchestrator + summary shape + never-throw ✓ (T1); route auth/caps/base64/503/errors ✓ (T2); env/docs ✓ (T3); sequential (for-loop, awaited) ✓ (T1); `meta`/`fileId:null` ✓ (T1 asserts meta pass-through, T2 route sets `fileId:null`); Telegram + Barat QA are out-of-scope follow-ups ✓ (documented).
- Type consistency: `runBatch(images, fieldSpec, {extractReceipts, assembleExpense, meta, extractOpts})` used identically in T1 code + T2 route call; summary keys (`images/receipts/saved/failed/flagged/truncated_images`) consistent across T1 tests, impl, and T2 fake; `extractReceipts` return `{receipts, truncated}` matches Barat's verified contract; `assembleExpense` return `{expense, flagged}` matches.
- Placeholder scan: PR `--body "..."` in T3 is the fill-at-PR-time item (standard). No code placeholders.
