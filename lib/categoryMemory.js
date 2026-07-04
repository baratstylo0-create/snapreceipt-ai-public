'use strict';
// #6 learning memory — per-account category corrections (SparkReceipt-style learning).
// Backed by the `category_corrections` table (migration: db/2026-07-01-category_corrections.sql,
// applied by Barat). Degrades gracefully: if the table is absent, reads return empty maps and
// writes are best-effort no-ops, so #6 works on rules + LLM until the table exists.
//
// Namespace import so tests can stub sbSelect/sbRpc (same pattern as routes/reports).
const supabase = require('./supabase');
const { cfg } = require('./config');

// Normalise a key the same way on read and write (lowercase, trim, collapse whitespace).
// Capped at 200 chars (#14): match_value stores untrusted merchant/description text and
// is otherwise unbounded (a giant OCR string would bloat the row / index — DoS-adjacent).
// The cap is applied identically on read and write, so a truncated key still matches.
const MATCH_VALUE_MAX = 200;
function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MATCH_VALUE_MAX); }

// loadMemory() -> { merchant: Map<key,category>, description: Map<key,category> }
// Highest hit_count wins per key (rows come ordered desc; first occurrence kept).
async function loadMemory() {
  let rows = [];
  try { rows = await supabase.sbSelect('category_corrections', { order: 'hit_count.desc' }); }
  catch { rows = []; }
  const merchant = new Map();
  const description = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.category) continue;
    const key = norm(r.match_value);
    if (!key) continue;
    const bucket = r.match_type === 'merchant' ? merchant
      : r.match_type === 'description' ? description : null;
    if (bucket && !bucket.has(key)) bucket.set(key, r.category);
  }
  return { merchant, description };
}

// recordCorrection(merchant, description, category)
// Upserts a merchant-level AND a description-level signal (whichever are present),
// incrementing hit_count on repeat. Best-effort: never throws to the caller.
//
// Issue #14 fix (2026-07-04): this used to be a select-then-insert-or-update — a real
// TOCTOU race. Two concurrent corrections for the same merchant/description could both
// read "no existing row", then both try to INSERT; the second would violate the table's
// unique(account_id, match_type, match_value) constraint and be silently swallowed by the
// try/catch below, losing that correction's hit_count increment entirely. Now a single
// atomic upsert via the `upsert_category_correction` Postgres function (schema.sql —
// INSERT ... ON CONFLICT DO UPDATE, same pattern as ADR-017's voucher counter), called
// through sbRpc. Falls back to a no-op (same as before) if the function/table doesn't
// exist yet on an unmigrated DB — degrades exactly as gracefully as the old code did.
async function recordCorrection(merchant, description, category) {
  if (!category) return;
  const signals = [];
  const mk = norm(merchant);
  const dk = norm(description);
  if (mk) signals.push(['merchant', mk]);
  if (dk) signals.push(['description', dk]);
  for (const [match_type, match_value] of signals) {
    try {
      await supabase.sbRpc('upsert_category_correction', {
        p_account: cfg.ACCOUNT_ID, p_match_type: match_type, p_match_value: match_value, p_category: category,
      });
    } catch { /* best-effort learning; function/table may not exist yet on an unmigrated DB */ }
  }
}

module.exports = { loadMemory, recordCorrection, norm };
