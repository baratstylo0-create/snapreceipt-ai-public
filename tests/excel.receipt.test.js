'use strict';
// lib/excel.js Phase 3 (ADR-021/ADR-018): the export can embed the receipt image per row (a
// display-scaled thumbnail via exceljs addImage) with a hyperlink to full-res, plus a "links-only"
// mode for very large exports. Opt-in via opts.receipts/opts.receiptLinks so existing 2/3-arg
// callers are unchanged. NOT flag-gated — this applies to personal exports too (only Branch/Staff
// are business-only).
const test = require('node:test');
const assert = require('node:assert');
const { buildWorkbook } = require('../lib/excel');

// A real 1x1 PNG (valid magic bytes so exceljs accepts it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const FIELD_SPEC = { columns: [
  { key: 'merchant', label: 'Vendor', type: 'text' },
  { key: 'amount', label: 'Total', type: 'currency' },
] };
const HEADER_ROW = 2;
function headerRow(wb) {
  const ws = wb.worksheets[0]; const out = [];
  for (let i = 1; i <= ws.columnCount; i++) out.push(ws.getRow(HEADER_ROW).getCell(i).value);
  return out;
}

test('embed: a row with image bytes gets a Receipt column + an embedded image', () => {
  const wb = buildWorkbook([{ id: 'e1', merchant: 'Cafe', amount: 10 }], FIELD_SPEC,
    { receipts: { e1: { buffer: PNG, ext: 'png' } } });
  const ws = wb.worksheets[0];
  assert.strictEqual(headerRow(wb).at(-1), 'Receipt');
  assert.strictEqual(ws.getImages().length, 1, 'one image embedded');
});

test('links-only mode: Receipt cell is a hyperlink, no embedded image', () => {
  const wb = buildWorkbook([{ id: 'e1', merchant: 'Cafe', amount: 10 }], FIELD_SPEC,
    { receipts: { e1: { buffer: PNG, ext: 'png' } }, receiptLinks: { e1: 'https://app/receipt/e1' }, embedReceipts: false });
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getImages().length, 0, 'no image in links-only mode');
  assert.strictEqual(ws.getRow(3).getCell(ws.columnCount).value.hyperlink, 'https://app/receipt/e1');
});

test('embed: blank Receipt cell when a row has neither bytes nor link', () => {
  const wb = buildWorkbook([{ id: 'e1', merchant: 'Cafe', amount: 10 }], FIELD_SPEC,
    { receipts: {}, receiptLinks: {} });
  const ws = wb.worksheets[0];
  assert.strictEqual(headerRow(wb).at(-1), 'Receipt', 'column present once the feature is enabled');
  assert.strictEqual(ws.getRow(3).getCell(ws.columnCount).value, null);
  assert.strictEqual(ws.getImages().length, 0);
});

test('embed: a non-embeddable type (pdf) falls back to the hyperlink, no image', () => {
  const wb = buildWorkbook([{ id: 'e1', merchant: 'X', amount: 1 }], FIELD_SPEC,
    { receipts: { e1: { buffer: Buffer.from('%PDF-1.4 ...'), ext: 'pdf' } }, receiptLinks: { e1: 'https://app/r/e1' } });
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getImages().length, 0);
  assert.strictEqual(ws.getRow(3).getCell(ws.columnCount).value.hyperlink, 'https://app/r/e1');
});

test('embed: no receipt opts -> no Receipt column (existing exports unchanged)', () => {
  const wb = buildWorkbook([{ merchant: 'Cafe', amount: 10 }], FIELD_SPEC);
  assert.ok(!headerRow(wb).includes('Receipt'));
});

test('embed: Branch/Staff AND Receipt columns coexist in the right order', () => {
  const wb = buildWorkbook([{ id: 'e1', merchant: 'Cafe', amount: 10, branch_id: 'bA' }], FIELD_SPEC,
    { branchStaff: true, branchNames: { bA: 'KL' }, receipts: { e1: { buffer: PNG, ext: 'png' } } });
  assert.deepStrictEqual(headerRow(wb), ['Vendor', 'Total', 'Branch', 'Staff', 'Receipt']);
});
