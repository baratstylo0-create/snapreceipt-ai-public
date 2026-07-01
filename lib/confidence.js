'use strict';
// #11 Per-field confidence + low-confidence flags. OWNER: Barat.
// Exports scoreConfidence() (ARCHITECTURE §2, §4 data flow: ocr.extractReceipt -> scoreConfidence).
//
// Principle (SOP §7.3 + BARAT.md §3): NEVER silently guess. When the model did
// not clearly read a field, mark it low so a human can review it — especially
// required fields and money amounts.

// A field is "present" if the model returned a real, non-empty value for it.
// Money/number 0 is treated as NOT confidently read (receipts rarely total 0;
// 0 is almost always our coercion fallback for an unreadable amount).
function isPresent(rawValue, type) {
  if (rawValue === null || rawValue === undefined) return false;
  const s = String(rawValue).trim();
  if (s === '') return false;
  if (type === 'currency' || type === 'number') {
    const n = Number(rawValue);
    return Number.isFinite(n) && n !== 0;
  }
  return true;
}

// scoreConfidence(fieldSpec, rawParsed) -> {
//   perField: { [key]: 'high' | 'low' },   // per FieldSpec column
//   low:      [key, ...],                   // fields needing review
//   flagged:  boolean,                      // any REQUIRED field is low?
//   reason:   string                        // human-readable summary (or '')
// }
// rawParsed = the raw JSON object the model returned (pre-coercion), so we can
// tell "model actually read it" from "we filled a fallback".
function scoreConfidence(fieldSpec, rawParsed) {
  const columns = (fieldSpec && Array.isArray(fieldSpec.columns)) ? fieldSpec.columns : [];
  const raw = (rawParsed && typeof rawParsed === 'object') ? rawParsed : {};
  const perField = {};
  const low = [];
  const missingRequired = [];

  for (const col of columns) {
    const ok = isPresent(raw[col.key], col.type);
    perField[col.key] = ok ? 'high' : 'low';
    if (!ok) {
      low.push(col.key);
      if (col.required) missingRequired.push(col.key);
    }
  }

  const flagged = missingRequired.length > 0;
  const reason = flagged
    ? ('Low confidence on required field(s): ' + missingRequired.join(', ') + ' — please review.')
    : (low.length ? ('Low confidence on: ' + low.join(', ') + '.') : '');

  return { perField, low, flagged, reason };
}

module.exports = { scoreConfidence, isPresent };
