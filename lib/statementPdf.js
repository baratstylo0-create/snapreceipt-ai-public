'use strict';
// lib/statementPdf.js — Phase 10 (ADR-024 pdfkit; pure-JS, no native binary). Renders a
// StatementModel (lib/statement.js) to a PDF: the statement page(s) drawn to match §2b, then each
// expense's receipt appended in statement-line order. Image receipt → 1 page; PDF receipt → one
// page per source page (rasterised via lib/pdf.rasterizePdf, reusing the existing pdfium wrapper +
// its PDF_MAX_RENDER_PIXELS bomb guard — never re-wrap pdfium). Missing/unreadable receipts are
// skipped + counted, never fatal. Returns { buffer, pages, skippedReceipts }. NO PII in logs.
const PDFDocument = require('pdfkit');
const { rasterizePdf } = require('./pdf');

// §2b palette (hex for pdfkit fillColor/strokeColor).
const RED = '#CC0000';
const BLUE = '#0000CC';
const BLACK = '#000000';
const GREY = '#E8E8E8';
const YELLOW = '#FFFF00';
const GREEN = '#92D050';

const MARGIN = 40;
const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const PAGE_BOTTOM = PAGE_H - MARGIN;
const ROW_H = 15;

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Build the column geometry (x/width per key) for the current model flags.
function columns(showStaff, hasCur2) {
  const cols = [];
  let x = MARGIN;
  const push = (key, w, align) => { cols.push({ key, x, w, align: align || 'left' }); x += w; };
  push('item', 32, 'center');
  push('date', 66);
  if (showStaff) push('name', 74);
  const fixed = 32 + 66 + (showStaff ? 74 : 0) + 88 + (hasCur2 ? 88 : 0);
  push('desc', CONTENT_W - fixed);
  push('amount', 88, 'right');
  if (hasCur2) push('amount2', 88, 'right');
  return cols;
}

function statementToPdf(model, opts = {}) {
  const m = model || {};
  const receipts = (opts && opts.receipts) || null;

  // Flatten expense rows in statement-line order (Section B, category order, row order).
  const rows = [];
  for (const cat of (m.sectionB && m.sectionB.categories) || []) {
    for (const row of cat.rows) rows.push(row);
  }

  // Pre-rasterise receipts (async) BEFORE the synchronous drawing pass, so the doc build is linear.
  return (async () => {
    let skippedReceipts = 0;
    const receiptPages = []; // ordered list of image buffers (each becomes one appended page)
    for (const row of rows) {
      const rec = receipts && row.expenseId != null ? receipts[row.expenseId] : null;
      if (!rec || !rec.buffer) continue; // no receipt attached to this row — nothing to append
      const ext = String(rec.ext || '').toLowerCase();
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
        receiptPages.push(rec.buffer);
      } else if (ext === 'pdf') {
        try {
          const { pages } = await rasterizePdf(rec.buffer);
          if (pages && pages.length) pages.forEach((p) => receiptPages.push(p));
          else skippedReceipts += 1;
        } catch (e) {
          console.error('[statement pdf receipt]', e.message); // message only — no bytes/PII
          skippedReceipts += 1;
        }
      } else {
        skippedReceipts += 1; // webp/gif/bin — pdfkit can't embed; skip + count
      }
    }

    return await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
      // Count pages ourselves: the constructor creates page 1, then every addPage fires 'pageAdded'.
      // (doc.bufferedPageRange() is emptied on flush/end, so it can't be read after doc.end().)
      let pageCount = 1;
      doc.on('pageAdded', () => { pageCount += 1; });
      const chunks = [];
      doc.on('data', (d) => chunks.push(d));
      doc.on('error', reject);
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages: pageCount, skippedReceipts }));

      try {
        drawStatement(doc, m);
        for (const img of receiptPages) {
          doc.addPage();
          // fit inside the content box, aspect preserved, top-aligned, centred horizontally (§3)
          try {
            doc.image(img, MARGIN, MARGIN, { fit: [CONTENT_W, PAGE_H - 2 * MARGIN], align: 'center', valign: 'top' });
          } catch (e) {
            console.error('[statement pdf image]', e.message);
          }
        }
        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  })();
}

