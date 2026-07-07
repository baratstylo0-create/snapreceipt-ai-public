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

-- ============================================================================
-- Migration M2-P1: business-account identity foundation (ADR-021)
-- Jeevan · 2026-07-06 · docs/specs/2026-07-06-business-account-multibranch-design.md §5
-- ----------------------------------------------------------------------------
-- Flag-gated by capabilities.multiUser (ADR-010). With the flag OFF these tables
-- simply go unused and the personal product is unchanged (personal expense rows
-- leave branch_id/staff_user_id null). One account_id = one client business;
-- `branches` partitions it, `users` are the credentialed identities (admin/clerk)
-- plus a staff name-directory, `sessions` are opaque bearer tokens (only a hash is
-- stored), `bot_bindings` link a Telegram chat to a user/branch/role via a one-time
-- deep-link token. Isolation for v1 is enforced APP-SIDE (the scopeForUser bouncer +
-- service-role key); JWT-scoped RLS is the later hardening step — policies are
-- commented below, not enabled (ADR-021).
-- ============================================================================

-- branches: an HQ + its offices. "Head Office" is auto-created at account setup
-- (Phase 2) so the admin can also capture (petty-cash audit).
create table if not exists branches (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  office      text        not null,                 -- branch/office name, e.g. "Head Office", "KL Branch"
  state       text,                                 -- optional region/state label
  clerk_name  text,                                 -- display name of the branch's clerk (attribution)
  active      boolean     not null default true,    -- soft-revoke: false = disabled, never hard-deleted
  created_at  timestamptz not null default now()
);
create index if not exists branches_account_active_idx on branches (account_id) where active;

