'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTemplate, getFieldSpec, saveTemplate, DEFAULT_COLUMNS } = require('../lib/templates');

// getFieldSpec's happy path (a real stored template) is exercised by a live
// round-trip at wire-up (see WORKLOG) rather than here. The two branch cases
// below (no template / malformed template -> DEFAULT_COLUMNS) ARE hermetic:
// stub global.fetch so no network call happens, same pattern as currency.test.js.
function stubFetchRows(rows) {
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify(rows) });
  return () => { global.fetch = realFetch; };
}

test('getFieldSpec falls back to DEFAULT_COLUMNS when the account has no stored template', async () => {
  const restore = stubFetchRows([]); // Supabase REST returns [] when no row matches
  try {
    const spec = await getFieldSpec('no-such-account');
    assert.strictEqual(spec.account_id, 'no-such-account');
    assert.strictEqual(spec.updated_at, null);
    assert.deepStrictEqual(spec.columns, DEFAULT_COLUMNS);
  } finally { restore(); }
});

test('getFieldSpec falls back to DEFAULT_COLUMNS when the stored columns are malformed', async () => {
  const restore = stubFetchRows([{ columns: [{ key: 'merchant' /* missing label/type/required */ }], updated_at: '2026-01-01T00:00:00Z' }]);
  try {
    const spec = await getFieldSpec('acct');
    assert.deepStrictEqual(spec.columns, DEFAULT_COLUMNS);
    assert.strictEqual(spec.updated_at, null);
  } finally { restore(); }
});

test('getFieldSpec keeps only the valid columns from a partially malformed stored row', async () => {
  const good = { key: 'merchant', label: 'Vendor', type: 'text', required: true };
  const bad = { key: 'oops', label: 'Bad', type: 'not-a-real-type', required: true };
  const restore = stubFetchRows([{ columns: [good, bad], updated_at: '2026-01-01T00:00:00Z' }]);
  try {
    const spec = await getFieldSpec('acct');
    assert.deepStrictEqual(spec.columns, [good]);
    assert.strictEqual(spec.updated_at, '2026-01-01T00:00:00Z');
  } finally { restore(); }
});

test('maps common headers to canonical keys, types, and required flags', () => {
  const cols = parseTemplate('Vendor,Date,Grand Total,Currency,Category');
  assert.deepStrictEqual(cols, [
    { key: 'merchant',     label: 'Vendor',     type: 'text',     required: true },
    { key: 'expense_date', label: 'Date',       type: 'date',     required: true },
    { key: 'amount',       label: 'Grand Total', type: 'currency', required: true },
    { key: 'currency',     label: 'Currency',   type: 'text',     required: false },
    { key: 'category',     label: 'Category',   type: 'category', required: false },
  ]);
});

test('P6 hardening: strips C0/C1 control chars from a label (parse-side of issue #17)', () => {
  // A hostile CSV header with NUL, ESC, DEL and a C1 byte embedded in the label.
  const hostile = 'Ven\u0000\u001b\u007f\u009fdor';
  const [col] = parseTemplate(hostile + ',Amount');
  assert.strictEqual(col.label, 'Vendor');          // control bytes removed, visible text kept
  assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(col.label), 'no control chars survive into the stored label');
  assert.strictEqual(col.key, 'merchant');          // still maps to the canonical key
});

test('keeps unknown headers verbatim as free-text columns with a safe key', () => {
  const cols = parseTemplate('Project Code,Cost Center #2');
  assert.deepStrictEqual(cols, [
    { key: 'project_code',   label: 'Project Code',   type: 'text', required: false },
    { key: 'cost_center_2',  label: 'Cost Center #2', type: 'text', required: false },
  ]);
});

test('preserves the exact customer label while canonicalising the key (case/space-insensitive)', () => {
  const [c] = parseTemplate('  MERCHANT NAME  ');
  // "merchant name" is not an exact canonical alias -> free text, but label kept verbatim (trimmed)
  assert.strictEqual(c.label, 'MERCHANT NAME');
  assert.strictEqual(c.key, 'merchant_name');
  // exact alias still canonicalises regardless of case/whitespace:
  const [m] = parseTemplate('  vEnDoR ');
  assert.strictEqual(m.key, 'merchant');
  assert.strictEqual(m.label, 'vEnDoR');
});

test('dedupes headers that map to the same canonical key (first wins)', () => {
  const cols = parseTemplate('Total,Amount,Vendor');
  assert.deepStrictEqual(cols.map(c => c.key), ['amount', 'merchant']);
  assert.strictEqual(cols[0].label, 'Total'); // first claimant keeps the slot
});

test('handles quoted headers with embedded commas and escaped quotes', () => {
  const cols = parseTemplate('"Merchant, Inc","Say ""Hi"""');
  assert.strictEqual(cols[0].label, 'Merchant, Inc');
  assert.strictEqual(cols[0].key, 'merchant_inc');
  assert.strictEqual(cols[1].label, 'Say "Hi"');
});

test('strips a UTF-8 BOM and ignores blank leading lines / trailing columns', () => {
  const cols = parseTemplate('﻿\nVendor,,Date,\nrow1,x,2026-01-01,y');
  assert.deepStrictEqual(cols.map(c => c.key), ['merchant', 'expense_date']);
  assert.strictEqual(cols[0].label, 'Vendor'); // BOM stripped, not part of label
});

test('rejects invalid input', () => {
  assert.throws(() => parseTemplate(''), /no header row/);
  assert.throws(() => parseTemplate('   \n  '), /no header row/);
  assert.throws(() => parseTemplate(42), /must be a string/);
  const tooMany = Array.from({ length: 101 }, (_, i) => 'h' + i).join(',');
  assert.throws(() => parseTemplate(tooMany), /too many columns/);
});

test('DEFAULT_COLUMNS is a valid FieldSpec.columns shape', () => {
  assert.ok(Array.isArray(DEFAULT_COLUMNS) && DEFAULT_COLUMNS.length > 0);
  const types = new Set(['text', 'date', 'number', 'currency', 'category']);
  for (const c of DEFAULT_COLUMNS) {
    assert.strictEqual(typeof c.key, 'string');
    assert.strictEqual(typeof c.label, 'string');
    assert.ok(types.has(c.type), 'valid type: ' + c.type);
    assert.strictEqual(typeof c.required, 'boolean');
  }
});

test('exports the frozen contract functions', () => {
  assert.strictEqual(typeof parseTemplate, 'function');
  assert.strictEqual(typeof getFieldSpec, 'function');
  assert.strictEqual(typeof saveTemplate, 'function');
});
