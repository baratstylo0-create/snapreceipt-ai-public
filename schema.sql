-- ============================================================================
-- Receipt Analyser SaaS — database schema (Supabase / PostgreSQL)
-- ----------------------------------------------------------------------------
-- Run this ONCE on the Supabase project for this SaaS (SQL Editor → paste → Run),
-- or apply it via the Supabase MCP `apply_migration`.
--
-- Single-account v1: every row carries account_id (defaults to 'default').
-- When you grow into multi-tenant SaaS, account_id becomes the tenant key and
-- you add RLS scoped to a JWT claim (see CLAUDE.md → "Going multi-tenant").
-- ============================================================================

create extension if not exists "pgcrypto";   -- for gen_random_uuid()

create table if not exists expenses (
  id              uuid primary key default gen_random_uuid(),
  account_id      text        not null default 'default',
  rep_chat_id     text,                       -- Telegram chat id of the sender
  rep_name        text,                       -- sender's display name
  merchant        text        not null default 'Unknown',
  expense_date    text        not null default '',   -- ISO YYYY-MM-DD (kept TEXT so OCR never 400s)
  amount          numeric     not null default 0,     -- grand total incl. tax
  currency        text        not null default 'USD',
  category        text        not null default 'Others', -- Food | Petrol | Software | Inventory | Others
  subtotal        numeric     default 0,
  tax             numeric     default 0,
  line_items      jsonb       default '[]'::jsonb,
  remark          text,
  receipt_file_id text,                       -- Telegram file_id; served via GET /receipt/:fileId
  receipt_url     text,                       -- optional public URL (unused in v1)
  ai_raw          jsonb,                      -- raw model output for debugging/audit
  status          text        not null default 'saved',
  deleted_at      timestamptz,                -- soft-delete: non-null = hidden from dashboard (recoverable)
  created_at      timestamptz not null default now()
);

create index if not exists expenses_account_created_idx on expenses (account_id, created_at desc);
create index if not exists expenses_account_active_idx  on expenses (account_id) where deleted_at is null;
create index if not exists expenses_account_cat_idx     on expenses (account_id, category);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- The server reads/writes with the SERVICE-ROLE key (bypasses RLS). The browser
-- never touches Supabase directly — it calls the Express /api/expenses endpoint.
-- So we enable RLS and add NO permissive anon policy => anon is denied by default,
-- which is exactly what we want for v1.
alter table expenses enable row level security;

-- (Intentionally no anon/public policy. service_role bypasses RLS automatically.)
-- When you add multi-tenant auth later, add a policy like:
--   create policy tenant_read on expenses for select to authenticated
--     using (account_id = (auth.jwt() ->> 'account_id'));

-- ============================================================================
-- Migration M1-P3: new columns for OCR confidence, anomaly, FX, and templates
-- Barat · 2026-07-01 · ARCHITECTURE §3.4
-- ============================================================================

