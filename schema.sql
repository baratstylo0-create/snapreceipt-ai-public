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
