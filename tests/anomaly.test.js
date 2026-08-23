'use strict';
// #5 detectAnomalies — the four detectors + aggregation. No network: history + groqChat injected.
const test = require('node:test');
const assert = require('node:assert');
const { detectAnomalies } = require('../lib/anomaly');

const noLLM = { useLLM: false };
const has = (r, type) => r.reasons.some(x => x.type === type);

test('duplicate: same merchant + amount within window is flagged', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'shell', amount: 50, expense_date: '2026-06-02' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
  assert.strictEqual(r.flagged, true);
  assert.strictEqual(r.status_suggestion, 'needs_review');
});

// Issue #162 D13: the matched row itself must ride along (not just its id embedded in a
// text string) so a caller can build "View existing" / "Edit" buttons off it.
test('duplicate: the matched existing row is returned as duplicateOf', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'shell', amount: 50, expense_date: '2026-06-02' }, { history, useLLM: false });
  assert.strictEqual(r.duplicateOf && r.duplicateOf.id, 'a1');
});

test('no duplicate -> duplicateOf is null', async () => {
  const r = await detectAnomalies({ merchant: 'Shell', amount: 999, expense_date: '2026-06-02' }, { history: [], useLLM: false });
  assert.strictEqual(r.duplicateOf, null);
});

test('duplicate: outside the date window is NOT a duplicate', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: '2026-06-20' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), false);
});

test('duplicate: different amount is NOT a duplicate', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 51, expense_date: '2026-06-01' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), false);
});

// 2026-07-17 live incident: the same physical receipt got saved 3x because OCR read its
// merchant name differently each capture ("99 SPEED MART SDN. BHD." vs "99 Speed Mart") —
// the exact-string match missed it entirely. These lock in the fuzzy-match fix.
test('duplicate: legal-suffix variant of the same merchant IS caught (99 Speed Mart incident)', async () => {
  const history = [{ id: 'a1', merchant: '99 SPEED MART SDN. BHD.', amount: 14.50, expense_date: '2026-07-09' }];
  const r = await detectAnomalies({ merchant: '99 Speed Mart', amount: 14.50, expense_date: '2026-07-09' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
  assert.strictEqual(r.duplicateOf && r.duplicateOf.id, 'a1');
});

test('duplicate: suffix variant matches regardless of punctuation/casing (Sdn. Bhd. / SDN BHD / Bhd)', async () => {
  const cases = ['Kedai Runcit Sdn. Bhd.', 'KEDAI RUNCIT SDN BHD', 'Kedai Runcit Bhd'];
  for (const merchant of cases) {
    const history = [{ id: 'a1', merchant, amount: 30, expense_date: '2026-07-09' }];
    const r = await detectAnomalies({ merchant: 'Kedai Runcit', amount: 30, expense_date: '2026-07-09' }, { history, useLLM: false });
    assert.strictEqual(has(r, 'duplicate'), true, 'expected a match against "' + merchant + '"');
  }
});

test('duplicate: a single-character OCR typo still matches (fuzzy similarity fallback)', async () => {
  const history = [{ id: 'a1', merchant: '99 Speed Mart', amount: 14.50, expense_date: '2026-07-09' }];
  const r = await detectAnomalies({ merchant: '99 Speed Mrt', amount: 14.50, expense_date: '2026-07-09' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
});

test('duplicate: genuinely different merchants with the same amount/date are NOT matched (no false positive)', async () => {
  const history = [{ id: 'a1', merchant: '99 Speed Mart', amount: 14.50, expense_date: '2026-07-09' }];
  const r = await detectAnomalies({ merchant: 'KFC', amount: 14.50, expense_date: '2026-07-09' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), false);
});

test('duplicate: different branches of the same chain are NOT matched (Tesco Extra vs Tesco Express)', async () => {
  const history = [{ id: 'a1', merchant: 'Tesco Extra', amount: 20, expense_date: '2026-07-01' }];
  const r = await detectAnomalies({ merchant: 'Tesco Express', amount: 20, expense_date: '2026-07-01' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), false);
});

// 2026-08-23 (issue #4 hardening): a genuinely unparseable/missing date on EITHER side
// used to bail the whole comparison out, letting an obvious merchant+amount duplicate
// through unflagged. Now it falls back to merchant+amount alone in that case.
test('duplicate: still caught when the NEW expense has an unparseable date', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: 'not-a-date' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
  assert.strictEqual(r.duplicateOf && r.duplicateOf.id, 'a1');
});

test('duplicate: still caught when the EXISTING history row has a missing date', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: null }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: '2026-06-02' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
  assert.strictEqual(r.duplicateOf && r.duplicateOf.id, 'a1');
});

test('duplicate: both dates missing still matches on merchant+amount alone', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '' }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: '' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), true);
});

