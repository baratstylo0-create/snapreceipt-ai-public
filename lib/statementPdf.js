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
const DGREY = '#555555';
const STRIP = '#F0F0F0';
const YELLOW = '#FFFF00';
const GREEN = '#92D050';

const MARGIN = 40;
const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const PAGE_BOTTOM = PAGE_H - MARGIN;
const ROW_H = 15;

// Receipt ID-card layout (Owner request, replaces the earlier full-bleed "image dump"
// appendix — one bordered card per page, details block + a bordered photo box that never
// stretches a small photo blurry). Evidence-mode-only; drawPlainReceiptPage (manageExport)
// and the statement pages above are untouched.
const CARD_RADIUS = 8;
const CARD_PAD = 16;
const BORDER_GREY = '#CCCCCC';
const LABEL_GREY = '#555555';
const REF_GREY = '#888888';
// PDF-source receipts are rasterised at a higher DPI than the default (150) so they stay
// crisp inside the card's photo box, which is smaller than a full page.
const EVIDENCE_PDF_DPI = 220;
const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Build the column geometry (x/width per key) for the current model flags.
function columns(showStaff, hasCur2, showBranch) {
  const cols = [];
  let x = MARGIN;
  const push = (key, w, align) => { cols.push({ key, x, w, align: align || 'left' }); x += w; };
  push('item', 32, 'center');
  push('date', 66);
  if (showStaff) push('name', 74);
  if (showBranch) push('branch', 74);
  const fixed = 32 + 66 + (showStaff ? 74 : 0) + (showBranch ? 74 : 0) + 88 + (hasCur2 ? 88 : 0);
  push('desc', CONTENT_W - fixed);
  push('amount', 88, 'right');
  if (hasCur2) push('amount2', 88, 'right');
  return cols;
}