-- users: credentialed identities (admin/clerk log in) + staff name-directory
-- (staff rows carry a display_name only — no username/hash/bot, attribution only).
create table if not exists users (
  id            uuid        primary key default gen_random_uuid(),
  account_id    text        not null default 'default',
  branch_id     uuid        references branches(id) on delete set null, -- null for admin (all-branch)
  role          text        not null check (role in ('admin', 'clerk', 'staff')),
  username      text,                               -- login handle (admin/clerk); null for staff
  password_hash text,                               -- scrypt hash (admin/clerk); null for staff
  display_name  text        not null default '',
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);
-- one username per account (partial: staff have null usernames and don't collide).
create unique index if not exists users_account_username_idx
  on users (account_id, username) where username is not null;
create index if not exists users_account_branch_idx on users (account_id, branch_id);

-- sessions: opaque bearer tokens. We store ONLY the sha-256 of the token (never the
-- token itself), so a leaked DB dump can't be replayed as a live session. role/branch_id
-- are denormalized from users so the auth gate resolves a scope in one lookup.
create table if not exists sessions (
  token_hash  text        primary key,             -- sha-256(hex) of the opaque bearer token
  user_id     uuid        not null references users(id) on delete cascade,
  account_id  text        not null default 'default',
  role        text        not null,
  branch_id   uuid,                                 -- null for admin (sees all branches)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists sessions_user_idx   on sessions (user_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- bot_bindings: a one-time /start <token> deep link binds a Telegram chat_id to a
-- user/branch/role (both clerk and admin bind; staff never do). Locked once bound.
create table if not exists bot_bindings (
  id               uuid        primary key default gen_random_uuid(),
  account_id       text        not null default 'default',
  user_id          uuid        references users(id) on delete cascade,
  branch_id        uuid,
  role             text        not null,
  chat_id          text,                            -- Telegram chat id; null until /start <token> binds it
  bind_token       text        not null,            -- one-time deep-link token
  token_expires_at timestamptz not null,
  bound_at         timestamptz,                      -- non-null once a chat_id is bound
  active           boolean     not null default true,
  created_at       timestamptz not null default now()
);
create unique index if not exists bot_bindings_token_idx on bot_bindings (bind_token);
create index if not exists bot_bindings_chat_idx
  on bot_bindings (account_id, chat_id) where chat_id is not null;

-- Additive expenses columns — personal rows leave these null (behaviour unchanged).
alter table expenses
  add column if not exists branch_id     uuid,      -- which branch captured this receipt (business only)
  add column if not exists staff_user_id uuid;      -- which staff member (attribution; business only)
create index if not exists expenses_account_branch_idx on expenses (account_id, branch_id)
  where branch_id is not null;

-- RLS on the new tables (service_role bypasses; no anon policy → anon denied), matching
-- every other table. JWT-scoped tenant isolation is the LATER hardening step (ADR-021):
--   create policy tenant_read on <tbl> for select to authenticated
--     using (account_id = (auth.jwt() ->> 'account_id'));
alter table branches     enable row level security;
alter table users        enable row level security;
alter table sessions     enable row level security;
alter table bot_bindings enable row level security;

-- ============================================================================
-- Migration M2-P4: payments + optimistic concurrency (ADR-021 Phase 4)
-- Jeevan · 2026-07-07 · docs/plans/2026-07-06-business-account-multibranch.md Phase 4
-- ----------------------------------------------------------------------------
-- payment_status: per-receipt reimbursement state (admin edits / clerk views).
-- 'pending' default keeps personal rows harmless (the personal UI never shows it).
-- updated_at + a touch trigger back the excel-lite grid's optimistic concurrency
-- (a stale edit is detected by comparing the client's copy of updated_at → 409).
-- The trigger, not app code, bumps it — every write path (dashboard, bot, agent,
-- review, bulk-pay) is covered without each one remembering to.
-- ============================================================================
alter table expenses
  add column if not exists payment_status text        not null default 'pending'
    check (payment_status in ('pending', 'paid')),
  add column if not exists paid_at        timestamptz,           -- when marked paid (null = pending)
  add column if not exists paid_note      text,                  -- optional admin note ("July claim run")
  add column if not exists updated_at     timestamptz not null default now();

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists expenses_touch_updated_at on expenses;
create trigger expenses_touch_updated_at
  before update on expenses
  for each row execute function touch_updated_at();

create index if not exists expenses_account_payment_idx on expenses (account_id, payment_status)
  where deleted_at is null;

-- ============================================================================
-- Migration M2-P7: "Send to Admin" branch submissions (ADR-022 Phase 7)
-- Jeevan · 2026-07-07 · docs/plans/2026-07-06-business-account-multibranch.md Phase 7
-- ----------------------------------------------------------------------------
-- A clerk submits their branch's period (month) to the admin IN-dashboard —
-- replaces the WhatsApp/chat-app file hand-off (audit-trailed: who/branch/
-- period/when). One row per (account, branch, period): a re-submit UPDATES the
-- row (status back to 'submitted', new timestamp), never duplicates. Reversible:
-- 'withdrawn' flips it back without deleting the audit row. The data itself
-- never moves — rows are already in the shared DB (rows-not-workbooks, ADR-021);
-- this is a lightweight state-change, not a file transfer.
-- ============================================================================
create table if not exists submissions (
  id           uuid        primary key default gen_random_uuid(),
  account_id   text        not null default 'default',
  company_id   uuid,                              -- ADR-023 dimension (null until Phase 8 lands)
  branch_id    uuid        not null,
  period       text        not null,              -- 'YYYY-MM' (server-validated)
  submitted_by uuid,                              -- users.id of the submitting clerk
  status       text        not null default 'submitted'
    check (status in ('submitted', 'withdrawn')),
  note         text,                              -- optional clerk note, length-capped in the route
  submitted_at timestamptz not null default now(),-- bumped on every re-submit
  created_at   timestamptz not null default now()
);

create unique index if not exists submissions_branch_period_idx
  on submissions (account_id, branch_id, period);
create index if not exists submissions_account_period_idx on submissions (account_id, period);

alter table submissions enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).

-- ============================================================================
-- Migration M2-P8: company dimension — Group → Company → Branch → Staff (ADR-023)
-- Jeevan · 2026-07-07 · docs/handoff/2026-07-07-phases-8-10/01-phase8-company-dimension.md
-- ----------------------------------------------------------------------------
-- Flag-gated by capabilities.companyDimension (ADR-010). With the flag OFF the table
-- goes unused and every company_id stays null — the single-company product is
-- byte-for-byte unchanged. A client with multiple legal entities (e.g. Premala) turns
-- it on: `companies` is the new top level; branches/users/expenses/sessions/bot_bindings
-- gain a nullable company_id (denormalised so the scope resolves in one lookup, exactly
-- like branch_id). Additive + nullable everywhere ⇒ existing rows unaffected.
-- ============================================================================
create table if not exists companies (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  name        text        not null,
  currency    text,                              -- statement currency (falls back to account default)
  template_id uuid,                              -- the company's FieldSpec (category set), field_templates.id
  active      boolean     not null default true, -- soft-delete only (active=false), never hard-deleted
  created_at  timestamptz not null default now()
);
create index if not exists companies_account_active_idx on companies (account_id) where active;

-- Additive company_id columns — null on every existing row (single-company / personal unaffected).
alter table branches     add column if not exists company_id uuid;
alter table users        add column if not exists company_id uuid;   -- denormalised for one-lookup scope
alter table sessions     add column if not exists company_id uuid;   -- denormalised onto the bearer session
alter table bot_bindings add column if not exists company_id uuid;   -- carried onto the clerk's bot binding
alter table expenses     add column if not exists company_id uuid;   -- stamped from the capturer's session/branch
create index if not exists expenses_account_company_idx on expenses (account_id, company_id)
  where company_id is not null;

alter table companies enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).