test('duplicate: a missing date does not create a false positive against a different merchant', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: null }];
  const r = await detectAnomalies({ merchant: 'KFC', amount: 50, expense_date: '2026-06-02' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'duplicate'), false);
});

test('outlier: amount >> median for the merchant is flagged', async () => {
  const history = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, merchant: 'Cafe', amount: 10 + i, expense_date: '2026-06-0' + (i + 1) }));
  const r = await detectAnomalies({ merchant: 'Cafe', amount: 500, expense_date: '2026-06-10' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'outlier'), true);
});

test('outlier: a normal amount is NOT flagged', async () => {
  const history = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, merchant: 'Cafe', amount: 10 + i }));
  const r = await detectAnomalies({ merchant: 'Cafe', amount: 14, expense_date: '2026-06-10' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'outlier'), false);
});

test('outlier: not enough history -> not flagged', async () => {
  const history = [{ id: 'a', merchant: 'Cafe', amount: 10 }, { id: 'b', merchant: 'Cafe', amount: 11 }];
  const r = await detectAnomalies({ merchant: 'Cafe', amount: 500, expense_date: '2026-06-10' }, { history, useLLM: false });
  assert.strictEqual(has(r, 'outlier'), false);
});

test('data_quality: missing/zero amount is flagged', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 0, expense_date: '2026-06-01' }, noLLM);
  assert.strictEqual(has(r, 'data_quality'), true);
});

test('data_quality: impossible date is flagged', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 10, expense_date: '2026-13-40' }, noLLM);
  assert.ok(r.reasons.some(x => x.type === 'data_quality' && /date/.test(x.detail)));
});

test('data_quality: subtotal + tax != total is flagged', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 100, subtotal: 50, tax: 10, expense_date: '2026-06-01' }, noLLM);
  assert.ok(r.reasons.some(x => x.type === 'data_quality' && /subtotal/.test(x.detail)));
});

test('data_quality: a clean expense (no history) is NOT flagged', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 100, subtotal: 90, tax: 10, expense_date: '2026-06-01' }, noLLM);
  assert.strictEqual(r.flagged, false);
  assert.strictEqual(r.status_suggestion, 'saved');
});

// NB: the personal-vs-business detector is a BUSINESS capability (ADR-010), so these run with
// businessProfile: true (a business account). A personal account skips it — see the test below.
test('personal (LLM): confident-personal is flagged (business account)', async () => {
  const groqChat = async () => JSON.stringify({ personal: true, confidence: 0.9, reason: 'toys, clearly personal' });
  const r = await detectAnomalies({ merchant: 'Toy Store', amount: 40, expense_date: '2026-06-01' }, { businessProfile: true, groqChat });
  assert.strictEqual(has(r, 'personal'), true);
});

test('personal (LLM): business-context says business -> not flagged', async () => {
  const groqChat = async () => JSON.stringify({ personal: false, confidence: 0.9, reason: 'groceries are inventory for a restaurant' });
  const r = await detectAnomalies({ merchant: 'Grocery', amount: 40, expense_date: '2026-06-01' }, { businessProfile: true, businessType: 'restaurant', groqChat });
  assert.strictEqual(has(r, 'personal'), false);
});

