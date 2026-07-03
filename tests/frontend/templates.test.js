'use strict';
// Pure logic behind the Templates screen (Task E). These tests cover the
// require()-able helpers with NO DOM: buildImportBody, summarizeFieldSpec,
// errorMessage. Written TDD-first (watch fail, then implement).
//
// The endpoint under test is GET/POST /api/templates (routes/templates.js),
// backed by lib/templates.js's FieldSpec engine. Response/error shapes were
// read directly from those files:
//   FieldSpec = { account_id, columns: [{ key, label, type, required }], updated_at }
//   POST 400 body: { error: e.message } — a PRE-SANITIZED, safe-to-show string
//     ("provide CSV text (text/csv body, or JSON {\"csv\": \"...\"})" or a
//     parseTemplate:/saveTemplate:-prefixed validation message). Unlike
//     upload.js's errorMessage, THIS errorMessage shows the real 400 reason.
//   502 body: { error: 'load failed' } / { error: 'save failed' } -> generic
//     friendly message (house convention: never surface 5xx internals).
const test = require('node:test');
const assert = require('node:assert');

const Templates = require('../../public/js/components/templates');
const Escape = require('../../public/js/escape');
const { buildImportBody, summarizeFieldSpec, errorMessage } = Templates;

// --- buildImportBody -------------------------------------------------------

test('buildImportBody: blank csv (empty string) -> {ok:false, reason:"empty"}', () => {
  assert.deepStrictEqual(buildImportBody('', 'default'), { ok: false, reason: 'empty' });
});

test('buildImportBody: whitespace-only csv -> {ok:false, reason:"empty"}', () => {
  assert.deepStrictEqual(buildImportBody('   \n\t  ', 'default'), { ok: false, reason: 'empty' });
});

test('buildImportBody: null/undefined csv -> {ok:false, reason:"empty"}', () => {
  assert.deepStrictEqual(buildImportBody(null, 'default'), { ok: false, reason: 'empty' });
  assert.deepStrictEqual(buildImportBody(undefined, 'default'), { ok: false, reason: 'empty' });
});

test('buildImportBody: real csv -> {ok:true, csv, name}', () => {
  const result = buildImportBody('Merchant,Date,Amount\nAcme,2026-01-01,10.00', 'my-template');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.csv, 'Merchant,Date,Amount\nAcme,2026-01-01,10.00');
  assert.strictEqual(result.name, 'my-template');
});

test('buildImportBody: blank/omitted name defaults to "default"', () => {
  const csv = 'Merchant,Date,Amount\nAcme,2026-01-01,10.00';
  assert.strictEqual(buildImportBody(csv).name, 'default');
  assert.strictEqual(buildImportBody(csv, '').name, 'default');
  assert.strictEqual(buildImportBody(csv, '   ').name, 'default');
  assert.strictEqual(buildImportBody(csv, null).name, 'default');
});

test('buildImportBody: name is trimmed', () => {
  const csv = 'Merchant,Date,Amount\nAcme,2026-01-01,10.00';
  assert.strictEqual(buildImportBody(csv, '  my-template  ').name, 'my-template');
});

test('buildImportBody: never throws on garbage input', () => {
  assert.doesNotThrow(() => buildImportBody(42, {}));
  assert.doesNotThrow(() => buildImportBody({}, []));
  assert.doesNotThrow(() => buildImportBody(true, 5));
});

// --- summarizeFieldSpec -----------------------------------------------------

function fieldSpec(over) {
  return Object.assign({
    account_id: 'acct-1',
    columns: [
      { key: 'merchant', label: 'Merchant', type: 'text', required: true },
      { key: 'expense_date', label: 'Date', type: 'date', required: true },
      { key: 'amount', label: 'Amount', type: 'currency', required: true },
      { key: 'currency', label: 'Currency', type: 'text', required: false },
      { key: 'category', label: 'Category', type: 'category', required: false },
    ],
    updated_at: '2026-07-01T12:00:00.000Z',
  }, over || {});
}

test('summarizeFieldSpec: a real FieldSpec reduces correctly', () => {
  const vm = summarizeFieldSpec(fieldSpec());
  assert.strictEqual(vm.accountId, 'acct-1');
  assert.strictEqual(vm.count, 5);
  assert.strictEqual(vm.updatedAt, '2026-07-01T12:00:00.000Z');
  assert.strictEqual(vm.columns.length, 5);
  assert.deepStrictEqual(vm.columns[0], { key: 'merchant', label: 'Merchant', type: 'text', required: true });
});

