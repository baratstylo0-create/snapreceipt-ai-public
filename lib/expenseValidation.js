'use strict';
// Server-side validation for PATCH /api/expenses (security checklist: "no server-side
// validation" / "reject anything unexpected"). Only the allow-listed fields are considered
// (account_id / id / voucher_no / receipt_url etc. can NEVER be set from the client). Money
// fields must be FINITE numbers — an object/array/boolean/NaN/Infinity is rejected, never
// written (the DB numeric column is a backstop, but defense-in-depth validates here too).
// `status` must be a known workflow value (no arbitrary status). Text fields must be strings
// and are length-bounded (untrusted text, DoS-adjacent). Pure + never throws.
//
// Extracted from routes/expenses.js (ADR-019) so the dashboard agent's propose-edit tool can
// reuse the EXACT same validation the PATCH endpoint uses, instead of duplicating it.
const PATCH_ALLOW = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark', 'subtotal', 'tax', 'claim_override'];
const MONEY_FIELDS = new Set(['amount', 'subtotal', 'tax']);
const VALID_STATUS = new Set(['saved', 'needs_review', 'approved', 'rejected', 'awaiting_category', 'awaiting_remark']);
// ADR-023 Phase 9: the petty-cash claim pin. Only these enum values or null (null clears it back to
// the computed result); the DB has a matching CHECK constraint as a backstop.
const VALID_CLAIM_OVERRIDE = new Set(['claim', 'petty_cash']);
const MAX_TEXT_LEN = 2000;

function sanitizeExpensePatch(rawBody) {
  const src = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) ? rawBody : {};
  const body = {};
  for (const k of PATCH_ALLOW) {
    if (!(k in src)) continue;
    const v = src[k];
    if (MONEY_FIELDS.has(k)) {
      const n = Number(v);
      if (v === null || typeof v === 'object' || typeof v === 'boolean' || !Number.isFinite(n)) {
        return { ok: false, error: 'invalid value for ' + k + ' (must be a finite number)' };
      }
      body[k] = n;
    } else if (k === 'status') {
      if (typeof v !== 'string' || !VALID_STATUS.has(v)) return { ok: false, error: 'invalid status' };
      body[k] = v;
    } else if (k === 'claim_override') {
      // null explicitly clears the pin; otherwise must be one of the two enum values.
      if (v === null) { body[k] = null; continue; }
      if (typeof v !== 'string' || !VALID_CLAIM_OVERRIDE.has(v)) {
        return { ok: false, error: 'invalid claim_override (must be claim, petty_cash, or null)' };
      }
      body[k] = v;
    } else {
      if (typeof v !== 'string') return { ok: false, error: 'invalid value for ' + k + ' (must be text)' };
      body[k] = v.slice(0, MAX_TEXT_LEN);
    }
  }
  return { ok: true, body };
}

module.exports = { sanitizeExpensePatch, PATCH_ALLOW, MONEY_FIELDS, VALID_STATUS, MAX_TEXT_LEN };