test('personal (LLM): low confidence -> not flagged', async () => {
  const groqChat = async () => JSON.stringify({ personal: true, confidence: 0.5, reason: 'maybe' });
  const r = await detectAnomalies({ merchant: 'Shop', amount: 40, expense_date: '2026-06-01' }, { businessProfile: true, groqChat });
  assert.strictEqual(has(r, 'personal'), false);
});

test('personal (LLM): failure/garbage is graceful (no personal flag)', async () => {
  const thrown = await detectAnomalies({ merchant: 'Shop', amount: 40, expense_date: '2026-06-01' }, { businessProfile: true, groqChat: async () => { throw new Error('down'); } });
  const garbage = await detectAnomalies({ merchant: 'Shop', amount: 40, expense_date: '2026-06-01' }, { businessProfile: true, groqChat: async () => 'no json here' });
  assert.strictEqual(has(thrown, 'personal'), false);
  assert.strictEqual(has(garbage, 'personal'), false);
});

test('personal detector is OFF for a personal account (ADR-010), even with a confident LLM', async () => {
  const groqChat = async () => JSON.stringify({ personal: true, confidence: 0.99, reason: 'clearly personal' });
  // businessProfile defaults to false (personal) -> detector never runs
  const r = await detectAnomalies({ merchant: 'Toy Store', amount: 40, expense_date: '2026-06-01' }, { groqChat });
  assert.strictEqual(has(r, 'personal'), false);
});

test('aggregation: multiple detectors -> flagged with multiple reasons', async () => {
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const groqChat = async () => JSON.stringify({ personal: true, confidence: 0.95, reason: 'personal' });
  // duplicate (same merchant/amount/date) + personal (LLM); business account so personal detector runs
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }, { history, businessProfile: true, groqChat });
  assert.strictEqual(has(r, 'duplicate'), true);
  assert.strictEqual(has(r, 'personal'), true);
  assert.ok(r.reasons.length >= 2);
  assert.strictEqual(r.flagged, true);
});

test('garbage input does not throw', async () => {
  const r = await detectAnomalies(null, noLLM);
  assert.strictEqual(r.flagged, false);
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.summary, null);
});

// --- 5. summary (LLM) — one plain-English sentence explaining WHY the row was flagged, so a
// reviewer doesn't have to decode "duplicate"/"outlier"/"data_quality" jargon (Owner report
// 2026-07-14: "even I got confused" reading the raw reasons). Only runs when actually flagged. ---

test('summary: flagged with reasons -> LLM produces a plain-English summary', async () => {
  let seenContent = null;
  const groqChat = async (messages) => { seenContent = messages[1].content; return JSON.stringify({ summary: 'This looks like the same receipt uploaded twice.' }); };
  const history = [{ id: 'a1', merchant: 'Shell', amount: 50, expense_date: '2026-06-01' }];
  const r = await detectAnomalies({ merchant: 'Shell', amount: 50, expense_date: '2026-06-02' }, { history, groqChat });
  assert.strictEqual(r.summary, 'This looks like the same receipt uploaded twice.');
  assert.ok(seenContent.includes('duplicate'));
  assert.ok(seenContent.includes('Shell'));
});

test('summary: not flagged -> summary is null (LLM never runs)', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 100, subtotal: 90, tax: 10, expense_date: '2026-06-01' }, noLLM);
  assert.strictEqual(r.flagged, false);
  assert.strictEqual(r.summary, null);
});

test('summary: useLLM:false -> summary null even though flagged', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 0, expense_date: '2026-06-01' }, noLLM);
  assert.strictEqual(r.flagged, true);
  assert.strictEqual(r.summary, null);
});

test('summary: LLM failure -> summary null, flagged/reasons still returned (never blocks the save)', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 0, expense_date: '2026-06-01' },
    { groqChat: async () => { throw new Error('down'); } });
  assert.strictEqual(r.flagged, true);
  assert.ok(r.reasons.length > 0);
  assert.strictEqual(r.summary, null);
});

test('summary: malformed/non-JSON LLM output -> summary null, no throw', async () => {
  const r = await detectAnomalies({ merchant: 'X', amount: 0, expense_date: '2026-06-01' },
    { groqChat: async () => 'not json' });
  assert.strictEqual(r.summary, null);
});
