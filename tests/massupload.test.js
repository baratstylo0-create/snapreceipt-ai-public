'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runBatch } = require('../lib/massupload');

// Fake extractReceipts: keyed by the image value (a string here) to script per-image behavior.
function fakes(script) {
  const assembleCalls = [];
  const extractReceipts = async (image) => {
    const s = script[image];
    if (s.throw) throw new Error(s.throw);
    return { receipts: s.receipts, truncated: !!s.truncated };
  };
  const assembleExpense = async (arg) => {
    assembleCalls.push(arg);
    if (arg.fields && arg.fields.__fail) throw new Error('assemble boom');
    return { expense: { merchant: arg.fields ? arg.fields.merchant : undefined }, flagged: arg.fields ? arg.fields.__flag : false };
  };
  return { extractReceipts, assembleExpense, assembleCalls };
}
const FS = { columns: [{ key: 'merchant', type: 'text' }] };

test('all-success batch: saved == total receipts, failed empty, meta passed through', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Shell' }, rawParsed: { a: 1 } }, { fields: { merchant: 'Tesco' }, rawParsed: {} }] },
    img2: { receipts: [{ fields: { merchant: 'Aldi' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense, meta: { repName: 'Dashboard', fileId: null } });
  assert.equal(s.images, 2);
  assert.equal(s.receipts, 3);
  assert.equal(s.saved, 3);
  assert.deepEqual(s.failed, []);
  assert.equal(f.assembleCalls[0].repName, 'Dashboard');    // meta passed
  assert.equal(f.assembleCalls[0].fieldSpec, FS);           // fieldSpec passed
  assert.equal(f.assembleCalls[0].rawParsed.a, 1);          // rawParsed passed
});

test('one image extract throws: that image failed, others fully processed', async () => {
  const f = fakes({
    img1: { throw: 'blurry' },
    img2: { receipts: [{ fields: { merchant: 'Aldi' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].image_index, 0);
  assert.equal(s.failed[0].reason, 'blurry');
  assert.equal('receipt_index' in s.failed[0], false); // whole-image failure has no receipt_index
});

test('one receipt assemble throws: that receipt failed, siblings saved', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Ok' }, rawParsed: {} }, { fields: { __fail: true }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.equal(s.receipts, 2);
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.deepEqual({ i: s.failed[0].image_index, j: s.failed[0].receipt_index }, { i: 0, j: 1 });
});

test('truncated image index recorded; flagged receipts aggregated', async () => {
  const f = fakes({
    img1: { truncated: true, receipts: [{ fields: { merchant: 'Fuel', __flag: 'anomaly:dup' }, rawParsed: {} }] },
  });
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.deepEqual(s.truncated_images, [0]);
  assert.equal(s.saved, 1);
  assert.equal(s.flagged.length, 1);
  assert.deepEqual({ i: s.flagged[0].image_index, m: s.flagged[0].merchant, r: s.flagged[0].reason }, { i: 0, m: 'Fuel', r: 'anomaly:dup' });
});

test('empty images -> zeroed summary, never throws', async () => {
  const f = fakes({});
  const s = await runBatch([], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.deepEqual(s, { images: 0, receipts: 0, saved: 0, skipped: 0, failed: [], flagged: [], truncated_images: [] });
});

// 2026-07-03: assembleExpense now returns skipped:true for a receipt it decided is not
// a real receipt (no merchant, no positive amount) and does not insert it. runBatch must
// count that separately from `saved`, not as a save and not as a failure.
test('a skipped (non-receipt) result is counted in `skipped`, not `saved`, not `failed`', async () => {
  const extractReceipts = async () => ({ receipts: [
    { fields: { merchant: 'Real Shop' }, rawParsed: {} },
    { fields: { merchant: 'Unknown', amount: 0 }, rawParsed: {} },
  ] });
  const assembleExpense = async (arg) => (
    arg.fields.merchant === 'Real Shop'
      ? { expense: { merchant: 'Real Shop' }, flagged: false, skipped: false }
      : { expense: { merchant: 'Unknown' }, flagged: false, skipped: true }
  );
  const s = await runBatch(['img1'], FS, { extractReceipts, assembleExpense });
  assert.equal(s.receipts, 2);
  assert.equal(s.saved, 1);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.failed, []);
});

// Backward-compat: an older fake that never returns `skipped` at all (undefined, not
// `false`) must behave exactly as before this change — everything counted as saved.
test('back-compat: assembleExpense results with no `skipped` key are all counted as saved', async () => {
  const f = fakes({ img1: { receipts: [{ fields: { merchant: 'Shell' }, rawParsed: {} }, { fields: { merchant: 'Tesco' }, rawParsed: {} }] } });
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense: f.assembleExpense });
  assert.equal(s.saved, 2);
  assert.equal(s.skipped, 0);
});

test('extractReceipts throws a plain string: image failed with string reason, others processed', async () => {
  const extractReceipts = async (image) => {
    if (image === 'img1') throw 'blurry-string';
    return { receipts: [{ fields: { merchant: 'Aldi' }, rawParsed: {} }] };
  };
  const assembleExpense = async (arg) => ({ expense: { merchant: arg.fields && arg.fields.merchant }, flagged: false });
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts, assembleExpense });
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].image_index, 0);
  assert.equal(s.failed[0].reason, 'blurry-string');
  assert.equal(s.saved, 1);
});

test('assembleExpense throws undefined: receipt failed with string reason, siblings saved', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Ok' }, rawParsed: {} }, { fields: { merchant: 'Boom' }, rawParsed: {} }] },
  });
  const assembleExpense = async (arg) => {
    if (arg.fields && arg.fields.merchant === 'Boom') throw undefined;
    return { expense: { merchant: arg.fields.merchant }, flagged: false };
  };
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense });
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].receipt_index, 1);
  assert.equal(typeof s.failed[0].reason, 'string');
  assert.equal(s.failed[0].reason, 'undefined');
});

test('assembleExpense resolves null: receipt failed (destructure throws), siblings saved', async () => {
  const f = fakes({
    img1: { receipts: [{ fields: { merchant: 'Ok' }, rawParsed: {} }, { fields: { merchant: 'Null' }, rawParsed: {} }] },
  });
  const assembleExpense = async (arg) => {
    if (arg.fields && arg.fields.merchant === 'Null') return null;
    return { expense: { merchant: arg.fields.merchant }, flagged: false };
  };
  const s = await runBatch(['img1'], FS, { extractReceipts: f.extractReceipts, assembleExpense });
  assert.equal(s.saved, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].receipt_index, 1);
  assert.equal(typeof s.failed[0].reason, 'string');
});

test('malformed extractReceipts output treated as zero receipts, no failed entry, image succeeds', async () => {
  const extractReceipts = async (image) => {
    if (image === 'img1') return {};
    if (image === 'img2') return { receipts: 'junk' };
    return { receipts: [] };
  };
  const assembleExpense = async () => { throw new Error('should not be called'); };
  const s = await runBatch(['img1', 'img2'], FS, { extractReceipts, assembleExpense });
  assert.equal(s.images, 2);
  assert.equal(s.receipts, 0);
  assert.equal(s.saved, 0);
  assert.deepEqual(s.failed, []);
});

test('runBatch called with no deps argument: resolves, image lands in failed', async () => {
  const s = await runBatch(['x'], FS);
  assert.equal(s.images, 1);
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].image_index, 0);
  assert.equal(typeof s.failed[0].reason, 'string');
});
