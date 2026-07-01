-- #6 categorization learning memory.
-- OWNER of schema = Barat: please review and apply this in the Supabase SQL Editor, then fold it
-- into schema.sql. Stores human category corrections so future identical merchants / line-items
-- auto-categorize (SparkReceipt-style learning). Until this is applied, #6 degrades gracefully:
-- lib/categoryMemory returns empty memory and #6 runs on rules + LLM only.

create table if not exists public.category_corrections (
  id          uuid primary key default gen_random_uuid(),
  account_id  text not null default 'default',
  match_type  text not null check (match_type in ('merchant', 'description')),
  match_value text not null,          -- normalized (lowercased, trimmed, whitespace-collapsed)
  category    text not null,
  hit_count   integer not null default 1,
  updated_at  timestamptz not null default now(),
  unique (account_id, match_type, match_value)
);

-- service-role only (server-side), consistent with the rest of the schema; no anon policy.
alter table public.category_corrections enable row level security;

create index if not exists category_corrections_lookup
  on public.category_corrections (account_id, match_type, match_value);
