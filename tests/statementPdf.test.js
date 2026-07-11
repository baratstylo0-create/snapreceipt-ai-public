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
const { statementToPdf, sortRowsByDate } = require('../lib/statementPdf');
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

test('E3 regression: statement PDF embeds receipt images as evidence pages', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const { buffer, pages, skippedReceipts } = await statementToPdf(model, {
    receipts: { e1: { buffer: tinyPng(), ext: 'png' }, e2: { buffer: tinyPng(), ext: 'png' } },
  });
  assert.strictEqual(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.strictEqual(pages, base + 2);
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

test('every receipted row still appends its page, regardless of statement-line vs date order', async () => {
  // e1 (Food) and e2 (Tickets); both PNG → 2 appended pages after the statement, no skips
  const { pages, skippedReceipts } = await statementToPdf(model, {
    receipts: { e1: { buffer: tinyPng(), ext: 'png' }, e2: { buffer: tinyPng(), ext: 'jpg' && 'png' } },
  });
  const base = (await statementToPdf(model, {})).pages;
  assert.strictEqual(pages, base + 2);
  assert.strictEqual(skippedReceipts, 0);
});

// --- Photo appendix DATE ordering (all-branches export follow-up) ------------------------
// The PDF renderer's page-by-page pixel content isn't practically introspectable in a unit
// test, so the actual reordering logic is exported as a pure function (sortRowsByDate) and
// tested directly here — this is what statementToPdf calls before rasterising the appendix.

test('sortRowsByDate: photo appendix comes out in DATE order, not statement-line (category) order', () => {
  // Statement-line order (category order) puts the LATEST date first here — date order must
  // reorder to strictly chronological, independent of which category each row belongs to.
  const statementLineOrder = [
    { expenseId: 'e3', date: '2025-10-05' }, // e.g. Hotel category, but the LATEST date
    { expenseId: 'e1', date: '2025-10-01' }, // Food category, EARLIEST date
    { expenseId: 'e2', date: '2025-10-03' }, // Tickets category, middle date
  ];
  const sorted = sortRowsByDate(statementLineOrder);
  assert.deepStrictEqual(sorted.map((r) => r.expenseId), ['e1', 'e2', 'e3'], 'chronological, independent of input order');
  // Original array is untouched (sort must not mutate statement-body rows).
  assert.deepStrictEqual(statementLineOrder.map((r) => r.expenseId), ['e3', 'e1', 'e2']);
});

test('sortRowsByDate: same-date rows tie-break on expenseId for a stable, deterministic order', () => {
  const rows = [
    { expenseId: 'zeta', date: '2025-10-01' },
    { expenseId: 'alpha', date: '2025-10-01' },
    { expenseId: 'mid', date: '2025-10-01' },
  ];
  assert.deepStrictEqual(sortRowsByDate(rows).map((r) => r.expenseId), ['alpha', 'mid', 'zeta']);
});

test('sortRowsByDate: rows with no date sort first (empty string), never throws on garbage', () => {
  const rows = [{ expenseId: 'e2', date: '2025-10-01' }, { expenseId: 'e1', date: '' }, {}];
  const sorted = sortRowsByDate(rows);
  // Both e1 (date '') and {} (no date -> '') tie on date '', so they land before e2 (dated),
  // tie-broken between themselves by expenseId — {} has none (-> ''), which sorts before 'e1'.
  assert.deepStrictEqual(sorted.map((r) => r.expenseId), [undefined, 'e1', 'e2']);
  assert.deepStrictEqual(sortRowsByDate([]), []);
});

// --- Receipt Evidence mode (opts.receiptEvidence) ---------------------------------------------
// Opt-in per caller: routes/statement.js turns this on; manageExport.js (and every test above,
// which never passes the flag) must see byte-for-byte the same plain-image behavior as before.

test('receiptEvidence OFF (default): behaves exactly like before this feature — no extra pages', async () => {
  const withoutFlag = await statementToPdf(model, { receipts: { e1: { buffer: tinyPng(), ext: 'png' } } });
  const withExplicitFalse = await statementToPdf(model, { receipts: { e1: { buffer: tinyPng(), ext: 'png' } }, receiptEvidence: false });
  assert.strictEqual(withoutFlag.pages, withExplicitFalse.pages);
});

test('receiptEvidence ON: expenses with NO receipt are omitted from the compilation (no placeholder pages) and collected onto ONE "not attached" summary page', async () => {
  const base = (await statementToPdf(model, {})).pages; // statement only, no appendix
  // model has 2 expenses (e1, e2) and neither has a receipt -> 0 image pages + 1 summary page.
  const { pages, skippedReceipts } = await statementToPdf(model, { receiptEvidence: true });
  assert.strictEqual(pages, base + 1, 'no per-expense placeholder pages — just one summary page listing the missing ones');
  assert.strictEqual(skippedReceipts, 0, 'a never-uploaded receipt is not a "skip"');
});

test('receiptEvidence ON: real receipts each get an image page; missing ones only add the single summary page (once)', async () => {
  const base = (await statementToPdf(model, {})).pages; // statement-only, no appendix at all
  // e1 real image (1 page) + e2 missing (0 pages, triggers the one summary page) = base + 2
  const oneReal = await statementToPdf(model, { receiptEvidence: true, receipts: { e1: { buffer: tinyPng(), ext: 'png' } } });
  assert.strictEqual(oneReal.pages, base + 2, '1 image page + 1 summary page');
  // both real -> 2 image pages, and NO summary page because nothing is missing
  const bothReal = await statementToPdf(model, { receiptEvidence: true, receipts: { e1: { buffer: tinyPng(), ext: 'png' }, e2: { buffer: tinyPng(), ext: 'png' } } });
  assert.strictEqual(bothReal.pages, base + 2, '2 image pages, no summary page when nothing is missing');
});

test('receiptEvidence ON: an unreadable/unsupported receipt is omitted (still counted) and listed on the summary page, never a placeholder page', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const { pages, skippedReceipts } = await statementToPdf(model, {
    receiptEvidence: true,
    receipts: { e1: { buffer: Buffer.from('RIFFxxxxWEBP'), ext: 'webp' } },
  });
  // e1 unreadable (no image page, counted) + e2 missing = 0 image pages + 1 summary page.
  assert.strictEqual(pages, base + 1);
  assert.strictEqual(skippedReceipts, 1, 'the webp is still counted as skipped for diagnostics');
});

test('receiptEvidence ON: a real image receipt still renders fine (no crash), same page arithmetic as plain mode', async () => {
  const base = (await statementToPdf(model, {})).pages;
  const { pages, skippedReceipts } = await statementToPdf(model, {
    receiptEvidence: true,
    receipts: { e1: { buffer: tinyPng(), ext: 'png' }, e2: { buffer: tinyPng(), ext: 'png' } },
  });
  assert.strictEqual(pages, base + 2);
  assert.strictEqual(skippedReceipts, 0);
});
