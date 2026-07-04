-- ============================================================================
-- Migration: atomic upsert for category_corrections (issue #14)
-- Barat · 2026-07-04
-- Closes a select-then-write race in lib/categoryMemory.js's recordCorrection: two
-- concurrent corrections for the same merchant/description could both read "no existing
-- row", then both try to INSERT — the second would violate the EXISTING
-- unique(account_id, match_type, match_value) constraint (schema.sql's category_corrections
-- table, already in place since the M2-P4 migration) and be silently dropped by
-- recordCorrection's best-effort try/catch, losing the hit_count increment.
-- Idempotent: safe to re-run (create or replace function).
-- ============================================================================

create or replace function upsert_category_correction(
  p_account text, p_match_type text, p_match_value text, p_category text
) returns category_corrections language sql as $$
  insert into category_corrections (account_id, match_type, match_value, category, hit_count, updated_at)
  values (p_account, p_match_type, p_match_value, p_category, 1, now())
  on conflict (account_id, match_type, match_value)
  do update set category   = excluded.category,
                hit_count  = category_corrections.hit_count + 1,
                updated_at = excluded.updated_at
  returning *;
$$;