-- field_templates: one row per account's imported CSV template (#12)
create table if not exists field_templates (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  name        text        not null default 'default',   -- e.g. "My Expense Sheet"
  columns     jsonb       not null default '[]'::jsonb, -- FieldSpec.columns array
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists field_templates_account_name_idx
  on field_templates (account_id, name);

alter table field_templates enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied.

-- New columns on expenses (idempotent: each uses ADD COLUMN IF NOT EXISTS)
alter table expenses
  add column if not exists confidence        jsonb,       -- { field_key: "high"|"low"|"medium" }  (#11)
  add column if not exists anomaly           jsonb,       -- { flagged: bool, reason: text }        (#5)
  add column if not exists currency_original text,        -- source currency before FX conversion   (#10)
  add column if not exists amount_original   numeric,     -- amount in the original currency        (#10)
  add column if not exists fx_rate           numeric,     -- rate applied (original → DEFAULT_CURRENCY) (#10)
  add column if not exists template_id       uuid references field_templates(id) on delete set null; -- (#12)

create index if not exists expenses_template_idx on expenses (account_id, template_id)
  where template_id is not null;

-- ============================================================================
-- Migration M2-P4: category learning memory (#6)
-- Barat · 2026-07-01 · folded in from db/2026-07-01-category_corrections.sql
-- Stores human category corrections so future identical merchants / line-items
-- auto-categorize. If absent, #6 degrades gracefully (rules + LLM only).
-- ============================================================================
create table if not exists category_corrections (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  match_type  text        not null check (match_type in ('merchant', 'description')),
  match_value text        not null,          -- normalized (lowercased, trimmed, whitespace-collapsed)
  category    text        not null,
  hit_count   integer     not null default 1,
  updated_at  timestamptz not null default now(),
  unique (account_id, match_type, match_value)
);

alter table category_corrections enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied.

create index if not exists category_corrections_lookup
  on category_corrections (account_id, match_type, match_value);

-- ============================================================================
-- Migration M2-P4c: atomic upsert for category_corrections (issue #14)
-- Barat · 2026-07-04 · folded in from db/2026-07-04-category-corrections-upsert.sql
-- Closes a select-then-write race in recordCorrection() — see the dated file for the
-- full explanation. Exposed to the app via PostgREST's RPC endpoint (lib/supabase.js's
-- sbRpc), consumed by lib/categoryMemory.js.
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

-- ============================================================================
-- Migration M2-P4b: voucher / human-readable reference number (ADR-017)
-- Barat · 2026-07-03 · folded in from db/2026-07-03-voucher-reference-number.sql
-- Every expense gets a short, human-quotable reference like RC-2026-0041,
-- distinct from the row's UUID. Generated DB-side (trigger + atomic per-
-- (account,year) counter) so it's race-free across every insert path (single
-- photo, Telegram album, PDF, dashboard mass-upload). See the dated file for
-- full comments and the one-time backfill of pre-existing rows.
-- ============================================================================
alter table expenses add column if not exists voucher_no text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_voucher_uq') then
    alter table expenses add constraint expenses_voucher_uq unique (account_id, voucher_no);
  end if;
end $$;

create table if not exists voucher_counters (
  account_id text not null,
  year       int  not null,
  last_seq   int  not null default 0,
  primary key (account_id, year)
);

alter table voucher_counters enable row level security;
-- service_role bypasses RLS; no anon policy -> anon denied.

create or replace function next_voucher_seq(p_account text, p_year int)
returns int language sql as $$
  insert into voucher_counters (account_id, year, last_seq)
  values (p_account, p_year, 1)
  on conflict (account_id, year)
  do update set last_seq = voucher_counters.last_seq + 1
  returning last_seq;
$$;

create or replace function assign_voucher_no() returns trigger language plpgsql as $$
declare y int; s int;
begin
  if new.voucher_no is null then
    y := extract(year from coalesce(new.expense_date::date, current_date))::int;
    s := next_voucher_seq(new.account_id, y);
    new.voucher_no := 'RC-' || y::text || '-' || lpad(s::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_voucher_no on expenses;
create trigger trg_assign_voucher_no before insert on expenses
  for each row execute function assign_voucher_no();

-- ============================================================================
-- Migration M6: per-account UI settings (owner request 2026-07-05)
-- A generic key/value store for account-scoped display preferences that don't
-- warrant their own table. First consumer: the Overview donut's custom
-- category colours (key = 'category_colors', value = { "<category>": "#rrggbb" }),
-- so a user's chosen colours sync across their browsers/devices instead of
-- living only in one browser's localStorage.
-- ============================================================================
-- id primary key + a unique (account_id, key) index — mirrors field_templates,
-- so the frozen lib/supabase.js sbUpdate helper (filters by id) works unchanged.
create table if not exists account_settings (
  id         uuid        primary key default gen_random_uuid(),
  account_id text        not null default 'default',
  key        text        not null,                    -- e.g. 'category_colors'
  value      jsonb       not null default '{}'::jsonb, -- arbitrary per-key JSON
  updated_at timestamptz not null default now()
);

create unique index if not exists account_settings_account_key_idx
  on account_settings (account_id, key);

alter table account_settings enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied.