// Flattened statement-line rows, DATE-ordered for the receipt-photo appendix (tie-break
// expenseId for a stable order when two receipts share a date). The STATEMENT BODY itself
// stays category-grouped (drawStatement below reads `rows` in category order, unaffected) —
// only the photo pages that follow the statement are reordered, so an admin flipping through
// the appendix sees photos chronologically regardless of which category they landed in.
function sortRowsByDate(rows) {
  return rows.slice().sort((a, b) => {
    const ad = String((a && a.date) || '');
    const bd = String((b && b.date) || '');
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ai = String((a && a.expenseId) || '');
    const bi = String((b && b.expenseId) || '');
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

// fitScale(imgW, imgH, boxW, boxH) -> the scale factor to draw an image at inside a box,
// aspect preserved, CAPPED AT 1 — the core fix for the reported blur bug: a photo smaller
// than its box must be drawn at its real size, never stretched up to fill the space (only
// ever shrinks a big photo down, never enlarges a small one). Pure; garbage/zero input
// degrades to 1 (draw at natural size) rather than throwing or dividing by zero.
function fitScale(imgW, imgH, boxW, boxH) {
  const w = Number(imgW), h = Number(imgH), bw = Number(boxW), bh = Number(boxH);
  if (!(w > 0) || !(h > 0) || !(bw > 0) || !(bh > 0)) return 1;
  return Math.min(bw / w, bh / h, 1);
}

// formatDisplayDate('YYYY-MM-DD') -> 'DD Mon YYYY' (e.g. '03 Jul 2026') for the receipt
// card's details block — the raw ISO form the model carries isn't the human-facing format
// the card spec calls for. Anything that doesn't match is returned unchanged (never throws).
function formatDisplayDate(iso) {
  const s = String(iso || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return s;
  return m[3] + ' ' + DAY_MONTHS[mi] + ' ' + m[1];
}

// evidenceDetailLines(m, row) -> the card's details block, in spec order (Date / Vendor /
// Amount / Branch / Staff) — only the lines that actually exist for this row (Branch/Staff
// are already conditionally populated upstream by buildStatementModel's showBranchColumn/
// showStaffColumn flags, so no extra flag-checking is needed here).
function evidenceDetailLines(m, row) {
  const lines = [];
  if (row.date) lines.push('Date: ' + formatDisplayDate(row.date));
  if (row.description) lines.push('Vendor: ' + String(row.description));
  lines.push('Amount: ' + (m.currency || '') + ' ' + money(row.amount));
  if (row.branchLabel) lines.push('Branch: ' + String(row.branchLabel));
  if (row.staffName) lines.push('Staff: ' + String(row.staffName));
  return lines;
}

function statementToPdf(model, opts = {}) {
  const m = model || {};
  const receipts = (opts && opts.receipts) || null;
  const evidence = !!opts.receiptEvidence;

  // Flatten expense rows (Section B, category order, row order) — this is what the STATEMENT
  // BODY draws from (drawStatement below), unaffected by the appendix ordering.
  const rows = [];
  for (const cat of (m.sectionB && m.sectionB.categories) || []) {
    for (const row of cat.rows) rows.push(row);
  }
  // The PHOTO APPENDIX is DATE-ordered, not statement-line order — a separate pass over the
  // same rows, so re-sorting here never touches the statement pages above.
  const receiptRows = sortRowsByDate(rows);

  // Pre-rasterise receipts (async) BEFORE the synchronous drawing pass, so the doc build is linear.
  return (async () => {
    let skippedReceipts = 0;
    // Each item is one appended IMAGE page: { row, buffer }. A row whose receipt is missing or
    // unreadable produces NO page — instead it's collected in noReceiptRows and (evidence mode
    // only) summarised on a single "not attached" page at the very end. This matches the client's
    // sample (bare full-page receipt images, no per-expense placeholder pages), while still telling
    // the admin which lines lack a receipt. Plain mode (manageExport) is unchanged: missing rows are
    // silently omitted, exactly as before this feature existed.
    const items = [];
    const noReceiptRows = [];
    for (const row of receiptRows) {
      const rec = receipts && row.expenseId != null ? receipts[row.expenseId] : null;
      if (!rec || !rec.buffer) {
        if (evidence) noReceiptRows.push(row);
        continue; // no receipt attached to this row — nothing to append
      }
      const ext = String(rec.ext || '').toLowerCase();
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
        items.push({ row, buffer: rec.buffer });
      } else if (ext === 'pdf') {
        try {
          // A PDF receipt is rasterised and inserted as a snapshot image, one page per source page.
          // Evidence mode renders at a higher DPI (the card's photo box is smaller than a full
          // page, so it needs to stay crisp) — plain mode (manageExport) keeps the default DPI,
          // unchanged.
          const { pages } = await rasterizePdf(rec.buffer, evidence ? { dpi: EVIDENCE_PDF_DPI } : {});
          if (pages && pages.length) {
            pages.forEach((p, i) => items.push({ row, buffer: p, part: pages.length > 1 ? (i + 1) + '/' + pages.length : null }));
          } else {
            skippedReceipts += 1;
            if (evidence) noReceiptRows.push(row);
          }
        } catch (e) {
          console.error('[statement pdf receipt]', e.message); // message only — no bytes/PII
          skippedReceipts += 1;
          if (evidence) noReceiptRows.push(row);
        }
      } else {
        skippedReceipts += 1; // webp/gif/bin — pdfkit can't embed; skip + count
        if (evidence) noReceiptRows.push(row);
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
        items.forEach((item, i) => {
          doc.addPage();
          if (evidence) drawEvidencePage(doc, m, item, i === 0, i + 1);
          else drawPlainReceiptPage(doc, item);
        });
        // Evidence mode: one final page listing any expense that had no attached receipt (never
        // per-expense placeholder pages). Skipped entirely when every expense has a receipt.
        if (evidence && noReceiptRows.length) drawNoReceiptSummary(doc, m, noReceiptRows);
        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  })();
}

// Pre-feature behavior (manageExport.js and any other caller that doesn't opt into
// receiptEvidence): just the image, fit inside the content box, top-aligned.
function drawPlainReceiptPage(doc, item) {
  if (!item || !item.buffer) return;
  try {
    doc.image(item.buffer, MARGIN, MARGIN, { fit: [CONTENT_W, PAGE_H - 2 * MARGIN], align: 'center', valign: 'top' });
  } catch (e) {
    console.error('[statement pdf image]', e.message);
  }
}

// Receipt Compilation mode: the receipt image is the star — one big, full-width, aspect-preserved
// image per page (the way clients are used to seeing their receipts), with a compact one-line
// annotation strip at the bottom carrying the essentials (date · description · amount · staff ·
// branch · ref). A "RECEIPT COMPILATION" header opens the section on the first page. Missing/
// unreadable receipts never reach here — they're summarised on a single final page instead.
function drawEvidencePage(doc, m, item, isFirst, n) {
  const row = item.row || {};

  // The card: a bordered, rounded box filling the whole page content area — every other
  // element (title, details, photo box, ref) is drawn INSIDE it.
  const cardX = MARGIN, cardY = MARGIN, cardW = CONTENT_W, cardH = PAGE_BOTTOM - MARGIN;
  doc.roundedRect(cardX, cardY, cardW, cardH, CARD_RADIUS).lineWidth(1).strokeColor(BORDER_GREY).stroke();

  const innerX = cardX + CARD_PAD;
  const innerW = cardW - 2 * CARD_PAD;
  let y = cardY + CARD_PAD;

  // Title
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BLACK)
    .text('Receipt #' + n + (item.part ? '  (page ' + item.part + ')' : ''), innerX, y, { width: innerW, align: 'left' });
  y += 20;

  // Details block — Date / Vendor / Amount / Branch / Staff, one line each.
  doc.font('Helvetica').fontSize(9).fillColor(LABEL_GREY);
  for (const line of evidenceDetailLines(m, row)) {
    doc.text(line, innerX, y, { width: innerW, align: 'left', lineBreak: false, ellipsis: true });
    y += 13;
  }
  y += 8;

  // Photo box: its own border, the image centred inside, NEVER upscaled past its real
  // pixel size (fitScale caps at 1) — a small photo stays sharp instead of stretching blurry.
  const refH = 14;
  const boxY = y;
  const boxH = Math.max(80, (cardY + cardH - CARD_PAD) - boxY - refH - 6);
  const boxW = innerW;
  doc.lineWidth(0.75).strokeColor(BORDER_GREY).rect(innerX, boxY, boxW, boxH).stroke();
  try {
    const img = doc.openImage(item.buffer);
    const pad = 6; // breathing room inside the photo box
    const scale = fitScale(img.width, img.height, boxW - 2 * pad, boxH - 2 * pad);
    const drawW = img.width * scale, drawH = img.height * scale;
    doc.image(img, innerX + (boxW - drawW) / 2, boxY + (boxH - drawH) / 2, { width: drawW, height: drawH });
  } catch (e) {
    // An image that reached here (already format-validated) failed to embed — degrade gracefully to
    // a centred note in the photo box rather than crashing the whole statement.
    console.error('[statement pdf image]', e.message);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(RED)
      .text('Receipt image could not be rendered', innerX, boxY + boxH / 2 - 6, { width: boxW, align: 'center' });
  }

  // Reference number, printed underneath the photo box, still inside the card.
  if (row.expenseId != null) {
    doc.font('Helvetica').fontSize(8).fillColor(REF_GREY)
      .text('Ref: ' + String(row.expenseId), innerX, boxY + boxH + 6, { width: innerW, align: 'center' });
  }
}

// One-line annotation for a receipt: only the parts that exist, joined by a WinAnsi-safe middot
// (never a Unicode arrow/em-dash — pdfkit's standard Helvetica can't render those glyphs).
function evidenceCaption(m, row) {
  const parts = [];
  if (row.date) parts.push(String(row.date));
  if (row.description) parts.push(String(row.description));
  parts.push('(' + (m.currency || '') + ') ' + money(row.amount));
  if (row.staffName) parts.push('Staff: ' + row.staffName);
  if (row.branchLabel) parts.push('Branch: ' + row.branchLabel);
  if (row.expenseId != null) parts.push('Ref: ' + String(row.expenseId));
  return parts.join('  ·  ');
}

// Final page (evidence mode only, and only when something is missing): a compact list of the
// expenses that have no receipt on file — helpful without cluttering the compilation with blank
// per-expense placeholder pages. Paginates if the list is long.
function drawNoReceiptSummary(doc, m, rows) {
  doc.addPage();
  let y = MARGIN;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(BLACK)
    .text('Expenses without an attached receipt (' + rows.length + ')', MARGIN, y, { width: CONTENT_W, align: 'left' });
  y += 20;
  doc.font('Helvetica').fontSize(9).fillColor(DGREY)
    .text('These lines appear in the statement above but have no receipt image on file.', MARGIN, y, { width: CONTENT_W, align: 'left' });
  y += 22;
  doc.fillColor(BLACK);
  for (const row of rows) {
    if (y + 14 > PAGE_BOTTOM) { doc.addPage(); y = MARGIN; }
    doc.text('•  ' + evidenceCaption(m, row), MARGIN, y, { width: CONTENT_W, align: 'left', lineBreak: false, ellipsis: true });
    y += 14;
  }
}

function drawStatement(doc, m) {
  const showStaff = !!m.showStaffColumn;
  const showBranch = !!m.showBranchColumn;
  const hasCur2 = m.currency2 != null && m.currency2 !== '';
  const cols = columns(showStaff, hasCur2, showBranch);

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
    // Category name goes in the WIDE description column (mirrors the client sample, where the
    // category label sits in the DESCRIPTION column) — not the narrow date column, where a long
    // name would have to be truncated hard.
    ctx.y = tableRow(ctx, { item: String(cat.n), desc: cat.name }, { fill: GREY, bold: true });
    for (const row of cat.rows) {
      ctx.y = pageBreak(ctx, bHeader);
      ctx.y = tableRow(ctx, {
        item: String(row.i), date: row.date || '', name: showStaff ? (row.staffName || '') : '',
        branch: showBranch ? (row.branchLabel || '') : '',
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
  if (m.showBranchColumn) h.branch = 'BRANCH';
  if (hasCur2) h.amount2 = 'T. AMOUNT (' + m.currency2 + ')';
  return h;
}

// Truncate `str` with a trailing "..." so it fits within maxW at the currently-selected font/size.
// pdfkit's own { lineBreak:false, ellipsis:true } is unreliable here — it still wraps a too-wide
// cell to a second line (measured: 19px vs a 15px row), which then overlaps the row below. We do
// the single-line fit ourselves. Plain ASCII "..." (never the U+2026 glyph — same tofu risk as a
// Unicode arrow in the standard Helvetica AFM).
function fitToWidth(doc, str, maxW) {
  if (doc.widthOfString(str) <= maxW) return str;
  let s = str;
  while (s.length > 1 && doc.widthOfString(s + '...') > maxW) s = s.slice(0, -1);
  return s + '...';
}

// Draw one bordered table row; returns the new y. Fills the band, strokes each cell, writes text.
// Overflow guard: if this row would cross the page bottom, start a fresh page FIRST. Without it
// pdfkit splits the row — the cell borders draw off the bottom of the current page while the text
// (e.g. "TOTAL", "0.00") gets flung onto a new near-blank page, the stray-fragment bug. The
// in-table data rows are already guarded by pageBreak() (which also repeats the column header);
// this backstops the rows that AREN'T — the category TOTAL, the SUBTOTAL, and the footer/balance
// rows — where a mid-table header repeat isn't wanted anyway. Never changes layout when the row
// already fits (the common case), so the design is untouched.
function tableRow(ctx, cellMap, style = {}) {
  const { doc, cols } = ctx;
  if (ctx.y + ROW_H > PAGE_BOTTOM) { doc.addPage(); ctx.y = MARGIN; }
  const y = ctx.y;
  if (style.fill) doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(style.fill);
  for (const col of cols) {
    doc.lineWidth(0.5).strokeColor(BLACK).rect(col.x, y, col.w, ROW_H).stroke();
    const text = cellMap[col.key];
    if (text == null || text === '') continue;
    const color = (col.key === 'amount' && style.amountColor) ? style.amountColor : BLACK;
    const maxW = col.w - 6;
    doc.font(style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(color);
    // Set the font BEFORE measuring, then draw the fitted single line (lineBreak:false as belt-and-
    // suspenders now that the string already fits the width).
    doc.text(fitToWidth(doc, String(text), maxW), col.x + 3, y + 4, { width: maxW, align: col.align, lineBreak: false });
  }
  return y + ROW_H;
}

module.exports = { statementToPdf, sortRowsByDate, fitScale, formatDisplayDate };
