'use strict';
// QA report #1 — summarize() must surface WHAT was extracted (merchant/amount/category/
// voucher_no per saved receipt), not just a bare count, so the render layer can show it.
const test = require('node:test');
const assert = require('node:assert');
const Upload = require('../../public/js/components/upload');

test('summarize: carries saved_items through as savedItems', () => {
  const items = [{ id: 'a', merchant: 'Shell', amount: 42.5, currency: 'MYR', category: 'Fuel & Auto', voucher_no: 'RC-2026-0001' }];
  const vm = Upload.summarize({ images: 1, receipts: 1, saved: 1, failed: [], flagged: [], truncated_images: [], saved_items: items });
  assert.deepStrictEqual(vm.savedItems, items);
});
test('summarize: missing/non-array saved_items -> [], never throws', () => {
  assert.deepStrictEqual(Upload.summarize({ saved: 1 }).savedItems, []);
  assert.deepStrictEqual(Upload.summarize({ saved_items: 'nope' }).savedItems, []);
  assert.deepStrictEqual(Upload.summarize(null).savedItems, []);
});
