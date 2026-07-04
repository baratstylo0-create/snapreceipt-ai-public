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
const { buildCsvHeader, namedFields, canSaveBuilder } = Templates;

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

// --- visual field builder (Task E, additive) --------------------------------
// Lets a customer with no CSV know-how build the field list visually: a list of
// {name, type, required} rows -> a CSV header row -> the SAME POST /api/templates
// path the paste/upload flow already uses (buildImportBody). Read from
// lib/templates.js's parseTemplate: a header-only CSV can only carry field
// NAMES — type/required on the resulting FieldSpec column come from parseTemplate's
// CANON dictionary match (or default text/not-required for unrecognised names),
// never from anything the client sends. So type/required here are UI intent only;
// they do not reliably round-trip. buildCsvHeader only ever emits names.

// --- namedFields (pure filter: drop blank/garbage rows) --------------------

test('namedFields: keeps rows with a non-blank name, drops blank/whitespace-only names', () => {
  const rows = [
    { name: 'Vendor', type: 'text', required: true },
    { name: '', type: 'text', required: false },
    { name: '   ', type: 'text', required: false },
    { name: 'Total', type: 'currency', required: true },
  ];
  const kept = namedFields(rows);
  assert.deepStrictEqual(kept.map(r => r.name), ['Vendor', 'Total']);
});

test('namedFields: never throws on garbage input (non-array, null entries, non-string name)', () => {
  assert.doesNotThrow(() => namedFields(null));
  assert.doesNotThrow(() => namedFields(undefined));
  assert.doesNotThrow(() => namedFields('garbage'));
  assert.doesNotThrow(() => namedFields(42));
  assert.deepStrictEqual(namedFields(null), []);
  assert.deepStrictEqual(namedFields(undefined), []);
  assert.deepStrictEqual(namedFields('garbage'), []);
  const kept = namedFields([null, undefined, 42, 'x', { name: 42 }, { name: null }, { name: 'OK' }]);
  assert.deepStrictEqual(kept.map(r => r.name), ['OK']);
});

// --- buildCsvHeader ----------------------------------------------------------

test('buildCsvHeader: plain names -> comma-joined header row', () => {
  assert.strictEqual(
    buildCsvHeader([{ name: 'Vendor' }, { name: 'Total' }, { name: 'Project Code' }]),
    'Vendor,Total,Project Code'
  );
});

test('buildCsvHeader: skips blank-name rows', () => {
  assert.strictEqual(
    buildCsvHeader([{ name: 'Vendor' }, { name: '' }, { name: '   ' }, { name: 'Total' }]),
    'Vendor,Total'
  );
});

test('buildCsvHeader: a name containing a comma is quoted', () => {
  assert.strictEqual(buildCsvHeader([{ name: 'Last, First' }]), '"Last, First"');
});

test('buildCsvHeader: a name containing a double quote is quoted and internal quotes doubled', () => {
  assert.strictEqual(buildCsvHeader([{ name: 'Say "Hi"' }]), '"Say ""Hi"""');
});

test('buildCsvHeader: a name containing a newline is quoted', () => {
  assert.strictEqual(buildCsvHeader([{ name: 'Line1\nLine2' }]), '"Line1\nLine2"');
});

test('buildCsvHeader: mixed plain + quoted names', () => {
  assert.strictEqual(
    buildCsvHeader([{ name: 'Vendor' }, { name: 'Amount, Total' }, { name: 'Notes' }]),
    'Vendor,"Amount, Total",Notes'
  );
});

test('buildCsvHeader: empty list -> empty string (defined sentinel: "" means nothing to save)', () => {
  assert.strictEqual(buildCsvHeader([]), '');
  assert.strictEqual(buildCsvHeader([{ name: '' }]), '');
});

