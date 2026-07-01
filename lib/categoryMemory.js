'use strict';
// #6 learning memory — per-account category corrections (SparkReceipt-style learning).
// Backed by the `category_corrections` table (migration: db/2026-07-01-category_corrections.sql,
// applied by Barat). Degrades gracefully: if the table is absent, reads return empty maps and
// writes are best-effort no-ops, so #6 works on rules + LLM until the table exists.
//
// Namespace import so tests can stub sbSelect/sbInsert/sbUpdate (same pattern as routes/reports).
const supabase = require('./supabase');

// Normalise a key the same way on read and write (lowercase, trim, collapse whitespace).
function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

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
async function recordCorrection(merchant, description, category) {
  if (!category) return;
  const signals = [];
  const mk = norm(merchant);
  const dk = norm(description);
  if (mk) signals.push(['merchant', mk]);
  if (dk) signals.push(['description', dk]);
  for (const [match_type, match_value] of signals) {
    try {
      const existing = await supabase.sbSelect('category_corrections', { eq: { match_type, match_value } });
      const now = new Date().toISOString();
      if (existing && existing[0]) {
        await supabase.sbUpdate('category_corrections', { id: existing[0].id },
          { category, hit_count: (Number(existing[0].hit_count) || 1) + 1, updated_at: now });
      } else {
        await supabase.sbInsert('category_corrections', { match_type, match_value, category, hit_count: 1, updated_at: now });
      }
    } catch { /* best-effort learning; table may not exist yet */ }
  }
}

module.exports = { loadMemory, recordCorrection, norm };
