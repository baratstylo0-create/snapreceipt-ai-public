'use strict';
// Tier-2 QA adversarial regressions for lib/massupload.js (#7).
// Charter: BREAK the never-throws contract and money-integrity accounting.
// Every test here is a permanent characterization/regression test.
const { test } = require('node:test');
const assert = require('node:assert');
const { runBatch } = require('../lib/massupload');

const FS = { columns: [{ key: 'merchant', type: 'text' }] };
const okAssemble = async (a) => ({ expense: { merchant: a.fields && a.fields.merchant }, flagged: false });

// --- NEVER-THROWS CONTRACT UNDER ABUSE -------------------------------------

// REGRESSION (was a real never-throws violation): a receipts element accessed via a
// throwing getter escaped runBatch because `summary.receipts += 1` and `receipts[j]`
// were outside the per-receipt try/catch. Model output is untrusted (SOP §7.3); the
// contract says NEVER throws. This must be recorded as a failed receipt, not thrown.
test('receipts[j] throwing getter mid-iteration: never throws, sibling receipts survive', async () => {
  const receipts = [{ fields: { merchant: 'A' }, rawParsed: {} }];
  Object.defineProperty(receipts, '1', { enumerable: true, configurable: true, get() { throw new Error('getter boom'); } });
  Object.defineProperty(receipts, '2', { enumerable: true, configurable: true, value: { fields: { merchant: 'C' } } });
  Object.defineProperty(receipts, 'length', { value: 3 });
  const extractReceipts = async () => ({ receipts, truncated: false });
  let threw = null;
  let s;
  try { s = await runBatch(['x'], FS, { extractReceipts, assembleExpense: okAssemble }); }
  catch (e) { threw = e; }
  assert.equal(threw, null, 'runBatch must never throw even on a hostile receipts getter');
  // index 0 and 2 must still be saved; index 1 must be a receipt-level failure.
  assert.equal(s.saved, 2);
  const rl = s.failed.filter(f => 'receipt_index' in f);
  assert.equal(rl.length, 1);
  assert.equal(rl[0].receipt_index, 1);
  assert.equal(typeof rl[0].reason, 'string');
});

// truncated flag with a throwing toString: only truthiness is inspected, never stringified.
test('truncated: {toString throws} does not throw, index still recorded', async () => {
  const extractReceipts = async () => ({ receipts: [{ fields: { merchant: 'A' } }], truncated: { toString() { throw new Error('t'); } } });
  const s = await runBatch(['x'], FS, { extractReceipts, assembleExpense: okAssemble });
  assert.deepEqual(s.truncated_images, [0]);
  assert.equal(s.saved, 1);
});

// deps that throw synchronously (not async) and non-function deps: caught per-image.
test('extractReceipts throws synchronously: image failed, batch continues', async () => {
  const extractReceipts = (img) => { if (img === 'a') throw new Error('sync boom'); return { receipts: [{ fields: { merchant: 'Z' } }] }; };
  const s = await runBatch(['a', 'b'], FS, { extractReceipts, assembleExpense: okAssemble });
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].image_index, 0);
  assert.equal('receipt_index' in s.failed[0], false);
  assert.equal(s.saved, 1);
});

test('extractReceipts is a primitive (not a function): image failed, never throws', async () => {
  let threw = null; let s;
  try { s = await runBatch(['x'], FS, { extractReceipts: 42, assembleExpense: okAssemble }); }
  catch (e) { threw = e; }
  assert.equal(threw, null);
  assert.equal(s.failed.length, 1);
  assert.equal(s.saved, 0);
});

test('extractReceipts returns a non-promise (sync value): await tolerates it', async () => {
  const extractReceipts = () => ({ receipts: [{ fields: { merchant: 'B' } }] });
  const s = await runBatch(['x'], FS, { extractReceipts, assembleExpense: okAssemble });
  assert.equal(s.saved, 1);
});