test('buildCsvHeader: never throws on garbage input (non-array, null entries, non-string name)', () => {
  assert.doesNotThrow(() => buildCsvHeader(null));
  assert.doesNotThrow(() => buildCsvHeader(undefined));
  assert.doesNotThrow(() => buildCsvHeader('garbage'));
  assert.doesNotThrow(() => buildCsvHeader(42));
  assert.doesNotThrow(() => buildCsvHeader([null, undefined, 42, { name: 42 }, {}]));
  assert.strictEqual(buildCsvHeader(null), '');
  assert.strictEqual(buildCsvHeader(undefined), '');
  assert.strictEqual(buildCsvHeader('garbage'), '');
});

test('buildCsvHeader: a hostile field name is carried through as plain CSV text (not HTML) — ' +
  'escaping is the render layer\'s job, not the CSV builder\'s', () => {
  const hostile = '<script>alert(1)</script>';
  assert.strictEqual(buildCsvHeader([{ name: hostile }]), hostile);
});

// --- canSaveBuilder (pure validation: at least one named field to enable Save) ---

test('canSaveBuilder: false for an empty list', () => {
  assert.strictEqual(canSaveBuilder([]), false);
});

test('canSaveBuilder: false when every row has a blank name', () => {
  assert.strictEqual(canSaveBuilder([{ name: '' }, { name: '   ' }]), false);
});

test('canSaveBuilder: true when at least one row has a non-blank name', () => {
  assert.strictEqual(canSaveBuilder([{ name: '' }, { name: 'Vendor' }]), true);
});

test('canSaveBuilder: never throws on garbage input', () => {
  assert.doesNotThrow(() => canSaveBuilder(null));
  assert.doesNotThrow(() => canSaveBuilder(undefined));
  assert.doesNotThrow(() => canSaveBuilder('garbage'));
  assert.strictEqual(canSaveBuilder(null), false);
  assert.strictEqual(canSaveBuilder(undefined), false);
});

// --- builder -> buildImportBody integration (same POST path as paste/upload) ---

test('buildCsvHeader output feeds buildImportBody exactly like pasted CSV text', () => {
  const header = buildCsvHeader([{ name: 'Vendor' }, { name: 'Total' }]);
  const built = buildImportBody(header, 'my-template');
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.csv, 'Vendor,Total');
  assert.strictEqual(built.name, 'my-template');
});

test('an empty builder header (no named fields) -> buildImportBody reports {ok:false, reason:"empty"}, matching the paste-empty-textarea case', () => {
  const header = buildCsvHeader([{ name: '' }, { name: '   ' }]);
  assert.deepStrictEqual(buildImportBody(header, 'x'), { ok: false, reason: 'empty' });
});

test('a hostile field name survives buildCsvHeader -> buildImportBody as inert plain text, and is neutralised at render time via Escape.safeText (mirrors the FieldSpec-echo XSS pattern)', () => {
  const hostile = '<script>alert(1)</script>';
  const header = buildCsvHeader([{ name: hostile }]);
  const built = buildImportBody(header, 'default');
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.csv, hostile);
  // Mirrors how the saved FieldSpec would later be echoed back through renderFieldSpecTable,
  // which routes every column label through Escape.setText — never innerHTML.
  const safe = Escape.safeText(built.csv);
  assert.doesNotMatch(safe, /<script>/);
  assert.strictEqual(safe, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

// --- fieldDisplayName (human-readable field names for non-technical staff) ---
test('fieldDisplayName: prefers the human label', () => {
  assert.strictEqual(Templates.fieldDisplayName({ key: 'merchant', label: 'Merchant' }), 'Merchant');
});
test('fieldDisplayName: prettifies a bare machine key (no raw snake_case shown)', () => {
  assert.strictEqual(Templates.fieldDisplayName({ key: 'and_how_much' }), 'And how much');
  assert.strictEqual(Templates.fieldDisplayName({ key: 'which_category-do_i' }), 'Which category do i');
});
test('fieldDisplayName: empty/garbage never throws, returns ""', () => {
  assert.strictEqual(Templates.fieldDisplayName(null), '');
  assert.strictEqual(Templates.fieldDisplayName({}), '');
});
