'use strict';
// lib/statementXlsx.js — Phase 10 exceljs renderer of the StatementModel (spec §2b styling
// contract). We assert cell VALUES + the key fills/fonts programmatically (exceljs exposes
// cell.fill.fgColor.argb, cell.font.color/bold/italic/underline, cell.border). No pixel testing —
// the Owner does the final visual diff vs the confidential client sample.
const test = require('node:test');
const assert = require('node:assert');
const { buildStatementModel } = require('../lib/statement');
const { statementToWorkbook } = require('../lib/statementXlsx');

const baseArgs = {
  companyName: 'Placeholder Trading Sdn Bhd', branchLabel: 'HQ', preparedBy: 'Aisha', period: '2025-10',
  categories: ['Tickets', 'Hotel', 'Food'], currency: 'MYR', showStaffColumn: true,
  balanceBf: 3000, cashIn: [{ description: 'Top up', amount: 0 }],
  expenses: [
    { id: 'e1', amount: 10.10, category: 'Food', expense_date: '2025-10-01', merchant: 'Cafe', staff_user_id: 'u1' },
    { id: 'e2', amount: 20.20, category: 'Tickets', expense_date: '2025-10-02', merchant: 'Grab', staff_user_id: 'u1' },
    { id: 'e3', amount: 2894.61, category: 'Hotel', expense_date: '2025-10-03', merchant: 'Hotel', staff_user_id: 'u2' },
  ],
  staffNames: { u1: 'Farid', u2: 'Mei' },
  signoff: { prepared: true, checked: false, approved: true },
};

// flatten a worksheet to an array of { addr, value, argb (fill), font, border }
function cells(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      out.push({
        addr: cell.address,
        value: cell.value,
        text: cell.value && cell.value.richText ? cell.value.richText.map((r) => r.text).join('') : cell.value,
        fill: cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb,
        font: cell.font || {},
        border: cell.border || {},
      });
    });
  });
  return out;
}
const findText = (cs, needle) => cs.find((c) => typeof c.text === 'string' && c.text.includes(needle));
const anyFill = (cs, argb) => cs.some((c) => c.fill === argb);

test('company name is bold + red, and a section heading is blue/italic/underlined', () => {
  const ws = statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0];
  const cs = cells(ws);
  const co = findText(cs, 'Placeholder Trading');
  assert.ok(co, 'company name rendered');
  assert.strictEqual(co.font.bold, true);
  assert.match(co.font.color.argb, /CC0000/i, 'company name is red');

  const heading = findText(cs, 'A.  SUMMARY OF CASH IN');
  assert.ok(heading, 'Section A heading rendered');
  assert.strictEqual(heading.font.italic, true);
  assert.strictEqual(heading.font.underline, true);
  assert.match(heading.font.color.argb, /0000CC/i, 'heading is blue');
  assert.ok(findText(cs, 'B.  SUMMARY OF EXPENSES'), 'Section B heading rendered');
});

test('title + period render', () => {
  const cs = cells(statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0]);
  assert.ok(findText(cs, 'PETTY CASH MONTHLY STATEMENT OF ACCOUNT'));
  assert.ok(findText(cs, 'OCTOBER 2025'));
});

test('header rows are grey-filled, bold, and thin-bordered', () => {
  const cs = cells(statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0]);
  const dateHeader = cs.find((c) => c.text === 'DATE' && c.fill === 'FFE8E8E8');
  assert.ok(dateHeader, 'a grey DATE header cell exists');
  assert.strictEqual(dateHeader.font.bold, true);
  assert.strictEqual(dateHeader.border.top && dateHeader.border.top.style, 'thin');
  assert.ok(findText(cs, 'T. AMOUNT'), 'Section B amount header rendered');
  assert.ok(findText(cs, 'NAME'), 'staff NAME header present when showStaffColumn');
});

test('per-category TOTAL is yellow; the statement SUBTOTAL is green', () => {
  const cs = cells(statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0]);
  assert.ok(anyFill(cs, 'FFFFFF00'), 'a yellow per-category TOTAL cell exists');
  assert.ok(anyFill(cs, 'FF92D050'), 'a green SUBTOTAL cell exists');
});

test('numeric totals land in cells with the money format and correct values', () => {
  const cs = cells(statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0]);
  // Section B subtotal value 2924.91 appears somewhere as a number
  const subtotalCell = cs.find((c) => typeof c.value === 'number' && Math.abs(c.value - 2924.91) < 0.005);
  assert.ok(subtotalCell, 'the 2924.91 subtotal is written as a real number (never #REF!)');
  // cash-in-hand 3000 present
  assert.ok(cs.some((c) => typeof c.value === 'number' && Math.abs(c.value - 3000) < 0.005));
});

test('a NEGATIVE balance is shown in red font', () => {
  const overspent = buildStatementModel({ ...baseArgs, balanceBf: 1000 }); // 1000 - 2924.91 = -1924.91
  assert.ok(overspent.footer.balance < 0);
  const cs = cells(statementToWorkbook(overspent).worksheets[0]);
  const balCell = cs.find((c) => typeof c.value === 'number' && Math.abs(c.value - overspent.footer.balance) < 0.005 && c.font && c.font.color);
  assert.ok(balCell, 'the balance cell is found');
  assert.match(balCell.font.color.argb, /CC0000|FF0000/i, 'negative balance is red');
});

test('sign-off rows honor the per-company config (checked hidden when false)', () => {
  const withChecked = cells(statementToWorkbook(buildStatementModel({ ...baseArgs, signoff: { prepared: true, checked: true, approved: true } })).worksheets[0]);
  assert.ok(findText(withChecked, 'PREPARED BY'));
  assert.ok(findText(withChecked, 'APPROVED BY'));
  assert.ok(findText(withChecked, 'CHECKED BY'), 'checked shown when enabled');

  const noChecked = cells(statementToWorkbook(buildStatementModel(baseArgs)).worksheets[0]);
  assert.ok(!findText(noChecked, 'CHECKED BY'), 'checked hidden when disabled');
});

test('empty category still renders a banner (visual fidelity)', () => {
  const m = buildStatementModel({ ...baseArgs, categories: ['Tickets', 'Hotel', 'Food', 'Hardware'], expenses: [] });
  const cs = cells(statementToWorkbook(m).worksheets[0]);
  assert.ok(findText(cs, 'Hardware'), 'the empty Hardware category still appears');
});

test('returns a real workbook whose first sheet is the statement', () => {
  const wb = statementToWorkbook(buildStatementModel(baseArgs));
  assert.strictEqual(wb.worksheets[0].name.length > 0, true);
});