test('summarizeFieldSpec: null input never throws, safe defaults', () => {
  const vm = summarizeFieldSpec(null);
  assert.deepStrictEqual(vm.columns, []);
  assert.strictEqual(vm.count, 0);
  assert.strictEqual(vm.accountId, null);
  assert.strictEqual(vm.updatedAt, null);
});

test('summarizeFieldSpec: undefined input never throws, safe defaults', () => {
  const vm = summarizeFieldSpec(undefined);
  assert.deepStrictEqual(vm.columns, []);
  assert.strictEqual(vm.count, 0);
});

test('summarizeFieldSpec: garbage input (string/number/array) never throws', () => {
  assert.doesNotThrow(() => summarizeFieldSpec('garbage'));
  assert.doesNotThrow(() => summarizeFieldSpec(42));
  assert.doesNotThrow(() => summarizeFieldSpec([1, 2, 3]));
  const vm = summarizeFieldSpec('garbage');
  assert.deepStrictEqual(vm.columns, []);
  assert.strictEqual(vm.count, 0);
});

test('summarizeFieldSpec: columns not an array -> empty columns, no throw', () => {
  const vm = summarizeFieldSpec({ account_id: 'a', columns: 'nope', updated_at: null });
  assert.deepStrictEqual(vm.columns, []);
  assert.strictEqual(vm.count, 0);
});

test('summarizeFieldSpec: garbage entries inside columns array are tolerated', () => {
  const vm = summarizeFieldSpec({
    account_id: 'a',
    columns: [null, 42, { key: 'merchant', label: 'Merchant', type: 'text', required: true }, 'x'],
    updated_at: null,
  });
  assert.strictEqual(vm.count, 4);
  // Every entry is present in the view model (render decides how to show junk),
  // but each is shape-safe (never throws while building).
  assert.strictEqual(vm.columns.length, 4);
  assert.strictEqual(vm.columns[2].key, 'merchant');
});

// --- errorMessage -----------------------------------------------------------

test('errorMessage: 400 with a real body.error string returns it verbatim (reject-and-explain)', () => {
  const msg = errorMessage(400, { error: 'parseTemplate: missing header X' }, 'save');
  assert.strictEqual(msg, 'parseTemplate: missing header X');
});

test('errorMessage: 400 with the "provide CSV text" message returns it verbatim', () => {
  const raw = 'provide CSV text (text/csv body, or JSON {"csv": "..."})';
  assert.strictEqual(errorMessage(400, { error: raw }, 'save'), raw);
});

test('errorMessage: 400 with non-string body.error -> generic message', () => {
  const msg = errorMessage(400, { error: 42 }, 'save');
  assert.match(msg, /try again/i);
});

test('errorMessage: 400 with missing body.error -> generic message', () => {
  const msg = errorMessage(400, {}, 'save');
  assert.match(msg, /try again/i);
  const msg2 = errorMessage(400, null, 'load');
  assert.match(msg2, /try again/i);
});

test('errorMessage: 502 -> fixed generic message per context (save)', () => {
  const msg = errorMessage(502, { error: 'save failed' }, 'save');
  assert.match(msg, /could not save/i);
  assert.doesNotMatch(msg, /save failed/); // body text ignored for 502, generic only
});

test('errorMessage: 502 -> fixed generic message per context (load)', () => {
  const msg = errorMessage(502, { error: 'load failed' }, 'load');
  assert.match(msg, /could not load/i);
});

test('errorMessage: other/unknown status -> generic message per context, no internals', () => {
  const msg = errorMessage(500, { error: 'Error: ECONNREFUSED at /var/app/x.js:1' }, 'save');
  assert.doesNotMatch(msg, /ECONNREFUSED/);
  assert.doesNotMatch(msg, /\/var\/app/);
  assert.match(msg, /try again|could not/i);
});

test('errorMessage: never throws on garbage body (array, string, number)', () => {
  assert.doesNotThrow(() => errorMessage(400, ['a', 'b'], 'save'));
  assert.doesNotThrow(() => errorMessage(400, 'oops', 'save'));
  assert.doesNotThrow(() => errorMessage(400, 42, 'save'));
  assert.doesNotThrow(() => errorMessage(undefined, undefined, undefined));
});

test('a hostile body.error is inert once routed through Escape.safeText (defense in depth)', () => {
  // Server-sanitized already (per contract), but the render layer must escape
  // anyway (Iron rule). Prove a hostile value would be neutralised.
  const hostile = 'parseTemplate: bad header <script>alert(1)</script>';
  const msg = errorMessage(400, { error: hostile }, 'save');
  assert.strictEqual(msg, hostile); // errorMessage itself does not mutate/escape
  const safe = Escape.safeText(msg);
  assert.doesNotMatch(safe, /<script>/);
});