function drawStatement(doc, m) {
  const showStaff = !!m.showStaffColumn;
  const hasCur2 = m.currency2 != null && m.currency2 !== '';
  const cols = columns(showStaff, hasCur2);

  // ---- title block ----
  let y = MARGIN;
  doc.font('Times-Bold').fontSize(16).fillColor(RED).text(m.companyName || '', MARGIN, y, { width: CONTENT_W, align: 'center' });
  y += 22;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(BLACK).text(m.title || '', MARGIN, y, { width: CONTENT_W, align: 'center' });
  y += 18;
  doc.fontSize(11).text(m.periodLabel || '', MARGIN, y, { width: CONTENT_W, align: 'center' });
  y += 16;
  doc.font('Helvetica').fontSize(9)
    .text('Branch: ' + (m.branchLabel || ''), MARGIN, y, { width: CONTENT_W / 2, align: 'left', continued: false });
  doc.text('Prepared by: ' + (m.preparedBy || ''), MARGIN + CONTENT_W / 2, y, { width: CONTENT_W / 2, align: 'right' });
  y += 22;

  const ctx = { doc, cols, y };

  // ---- Section A ----
  ctx.y = sectionHeading(ctx, 'A.  SUMMARY OF CASH IN');
  ctx.y = tableRow(ctx, headerCells('A', m), { fill: GREY, bold: true });
  for (const row of (m.sectionA && m.sectionA.rows) || []) {
    ctx.y = tableRow(ctx, { date: row.date || '', desc: row.description || '', amount: money(row.amount), amount2: hasCur2 ? money(row.amount2) : '' });
  }
  ctx.y = tableRow(ctx, { desc: 'TOTAL', amount: money(m.sectionA ? m.sectionA.total : 0), amount2: hasCur2 ? money(m.sectionA && m.sectionA.total2) : '' }, { bold: true });
  ctx.y += 8;

  // ---- Section B ----
  ctx.y = sectionHeading(ctx, 'B.  SUMMARY OF EXPENSES: (' + (m.branchLabel || '') + ')');
  const bHeader = headerCells('B', m);
  ctx.y = tableRow(ctx, bHeader, { fill: GREY, bold: true });
  for (const cat of (m.sectionB && m.sectionB.categories) || []) {
    ctx.y = pageBreak(ctx, bHeader);
    ctx.y = tableRow(ctx, { item: String(cat.n), date: cat.name }, { fill: GREY, bold: true });
    for (const row of cat.rows) {
      ctx.y = pageBreak(ctx, bHeader);
      ctx.y = tableRow(ctx, {
        item: String(row.i), date: row.date || '', name: showStaff ? (row.staffName || '') : '',
        desc: row.description || '', amount: money(row.amount), amount2: hasCur2 ? money(row.amount2) : '',
      });
    }
    for (let p = 0; p < (cat.padRows || 0); p++) { ctx.y = pageBreak(ctx, bHeader); ctx.y = tableRow(ctx, {}); }
    ctx.y = tableRow(ctx, { desc: 'TOTAL', amount: money(cat.subtotal) }, { fill: YELLOW, bold: true });
  }
  ctx.y = tableRow(ctx, { desc: 'SUBTOTAL', amount: money(m.sectionB ? m.sectionB.subtotal : 0) }, { fill: GREEN, bold: true });
  ctx.y += 10;

  // ---- footer ----
  const f = m.footer || {};
  ctx.y = tableRow(ctx, { desc: 'A. TOTAL CASH IN-HAND', amount: money(f.cashInHand) }, { bold: true });
  ctx.y = tableRow(ctx, { desc: 'B. TOTAL EXPENDITURE', amount: money(f.expenditure) }, { bold: true });
  ctx.y = tableRow(ctx, { desc: 'BALANCE', amount: money(f.balance) }, { bold: true, amountColor: Number(f.balance) < 0 ? RED : BLACK });
  ctx.y += 16;

  // ---- sign-off ----
  const so = m.signoff || {};
  const roles = [];
  if (so.prepared) roles.push('PREPARED BY :');
  if (so.checked) roles.push('CHECKED BY :');
  if (so.approved) roles.push('APPROVED BY:');
  if (roles.length) {
    if (ctx.y + 40 > PAGE_BOTTOM) { doc.addPage(); ctx.y = MARGIN; }
    const slot = CONTENT_W / roles.length;
    doc.font('Helvetica').fontSize(9).fillColor(BLACK);
    roles.forEach((label, i) => doc.text(label, MARGIN + i * slot, ctx.y, { width: slot - 8, align: 'left' }));
    ctx.y += 26;
    roles.forEach((label, i) => doc.text('DATE :', MARGIN + i * slot, ctx.y, { width: slot - 8, align: 'left' }));
  }
}

function sectionHeading(ctx, text) {
  if (ctx.y + ROW_H > PAGE_BOTTOM) { ctx.doc.addPage(); ctx.y = MARGIN; }
  ctx.doc.font('Helvetica-BoldOblique').fontSize(10).fillColor(BLUE)
    .text(text, MARGIN, ctx.y, { width: CONTENT_W, align: 'left', underline: true });
  return ctx.y + ROW_H + 2;
}

function pageBreak(ctx, headerCells) {
  if (ctx.y + ROW_H > PAGE_BOTTOM) {
    ctx.doc.addPage();
    ctx.y = MARGIN;
    ctx.y = tableRow(ctx, headerCells, { fill: GREY, bold: true }); // repeat the column header
  }
  return ctx.y;
}

function headerCells(section, m) {
  const hasCur2 = m.currency2 != null && m.currency2 !== '';
  if (section === 'A') {
    const h = { date: 'DATE', desc: 'DESCRIPTION', amount: 'AMOUNT (' + (m.currency || '') + ')' };
    if (hasCur2) h.amount2 = 'AMOUNT (' + m.currency2 + ')';
    return h;
  }
  const h = { item: 'ITEM', date: 'DATE', desc: 'DESCRIPTION', amount: 'T. AMOUNT (' + (m.currency || '') + ')' };
  if (m.showStaffColumn) h.name = 'NAME';
  if (hasCur2) h.amount2 = 'T. AMOUNT (' + m.currency2 + ')';
  return h;
}

// Draw one bordered table row; returns the new y. Fills the band, strokes each cell, writes text.
function tableRow(ctx, cellMap, style = {}) {
  const { doc, cols } = ctx;
  const y = ctx.y;
  if (style.fill) doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(style.fill);
  for (const col of cols) {
    doc.lineWidth(0.5).strokeColor(BLACK).rect(col.x, y, col.w, ROW_H).stroke();
    const text = cellMap[col.key];
    if (text == null || text === '') continue;
    const color = (col.key === 'amount' && style.amountColor) ? style.amountColor : BLACK;
    doc.font(style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(color)
      .text(String(text), col.x + 3, y + 4, { width: col.w - 6, align: col.align, lineBreak: false, ellipsis: true });
  }
  return y + ROW_H;
}

module.exports = { statementToPdf };