// CHARACTERIZATION: destructuring a truthy primitive does NOT throw in JS ({...}=7 boxes
// it, yielding undefined props), so a primitive return is counted as saved with no flag.
// assembleExpense is a trusted server function with a fixed {expense,flagged} contract, so
// this is not a realistic money-inflation vector; a null/undefined return DOES throw and is
// caught (pinned in massupload.test.js). Documented so behavior can't silently change.
test('assembleExpense returns a truthy primitive: counted as saved, never throws', async () => {
  const extractReceipts = async () => ({ receipts: [{ fields: { merchant: 'Ok' } }, { fields: { merchant: 'Bad' } }] });
  const assembleExpense = async (a) => (a.fields.merchant === 'Bad' ? 7 : { expense: {}, flagged: false });
  let threw = null; let s;
  try { s = await runBatch(['x'], FS, { extractReceipts, assembleExpense }); } catch (e) { threw = e; }
  assert.equal(threw, null);
  assert.equal(s.saved, 2);            // primitive boxed -> no throw -> saved
  assert.equal(s.flagged.length, 0);   // undefined `flagged` prop -> not flagged
});

// --- MONEY INTEGRITY AT THE ORCHESTRATOR -----------------------------------

// The core invariant: summary.receipts === saved + (receipt-level failures).
// Prove no crafted per-receipt result can inflate `saved` above real assemble successes.
test('INVARIANT: receipts === saved + receipt-level-failed across mixed outcomes', async () => {
  const extractReceipts = async () => ({ receipts: [
    { fields: { merchant: 'A' } }, { fields: { merchant: 'B' } },
    { fields: { merchant: 'C' } }, { fields: { merchant: 'D' } },
  ] });
  let n = 0;
  const assembleExpense = async (a) => { n++; if (n % 2 === 0) throw new Error('boom'); return { expense: { merchant: a.fields.merchant }, flagged: n === 3 ? 'anomaly' : false }; };
  const s = await runBatch(['x'], FS, { extractReceipts, assembleExpense });
  const receiptFailed = s.failed.filter(f => 'receipt_index' in f).length;
  assert.equal(s.receipts, s.saved + receiptFailed, 'receipts must reconcile with saved + receipt-level failures');
  // saved counts only actual assemble successes, not receipt count.
  assert.equal(s.saved, 2);
  assert.equal(s.flagged.length, 1);
});

// Array-like object with a lying `length` is NOT Array.isArray -> treated as 0 receipts.
// A hostile extractReceipts cannot smuggle a fake-length array to inflate the count.
test('receipts as array-like with lying length is rejected (0 receipts, no saves)', async () => {
  const fakeReceipts = { length: 999, 0: { fields: { merchant: 'Ghost' } } };
  const extractReceipts = async () => ({ receipts: fakeReceipts });
  let saveCalled = false;
  const assembleExpense = async () => { saveCalled = true; return { expense: {}, flagged: false }; };
  const s = await runBatch(['x'], FS, { extractReceipts, assembleExpense });
  assert.equal(s.receipts, 0);
  assert.equal(s.saved, 0);
  assert.equal(saveCalled, false);
  assert.deepEqual(s.failed, []);
});

// --- SPREAD-ORDER SAFETY (hostile meta cannot clobber per-receipt fields) ---

// meta is server-built, but pin the safe spread order as a regression: the explicit
// fields/rawParsed/fieldSpec keys come AFTER ...meta, so meta can never override them.
test('hostile meta cannot clobber fields/rawParsed/fieldSpec (spread order pinned)', async () => {
  let captured;
  const extractReceipts = async () => ({ receipts: [{ fields: { real: 'FIELDS' }, rawParsed: { real: 'RAW' } }] });
  const assembleExpense = async (arg) => { captured = arg; return { expense: {}, flagged: false }; };
  await runBatch(['x'], 'REAL_SPEC', {
    extractReceipts, assembleExpense,
    meta: { fields: { evil: 1 }, rawParsed: { evil: 1 }, fieldSpec: 'EVIL_SPEC', repName: 'Dashboard' },
  });
  assert.deepEqual(captured.fields, { real: 'FIELDS' });
  assert.deepEqual(captured.rawParsed, { real: 'RAW' });
  assert.equal(captured.fieldSpec, 'REAL_SPEC');
  assert.equal(captured.repName, 'Dashboard'); // benign meta still forwarded
});

// --- SEQUENTIAL ORDERING UNDER ABUSE ---------------------------------------

test('images processed strictly sequentially even with varied async delays', async () => {
  const order = [];
  const extractReceipts = async (img) => { await new Promise(r => setTimeout(r, img === 'slow' ? 20 : 1)); order.push(img); return { receipts: [] }; };
  await runBatch(['slow', 'fast1', 'fast2'], FS, { extractReceipts, assembleExpense: okAssemble });
  assert.deepEqual(order, ['slow', 'fast1', 'fast2']);
});
