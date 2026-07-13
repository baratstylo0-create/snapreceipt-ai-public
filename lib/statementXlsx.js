'use strict';
// lib/statementXlsx.js — Phase 10 (ADR-012 exceljs, ADR-023/024). Renders a StatementModel
// (lib/statement.js) to a styled .xlsx matching the §2b styling contract. Values are the truth
// (real numbers, never #REF! — the client's manual sheet had broken formulas); styling is faithful
// to the client sample so the Owner's visual diff passes. Reuses the fill/border idioms from
// lib/excel.js (the Summary sheet). NO I/O — the route supplies the model + receipt bytes.
const ExcelJS = require('exceljs');

// §2b palette (ARGB). Configurable per company later; these are the sample's design targets.
const RED = 'FFCC0000';     // company name + negative balance
const BLUE = 'FF0000CC';    // section headings
const BLACK = 'FF000000';
const GREY = 'FFE8E8E8';    // header bands + category banners
const YELLOW = 'FFFFFF00';  // per-category TOTAL
const GREEN = 'FF92D050';   // statement SUBTOTAL
const MONEY_FMT = '#,##0.00';
const THIN = { style: 'thin', color: { argb: BLACK } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const fillOf = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function statementToWorkbook(model, opts = {}) {
  const m = model || {};
  const showStaff = !!m.showStaffColumn;
  const showBranch = !!m.showBranchColumn;
  const hasCur2 = m.currency2 != null && m.currency2 !== '';

  // Column map (1-based): ITEM, DATE, [NAME], [BRANCH], DESCRIPTION, T.AMOUNT, [T.AMOUNT2]
  let c = 1;
  const COL = {};
  COL.item = c++;
  COL.date = c++;
  if (showStaff) COL.name = c++;
  if (showBranch) COL.branch = c++;
  COL.desc = c++;
  COL.amount = c++;
  if (hasCur2) COL.amount2 = c++;
  const W = c - 1;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  // Reasonable print widths; DESCRIPTION is the widest.
  ws.getColumn(COL.item).width = 6;
  ws.getColumn(COL.date).width = 12;
  if (showStaff) ws.getColumn(COL.name).width = 16;
  if (showBranch) ws.getColumn(COL.branch).width = 16;
  ws.getColumn(COL.desc).width = 34;
  ws.getColumn(COL.amount).width = 16;
  if (hasCur2) ws.getColumn(COL.amount2).width = 16;

  const border = (rowNum) => { for (let i = 1; i <= W; i++) ws.getRow(rowNum).getCell(i).border = BOX; };
  const fillRow = (rowNum, argb) => { for (let i = 1; i <= W; i++) ws.getRow(rowNum).getCell(i).fill = fillOf(argb); };
  const mergeAcross = (rowNum) => ws.mergeCells(rowNum, 1, rowNum, W);
  const money = (cell, v) => { cell.value = v; cell.numFmt = MONEY_FMT; cell.alignment = { horizontal: 'right' }; };

  // ---- title block ----------------------------------------------------------
  let r = ws.addRow([]).number;
  ws.getRow(r).getCell(1).value = m.companyName || '';
  ws.getRow(r).getCell(1).font = { name: 'Times New Roman', bold: true, size: 16, color: { argb: RED } };
  ws.getRow(r).getCell(1).alignment = { horizontal: 'center' };
  mergeAcross(r);

  r = ws.addRow([]).number;
  ws.getRow(r).getCell(1).value = m.title || '';
  ws.getRow(r).getCell(1).font = { bold: true, size: 12, color: { argb: BLACK } };
  ws.getRow(r).getCell(1).alignment = { horizontal: 'center' };
  mergeAcross(r);

  r = ws.addRow([]).number;
  ws.getRow(r).getCell(1).value = m.periodLabel || '';
  ws.getRow(r).getCell(1).font = { bold: true, color: { argb: BLACK } };
  ws.getRow(r).getCell(1).alignment = { horizontal: 'center' };
  mergeAcross(r);

  r = ws.addRow([]).number;
  ws.getRow(r).getCell(COL.item).value = 'Branch: ' + (m.branchLabel || '');
  ws.getRow(r).getCell(COL.amount).value = 'Prepared by: ' + (m.preparedBy || '');
  ws.addRow([]);

  // ---- section heading helper ----
  function sectionHeading(text) {
    const rr = ws.addRow([]).number;
    const cell = ws.getRow(rr).getCell(1);
    cell.value = text;
    cell.font = { italic: true, underline: true, bold: true, color: { argb: BLUE } };
    cell.alignment = { horizontal: 'left' };
    mergeAcross(rr);
  }

  // ---- Section A: SUMMARY OF CASH IN ---------------------------------------
  sectionHeading('A.  SUMMARY OF CASH IN');
  const aHead = ws.addRow([]).number;
  ws.getRow(aHead).getCell(COL.date).value = 'DATE';
  ws.getRow(aHead).getCell(COL.desc).value = 'DESCRIPTION';
  ws.getRow(aHead).getCell(COL.amount).value = 'AMOUNT (' + (m.currency || '') + ')';
  if (hasCur2) ws.getRow(aHead).getCell(COL.amount2).value = 'AMOUNT (' + m.currency2 + ')';
  fillRow(aHead, GREY); border(aHead);
  for (let i = 1; i <= W; i++) ws.getRow(aHead).getCell(i).font = { bold: true };

  for (const row of (m.sectionA && m.sectionA.rows) || []) {
    const rr = ws.addRow([]).number;
    ws.getRow(rr).getCell(COL.date).value = row.date || '';
    ws.getRow(rr).getCell(COL.desc).value = row.description || '';
    money(ws.getRow(rr).getCell(COL.amount), row.amount);
    if (hasCur2) money(ws.getRow(rr).getCell(COL.amount2), row.amount2);
    border(rr);
  }
  const aTotal = ws.addRow([]).number;
  ws.getRow(aTotal).getCell(COL.desc).value = 'TOTAL';
  ws.getRow(aTotal).getCell(COL.desc).font = { bold: true };
  money(ws.getRow(aTotal).getCell(COL.amount), m.sectionA ? m.sectionA.total : 0);
  ws.getRow(aTotal).getCell(COL.amount).font = { bold: true };
  if (hasCur2) { money(ws.getRow(aTotal).getCell(COL.amount2), m.sectionA.total2); ws.getRow(aTotal).getCell(COL.amount2).font = { bold: true }; }
  border(aTotal);
  ws.addRow([]);

  // ---- Section B: SUMMARY OF EXPENSES --------------------------------------
  sectionHeading('B.  SUMMARY OF EXPENSES: (' + (m.branchLabel || '') + ')');
  const bHead = ws.addRow([]).number;
  ws.getRow(bHead).getCell(COL.item).value = 'ITEM';
  ws.getRow(bHead).getCell(COL.date).value = 'DATE';
  if (showStaff) ws.getRow(bHead).getCell(COL.name).value = 'NAME';
  if (showBranch) ws.getRow(bHead).getCell(COL.branch).value = 'BRANCH';
  ws.getRow(bHead).getCell(COL.desc).value = 'DESCRIPTION';
  ws.getRow(bHead).getCell(COL.amount).value = 'T. AMOUNT (' + (m.currency || '') + ')';
  if (hasCur2) ws.getRow(bHead).getCell(COL.amount2).value = 'T. AMOUNT (' + m.currency2 + ')';
  fillRow(bHead, GREY); border(bHead);
  for (let i = 1; i <= W; i++) ws.getRow(bHead).getCell(i).font = { bold: true };

  const receipts = (opts && opts.receipts) || null;
  const receiptLinks = (opts && opts.receiptLinks) || null;
  const embedReceipts = !(opts && opts.embedReceipts === false);
  const EMBEDDABLE = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif' };
  const embeddedReceiptIds = new Set();

  for (const cat of (m.sectionB && m.sectionB.categories) || []) {
    // category banner
    const banner = ws.addRow([]).number;
    ws.getRow(banner).getCell(COL.item).value = cat.n;
    ws.getRow(banner).getCell(COL.item).alignment = { horizontal: 'center' };
    ws.getRow(banner).getCell(COL.date).value = cat.name;
    fillRow(banner, GREY); border(banner);
    for (let i = 1; i <= W; i++) ws.getRow(banner).getCell(i).font = { bold: true };

    for (const row of cat.rows) {
      const rr = ws.addRow([]).number;
      ws.getRow(rr).getCell(COL.item).value = row.i;
      ws.getRow(rr).getCell(COL.item).alignment = { horizontal: 'center' };
      ws.getRow(rr).getCell(COL.date).value = row.date || '';
      if (showStaff) ws.getRow(rr).getCell(COL.name).value = row.staffName || '';
      if (showBranch) ws.getRow(rr).getCell(COL.branch).value = row.branchLabel || '';
      ws.getRow(rr).getCell(COL.desc).value = row.description || '';
      money(ws.getRow(rr).getCell(COL.amount), row.amount);
      if (hasCur2) money(ws.getRow(rr).getCell(COL.amount2), row.amount2);
      border(rr);
      // receipt: full-res hyperlink on the description cell + optional floated thumbnail (ADR-018)
      const id = row.expenseId;
      const link = receiptLinks && id != null ? receiptLinks[id] : null;
      const bytes = receipts && id != null ? receipts[id] : null;
      if (link) {
        ws.getRow(rr).getCell(COL.desc).value = { text: row.description || 'Receipt', hyperlink: link };
      }
      const ext = bytes && bytes.buffer ? EMBEDDABLE[String(bytes.ext || '').toLowerCase()] : null;
      if (embedReceipts && ext && id != null && !embeddedReceiptIds.has(String(id))) {
        const imgId = wb.addImage({ buffer: bytes.buffer, extension: ext });
        ws.addImage(imgId, { tl: { col: W, row: rr - 1 }, ext: { width: 72, height: 54 } });
        ws.getRow(rr).height = 44;
        embeddedReceiptIds.add(String(id));
      }
    }
    // pad rows (visual fidelity — the sheet pre-sizes each block)
    for (let p = 0; p < (cat.padRows || 0); p++) border(ws.addRow([]).number);

    // per-category TOTAL (yellow)
    const tot = ws.addRow([]).number;
    ws.getRow(tot).getCell(COL.desc).value = 'TOTAL';
    ws.getRow(tot).getCell(COL.desc).font = { bold: true };
    money(ws.getRow(tot).getCell(COL.amount), cat.subtotal);
    ws.getRow(tot).getCell(COL.amount).font = { bold: true };
    ws.getRow(tot).getCell(COL.desc).fill = fillOf(YELLOW);
    ws.getRow(tot).getCell(COL.amount).fill = fillOf(YELLOW);
    border(tot);
  }

  // statement SUBTOTAL (green)
  const sub = ws.addRow([]).number;
  ws.getRow(sub).getCell(COL.desc).value = 'SUBTOTAL';
  ws.getRow(sub).getCell(COL.desc).font = { bold: true };
  money(ws.getRow(sub).getCell(COL.amount), m.sectionB ? m.sectionB.subtotal : 0);
  ws.getRow(sub).getCell(COL.amount).font = { bold: true };
  ws.getRow(sub).getCell(COL.desc).fill = fillOf(GREEN);
  ws.getRow(sub).getCell(COL.amount).fill = fillOf(GREEN);
  border(sub);
  ws.addRow([]);

  // ---- footer summary block (boxed) ----------------------------------------
  const f = (m.footer) || {};
  function footerLine(label, value, isBalance) {
    const rr = ws.addRow([]).number;
    ws.getRow(rr).getCell(COL.desc).value = label;
    ws.getRow(rr).getCell(COL.desc).font = { bold: true };
    money(ws.getRow(rr).getCell(COL.amount), value);
    ws.getRow(rr).getCell(COL.amount).font = { bold: true, color: { argb: (isBalance && Number(value) < 0) ? RED : BLACK } };
    border(rr);
  }
  footerLine('A. TOTAL CASH IN-HAND', f.cashInHand || 0, false);
  footerLine('B. TOTAL EXPENDITURE', f.expenditure || 0, false);
  footerLine('BALANCE', f.balance || 0, true);
  ws.addRow([]);

  // ---- sign-off block (per model.signoff) ----------------------------------
  const so = m.signoff || {};
  const roles = [];
  if (so.prepared) roles.push('PREPARED BY :');
  if (so.checked) roles.push('CHECKED BY :');
  if (so.approved) roles.push('APPROVED BY:');
  if (roles.length) {
    const labelRow = ws.addRow([]).number;
    const dateRow = ws.addRow([]).number;
    roles.forEach((label, i) => {
      const col = 1 + i * Math.max(1, Math.floor(W / roles.length));
      ws.getRow(labelRow).getCell(Math.min(col, W)).value = label;
      ws.getRow(dateRow).getCell(Math.min(col, W)).value = 'DATE :';
    });
  }

  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'portrait' };
  return wb;
}

module.exports = { statementToWorkbook };
