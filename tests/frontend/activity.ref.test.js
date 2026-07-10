'use strict';
// refDisplay — the voucher/reference-number cell (RC-2026-0041) in the Activity view.
// Falls back to an em dash for rows that predate the voucher migration so the column
// is never a blank/undefined cell.
const test = require('node:test');
const assert = require('node:assert');
const Activity = require('../../public/js/components/activity');

test('receiptKind: stored pdf receipts are classified as a PDF reference, images as image references', () => {
  assert.strictEqual(Activity.receiptKind({ receipt_url: 'default/receipt-1.pdf' }), 'pdf');
  assert.strictEqual(Activity.receiptKind({ receipt_url: 'default/receipt-1.png' }), 'image');
  assert.strictEqual(Activity.receiptKind({ receipt_url: 'default/receipt-1.jpg' }), 'image');
});

test('receiptKind: legacy Telegram file ids stay viewable even when the extension is unknown', () => {
  assert.strictEqual(Activity.receiptKind({ receipt_file_id: 'AgACAgUAAxkBAA' }), 'unknown');
  assert.strictEqual(Activity.receiptKind({}), 'none');
});

test('receiptLabel: user-facing label says PDF for pdf receipts instead of image', () => {
  assert.strictEqual(Activity.receiptLabel({ receipt_url: 'default/bill.pdf' }), 'Receipt PDF');
  assert.strictEqual(Activity.receiptLabel({ receipt_url: 'default/bill.png' }), 'Receipt image');
});

test('refDisplay: shows the voucher_no when present', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: 'RC-2026-0041' }), 'RC-2026-0041');
});
test('refDisplay: trims surrounding whitespace', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: '  RC-2026-0001  ' }), 'RC-2026-0001');
});
test('refDisplay: missing / empty / null voucher_no -> em dash (never blank)', () => {
  assert.strictEqual(Activity.refDisplay({ voucher_no: '' }), '—');
  assert.strictEqual(Activity.refDisplay({ voucher_no: null }), '—');
  assert.strictEqual(Activity.refDisplay({}), '—');
});
test('refDisplay: null/garbage row never throws', () => {
  assert.strictEqual(Activity.refDisplay(null), '—');
  assert.strictEqual(Activity.refDisplay({ voucher_no: 123 }), '—'); // non-string is ignored
});
