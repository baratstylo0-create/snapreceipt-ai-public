'use strict';
// lib/statementPdf.js — Phase 10 (ADR-024 pdfkit). Renders a StatementModel to a PDF: the
// statement page(s) first, then each expense's receipt appended in statement-line order (image → 1
// page; PDF → one page per source page via lib/pdf.rasterizePdf). Missing/unreadable receipts are
// skipped + counted, never fatal. Tests assert STRUCTURE (magic bytes, page arithmetic, skip
// counting) — the Owner does the final visual diff vs the client sample.
const test = require('node:test');
const assert = require('node:assert');
const PDFDocument = require('pdfkit');
const { buildStatementModel } = require('../lib/statement');
const { statementToPdf } = require('../lib/statementPdf');
const { rgbaToPng } = require('../lib/pdf');

function tinyPng() { return rgbaToPng(Buffer.alloc(2 * 2 * 4, 0xff), 2, 2); }
function makePdf(nPages) {
  return new Promise((resolve) => {
    const d = new PDFDocument({ size: 'A4' });
    const ch = [];
    d.on('data', (c) => ch.push(c));
    d.on('end', () => resolve(Buffer.concat(ch)));
    for (let i = 0; i < nPages; i++) { if (i) d.addPage(); d.text('page ' + i); }
    d.end();
  });
}

const model = buildStatementModel({
  companyName: 'Placeholder Trading Sdn Bhd', branchLabel: 'HQ', preparedBy: 'Aisha', period: '2025-10',
  categories: ['Tickets', 'Hotel', 'Food'], currency: 'MYR', showStaffColumn: true,
  balanceBf: 3000,
  expenses: [
    { id: 'e1', amount: 10.10, category: 'Food', expense_date: '2025-10-01', merchant: 'Cafe', staff_user_id: 'u1' },
    { id: 'e2', amount: 20.20, category: 'Tickets', expense_date: '2025-10-02', merchant: 'Grab', staff_user_id: 'u1' },
  ],
  staffNames: { u1: 'Farid' },
  signoff: { prepared: true, checked: false, approved: true },
});

test('statement-only PDF: starts with %PDF-, >=1 page, zero skipped', async () => {
  const { buffer, pages, skippedReceipts } = await statementToPdf(model, {});
  assert.strictEqual(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pages >= 1);
  assert.strictEqual(skippedReceipts, 0);
});

test('an image receipt appends exactly one page', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const { pages, skippedReceipts } = await statementToPdf(model, { receipts: { e1: { buffer: tinyPng(), ext: 'png' } } });
  assert.strictEqual(pages, base + 1);
  assert.strictEqual(skippedReceipts, 0);
});

test('a multi-page PDF receipt expands to one page per source page', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const threePage = await makePdf(3);
  const { pages, skippedReceipts } = await statementToPdf(model, { receipts: { e1: { buffer: threePage, ext: 'pdf' } } });
  assert.strictEqual(pages, base + 3, 'three source pages → three appended pages');
  assert.strictEqual(skippedReceipts, 0);
});

test('an unreadable/unsupported receipt is skipped and counted (never fatal)', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const { pages, skippedReceipts } = await statementToPdf(model, {
    receipts: {
      e1: { buffer: Buffer.from('not a real pdf'), ext: 'pdf' }, // rasterize fails
      e2: { buffer: Buffer.from('RIFFxxxxWEBP'), ext: 'webp' },  // pdfkit can't embed webp
    },
  });
  assert.strictEqual(pages, base, 'no pages added for unusable receipts');
  assert.strictEqual(skippedReceipts, 2);
});

test('receipts append in statement-line order', async () => {
  // e1 (Food) and e2 (Tickets); both PNG → 2 appended pages after the statement, no skips
  const { pages, skippedReceipts } = await statementToPdf(model, {
    receipts: { e1: { buffer: tinyPng(), ext: 'png' }, e2: { buffer: tinyPng(), ext: 'jpg' && 'png' } },
  });
  const base = (await statementToPdf(model, {})).pages;
  assert.strictEqual(pages, base + 2);
  assert.strictEqual(skippedReceipts, 0);
});
