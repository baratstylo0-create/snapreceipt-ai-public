'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTemplate, getFieldSpec, saveTemplate, DEFAULT_COLUMNS } = require('../lib/templates');

// Note: getFieldSpec/saveTemplate hit Supabase and are exercised by a live
// round-trip at wire-up (see WORKLOG), not here — CI stays hermetic (no network).
// These tests cover parseTemplate (pure) + the module's exported contract.

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
