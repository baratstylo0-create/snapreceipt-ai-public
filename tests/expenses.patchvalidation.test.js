'use strict';
// Security hardening (checklist: "no server-side validation" / "reject anything unexpected"):
// PATCH /api/expenses must validate the incoming body server-side, not trust the browser.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeExpensePatch } = require('../routes/expenses');

test('only allow-listed fields survive — account_id / id / voucher_no / receipt_url are dropped', () => {
  const r = sanitizeExpensePatch({
    merchant: 'Shell', amount: 42.5, category: 'Fuel & Auto',
    account_id: 'other-tenant', id: 'spoofed', voucher_no: 'RC-9999-9999', receipt_url: 'x/y.png', rep_chat_id: '999',
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['amount', 'category', 'merchant']);
});

test('money fields must be finite numbers — object/array/boolean/NaN/Infinity rejected', () => {
  for (const bad of [{}, [], true, 'not-a-number', null, Infinity, -Infinity]) {
    const r = sanitizeExpensePatch({ amount: bad });
    assert.strictEqual(r.ok, false, 'amount=' + JSON.stringify(bad) + ' must be rejected');
    assert.match(r.error, /finite number/);
  }
});
test('a numeric string is accepted and coerced to a number', () => {
  const r = sanitizeExpensePatch({ amount: '42.50', subtotal: '40', tax: '2.5' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.body.amount, 42.5);
  assert.strictEqual(r.body.subtotal, 40);
  assert.strictEqual(r.body.tax, 2.5);
});

test('status must be a known workflow value — arbitrary status rejected', () => {
  assert.strictEqual(sanitizeExpensePatch({ status: 'saved' }).ok, true);
  assert.strictEqual(sanitizeExpensePatch({ status: 'approved' }).ok, true);
  for (const bad of ['deleted', 'admin', '', 42, { x: 1 }]) {
    const r = sanitizeExpensePatch({ status: bad });
    assert.strictEqual(r.ok, false, 'status=' + JSON.stringify(bad) + ' must be rejected');
    assert.strictEqual(r.error, 'invalid status');
  }
});

test('text fields must be strings and are length-bounded (untrusted text, DoS-adjacent)', () => {
  assert.strictEqual(sanitizeExpensePatch({ merchant: 123 }).ok, false);
  const long = 'x'.repeat(5000);
  const r = sanitizeExpensePatch({ remark: long });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.body.remark.length, 2000);
});

// ADR-023 Phase 9: claim_override is the manual pin (admin/clerk beats the computed claim result
// for one expense). Allow-listed with strict values only — 'claim' | 'petty_cash' | null. null is
// explicitly allowed (it CLEARS the pin, back to computed); anything else is rejected.
test('claim_override accepts only claim/petty_cash/null (Phase 9)', () => {
  assert.strictEqual(sanitizeExpensePatch({ claim_override: 'claim' }).body.claim_override, 'claim');
  assert.strictEqual(sanitizeExpensePatch({ claim_override: 'petty_cash' }).body.claim_override, 'petty_cash');
  const cleared = sanitizeExpensePatch({ claim_override: null });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.body.claim_override, null, 'null clears the pin (back to computed)');
  for (const bad of ['CLAIM', 'reimburse', '', 1, true, {}, []]) {
    const r = sanitizeExpensePatch({ claim_override: bad });
    assert.strictEqual(r.ok, false, 'claim_override=' + JSON.stringify(bad) + ' must be rejected');
    assert.match(r.error, /claim_override/);
  }
});

test('garbage/non-object body never throws -> empty body (route turns that into a 400)', () => {
  for (const bad of [null, undefined, 'str', 42, []]) {
    const r = sanitizeExpensePatch(bad);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.body, {});
  }
});
