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
