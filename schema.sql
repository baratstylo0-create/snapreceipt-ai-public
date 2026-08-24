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

-- Business category set (ADR-021 Phase 5): the account's own chart of accounts,
-- e.g. ["Petrol/Diesel","Touch-n-Go","Entertainment",…]. NULL = use the built-in
-- default CATEGORIES (lib/categorize.js) — personal accounts never set this.
alter table field_templates
  add column if not exists categories jsonb;

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

-- ============================================================================
-- Migration M2-P9: petty-cash floats + claim engine (ADR-023)
-- Jeevan · 2026-07-07 · docs/handoff/2026-07-07-phases-8-10/02-phase9-pettycash-claims.md
-- ----------------------------------------------------------------------------
-- Flag-gated by capabilities.pettyCash (ADR-010). With the flag OFF both tables go
-- unused and no expense carries a claim_override — the product without petty-cash is
-- byte-for-byte unchanged. A client that runs branch floats (e.g. Premala) turns it on:
--   petty_cash_floats — the monthly opening float (balance_bf) per (branch, period), the
--     admin's carried-in cash. One row per (account, branch, period).
--   cash_in           — the Section-A top-ups the admin adds during the period.
-- Balance = (balance_bf + Σ cash_in) − Σ that branch/period's expenses (spec §6). CLAIM status
-- is COMPUTED ON READ (lib/pettyCash.js), never stored, so it can't drift from the numbers;
-- the only stored per-expense signal is claim_override — a manual 'claim'/'petty_cash' pin the
-- admin/clerk sets to beat the computed result for one row. Additive everywhere ⇒ existing rows
-- unaffected (company_id stays null unless companyDimension is also on).
-- ============================================================================
create table if not exists petty_cash_floats (
  id         uuid        primary key default gen_random_uuid(),
  account_id text        not null default 'default',
  company_id uuid,
  branch_id  uuid        not null,
  period     text        not null,               -- 'YYYY-MM' (server-validated)
  balance_bf numeric     not null default 0,      -- carried in from the prior month (admin-set)
  currency   text,                                -- statement currency (falls back to account default)
  updated_by uuid,                                -- users.id of the admin who set it
  updated_at timestamptz not null default now(),
  unique (account_id, branch_id, period)
);

create table if not exists cash_in (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  company_id  uuid,
  branch_id   uuid        not null,
  period      text        not null,               -- 'YYYY-MM'
  date        text,                                -- display date for Section A (TEXT like expense_date)
  description text,
  amount      numeric     not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists cash_in_branch_period_idx on cash_in (account_id, branch_id, period);

-- claim_override: the manual pin that beats the computed claim/petty-cash result for one expense.
-- null = computed (the default for every existing row).
alter table expenses add column if not exists claim_override text
  check (claim_override in ('claim', 'petty_cash') or claim_override is null);

alter table petty_cash_floats enable row level security;
alter table cash_in           enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).

-- issue #152: Telegram's file_id is per-bot/per-send and NOT stable across resends of the
-- same photo — file_unique_id IS stable, so it's the correct key for "did the clerk
-- literally send this exact photo before?" (distinct from receipt_file_id, which stays a
-- file_id, used to re-fetch/re-display the image). Null for every existing row and for the
-- dashboard upload path (no Telegram file at all) — exact-resend detection there uses a
-- separate content-hash key, #153's lane.
alter table expenses add column if not exists receipt_file_unique_id text;
create index if not exists expenses_account_fileuniq_idx on expenses (account_id, receipt_file_unique_id)
  where receipt_file_unique_id is not null;

-- ADR-025 amendment (Owner-approved, 2026-07-11 QA round): a branch-clerk's password is
-- ALSO stored encrypted-at-rest (lib/credCrypto.js, AES-256-GCM, key never in the DB) so
-- an admin can view it again later, not just at creation time. password_hash (scrypt,
-- one-way) remains the ONLY thing login checks -- this column is purely for re-display.
-- Null for every row created before this migration (or if CRED_ENC_KEY isn't configured);
-- those branches show "no password on file" in the dashboard and offer Reset instead.
alter table users add column if not exists password_enc text;

-- Personal-mode signup (2026-07-25): a personal (single-user) account gets its own role,
-- 'owner', instead of reusing 'admin'. Reusing 'admin' would silently light up every
-- session.role === 'admin' UI check across the frontend (team.js, grid.js, activity.js,
-- overview.js, payments.js) -- branch pickers, Team management, petty-cash statement
-- exports -- none of which make sense for a single-user personal account. A distinct role
-- means every EXISTING role==='admin' check naturally and automatically excludes 'owner'
-- with zero auditing required. Verified constraint name against the live schema before
-- writing this (public.users_role_check, a column-level CHECK Postgres auto-named).
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin', 'clerk', 'staff', 'owner'));

-- ============================================================================
-- Migration: password_resets (2026-07-27) — "Forgot password" for personal
-- (personalAuth) owner accounts. Mirrors bot_bindings' one-time-token shape
-- (token + expiry + a "consumed" timestamp), except the token itself is
-- stored HASHED (sha-256, same primitive as `sessions.token_hash` in
-- lib/auth.js) rather than raw — a password-reset token is a bearer
-- credential that can change a password, so it gets the stricter treatment.
-- ============================================================================
create table if not exists password_resets (
  id           uuid        primary key default gen_random_uuid(),
  account_id   text        not null default 'default',
  user_id      uuid        not null references users(id) on delete cascade,
  token_hash   text        not null,          -- sha-256 hex of the raw token; raw token is never stored
  expires_at   timestamptz not null,
  used_at      timestamptz,                    -- non-null once consumed (single-use)
  created_at   timestamptz not null default now()
);
create unique index if not exists password_resets_token_hash_idx on password_resets (token_hash);
create index if not exists password_resets_user_idx on password_resets (account_id, user_id);

alter table password_resets enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).

-- ============================================================================
-- Migration: users.plan (2026-07-28) — Free/Pro gate for personal (personalAuth)
-- owner accounts. Deliberately MINIMAL: a plain column, not the full
-- `subscriptions` table (curlec_customer_id/status/current_period_end/etc.) the
-- plan file describes — that full table is worth building once real Curlec
-- billing is actually wired up; until then every account is 'free' by default
-- (no code path ever sets 'pro' yet — there is no payment integration), and
-- this column is the one thing needed to gate a feature (Export PDF) today.
-- ============================================================================
alter table users add column if not exists plan text not null default 'free'
  check (plan in ('free', 'pro'));

-- ============================================================================
-- Migration: Guest Mode (2026-07-28) — "Continue as Guest" trial accounts.
-- Two pieces:
--   1. A new 'guest' role, alongside 'owner' — same reasoning as the owner
--      migration above (a distinct role means every existing role-based UI/
--      route check naturally excludes guests without auditing each site).
--   2. expenses.owner_user_id: this codebase has NO per-user data isolation
--      today (every query is scoped only by account_id, see lib/auth.js's
--      scopeForUser) — two real owner accounts already see each other's
--      expenses. That's a known, separately-tracked gap (see the plan file's
--      "MAJOR PIVOT" section). Guest Mode can't ship on top of that gap as-is
--      (a guest's throwaway receipts would leak into the real account's
--      ledger, and vice versa), so this column is a SMALL, SCOPED fix just
--      for guest rows: null on every existing/real row and every future
--      non-real-guest insert (zero behaviour change for real accounts —
--      "owner_user_id is null" keeps meaning exactly "a real account's own
--      receipt"), set only when a guest submits a receipt. `on delete cascade`
--      matches the existing sessions.user_id/bot_bindings.user_id pattern
--      above, so deleting a guest's `users` row (guest cleanup, lib/guest.js)
--      cascades through sessions + bot_bindings + expenses in one statement —
--      no manual multi-table delete ordering needed.
-- ============================================================================
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin', 'clerk', 'staff', 'owner', 'guest'));

alter table expenses add column if not exists owner_user_id uuid references users(id) on delete cascade;
create index if not exists expenses_owner_user_idx on expenses (owner_user_id) where owner_user_id is not null;

-- ============================================================================
-- Migration: subscriptions (2026-07-30) — HitPay Free/Pro billing for personal
-- (personalAuth) owner accounts. `users.plan` (2026-07-28 migration above) already
-- gates Export PDF; this table is the actual billing record behind that flag —
-- one row per user, created on first checkout, updated by the HitPay webhook.
-- period_end drives the 20-receipts/month free-tier reset (a receipt sent this
-- calendar month counts against the cap; no separate counter column — counted
-- live off `expenses` the same way the guest cap counts off `owner_user_id`).
-- ============================================================================
create table if not exists subscriptions (
  id                      uuid        primary key default gen_random_uuid(),
  account_id              text        not null default 'default',
  user_id                 uuid        not null references users(id) on delete cascade,
  plan                    text        not null default 'free' check (plan in ('free', 'pro')),
  status                  text        not null default 'inactive'
    check (status in ('inactive', 'active', 'past_due', 'cancelled')),
  billing_cycle           text        check (billing_cycle in ('monthly', 'yearly')),
  current_period_end      timestamptz,
  hitpay_customer_id      text,
  hitpay_subscription_id  text,
  hitpay_plan_id          text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
-- One subscription record per user (a fresh checkout on an existing free row updates it
-- in place rather than creating a second row — upsert target for the webhook handler).
create unique index if not exists subscriptions_user_idx on subscriptions (user_id);
create index if not exists subscriptions_hitpay_sub_idx on subscriptions (hitpay_subscription_id)
  where hitpay_subscription_id is not null;

create trigger subscriptions_touch_updated_at before update on subscriptions
  for each row execute function touch_updated_at();

alter table subscriptions enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).

-- ============================================================================
-- Migration: permanent bot binding + 30-day inactivity re-verify (2026-08-08)
-- A personal (personalAuth) owner's connect link used to expire after 7 days
-- (BIND_TOKEN_TTL_MS) with no self-service way to get a fresh one — a real user
-- got permanently stuck this way (chat_id stayed null forever). Two changes:
--   1. token_expires_at is now NULLABLE — new signups (lib/personalAuth.js)
--      leave it null (link never expires); lib/bot.js's bindWithToken no
--      longer enforces an expiry at all. Existing rows keep whatever expiry
--      they already had (harmless — bindWithToken no longer checks it).
--   2. last_active_at tracks the last time this chat sent the bot a message.
--      lib/bot.js's resolveBinding clears chat_id (forcing a re-verify, not a
--      dead end — the in-bot "I already have one" flow rebinds via a 6-digit
--      email code) once this is >30 days old, so a lost/stolen/sold phone
--      can't keep using the bot forever, without making normal daily use ever
--      expire. Backfilled from bound_at (fallback created_at) so existing
--      users aren't treated as already-inactive the moment this ships.
-- ============================================================================
alter table bot_bindings alter column token_expires_at drop not null;
alter table bot_bindings add column if not exists last_active_at timestamptz;

-- ============================================================================
-- Migration: guest_ip_log (2026-08-22, QA report #2) — "Guest Mode only access
-- once ... once user use guest mode track that device IP ... same user want try
-- guest mode again means pop message, tell sign up." Enforces one guest trial
-- per device/network, and closes a real API-cost abuse vector (a blocked user
-- could otherwise just start a fresh guest trial over and over).
--
-- Deliberately its OWN table, never touched by guest cleanup (routes/guest.js's
-- sweepStaleGuests / /api/guest/end both delete `users` rows, cascading through
-- sessions/bot_bindings/expenses — this table must NOT be part of that cascade,
-- or the block would silently reset every time a guest's 24h-old data gets
-- swept, defeating the entire point). Insert-only from the app's side; no
-- update/delete path exists anywhere in the codebase for this table.
--
-- account_id kept for consistency with every other table's SEC-8 shape even
-- though Guest Mode itself is single-tenant today (every guest lands under one
-- shared account_id, see routes/guest.js) — costs nothing, keeps this table
-- shaped the same as everything else if that ever changes.
-- ============================================================================
create table if not exists guest_ip_log (
  id                uuid        primary key default gen_random_uuid(),
  account_id        text        not null default 'default',
  ip_address        text        not null,
  first_started_at  timestamptz not null default now(),
  start_count       integer     not null default 1
);
create unique index if not exists guest_ip_log_ip_idx on guest_ip_log (account_id, ip_address);

alter table guest_ip_log enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).
update bot_bindings set last_active_at = coalesce(bound_at, created_at) where last_active_at is null;

-- ============================================================================
-- Migration: verified-email challenge service (P-01, 2026-08-24)
-- Program: docs/FULL_APP_EXECUTION_PLAN.md Gate 1 (trust foundation), issue #34.
--
-- Until now the ONLY proof-of-email-ownership in the product lived in lib/bot.js's
-- in-bot signup flow, where the 6-digit code sat in a per-process in-memory Map, in
-- PLAINTEXT, and never touched the database. Web signup (POST /api/signup) had no
-- email verification at all — it minted a session immediately. This migration adds
-- the durable, hashed, single-use challenge record that both clients (web/W-01 and
-- Android/M-02) verify against.
--
-- Deliberately ADDITIVE and backward-compatible:
--   * users.email_verified_at is NULLABLE with no backfill. Every existing row stays
--     null = "not yet verified". Nothing reads it as a gate unless an operator turns
--     on CAP_REQUIRE_EMAIL_VERIFICATION (lib/account.js), which defaults to FALSE —
--     so every already-deployed instance (Premala included) is byte-for-byte
--     unchanged until that flag is flipped in a separate, reviewed decision.
--   * email_challenges is a new table; dropping it restores the previous behaviour
--     exactly (rollback = `drop table email_challenges;` + drop the column).
--
-- Shape notes (why it differs from password_resets above):
--   * BOTH a code_hash and a token_hash live on ONE row — the 6-digit code and the
--     magic link are two delivery forms of the SAME single-use challenge, so
--     consuming either one consumes the other. Neither the code nor the token is
--     ever stored raw (same sha-256 discipline as sessions.token_hash).
--   * `email` snapshots the address the challenge was actually sent to, so a
--     challenge issued before an email change cannot verify the new address.
--   * `attempts`/`max_attempts` give each challenge its own guess budget, on top of
--     the per-IP rate limiter — a limiter alone resets every window and would let a
--     patient attacker keep guessing one long-lived code forever.
--   * `consumed_at` is claimed by a CONDITIONAL update (`consumed_at=is.null` in the
--     WHERE), which is a single atomic Postgres UPDATE. lib/emailChallenge.js treats
--     a zero-row result as "already consumed" — this is the replay defense, and it is
--     deliberately NOT the read-then-write pattern password_resets uses (recorded as
--     a medium finding in docs/FULL_APP_GAP_AUDIT_2026-08-24.md).
-- ============================================================================
alter table users add column if not exists email_verified_at timestamptz;

create table if not exists email_challenges (
  id            uuid        primary key default gen_random_uuid(),
  account_id    text        not null default 'default',
  user_id       uuid        not null references users(id) on delete cascade,
  purpose       text        not null default 'verify_email'
    check (purpose in ('verify_email')),  -- extensible: step-up/email-change land here in P-02
  email         text        not null,     -- address this challenge was sent to (snapshot)
  code_hash     text        not null,     -- sha-256 hex of the 6-digit code; code never stored
  token_hash    text        not null,     -- sha-256 hex of the magic-link token; token never stored
  expires_at    timestamptz not null,
  consumed_at   timestamptz,              -- non-null once used (single-use, claimed atomically)
  attempts      int         not null default 0,
  max_attempts  int         not null default 5,
  created_at    timestamptz not null default now()
);
-- Lookup paths: by token (magic link) and by user+purpose (newest challenge, for code
-- entry and for the resend cooldown check).
create unique index if not exists email_challenges_token_hash_idx on email_challenges (token_hash);
create index if not exists email_challenges_user_idx on email_challenges (account_id, user_id, purpose, created_at desc);
-- Retention (P-07 will automate the sweep): consumed/expired challenges are short-lived
-- credentials with no analytical value — they should not outlive their expiry by much.
create index if not exists email_challenges_expiry_idx on email_challenges (expires_at);

alter table email_challenges enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8, same as every table).
-- ============================================================================
-- Migration: device sessions and auth events (P-02a, 2026-08-24)
-- Program: docs/FULL_APP_EXECUTION_PLAN.md Gate 1 (trust foundation), issue #35.
--
-- P-02 asks for cookie sessions, CSRF, device management, step-up auth and
-- suspicious-login events. This migration is the FIRST slice only: the durable
-- record needed to answer "which devices are signed in as me, and when did
-- someone last sign in?" It deliberately does NOT change how a session is
-- resolved -- the bearer contract is untouched, so every existing client keeps
-- working byte-for-byte. The cookie/CSRF transport switch is P-02b and needs
-- W-01 and M-02 to agree the session contract first.
--
-- Why `id` is added rather than reusing the primary key: sessions is keyed by
-- token_hash, and a device list has to be addressable from the browser
-- ("revoke THAT device"). Exposing token_hash as the handle would put a value
-- derived from a live credential into URLs, logs and history -- so a separate,
-- meaningless surrogate id is generated for addressing. Changing the primary
-- key itself would be a breaking rewrite of lib/auth.js's whole lookup path,
-- so the PK is left exactly as it is.
--
-- Privacy (PDPA, C-02): the raw client IP is NEVER stored. `ip_hash` is a
-- salted sha-256 -- enough to answer "is this the same network as last time?"
-- for new-device detection, without retaining a location-bearing identifier.
-- user_agent IS stored, truncated, because a device list that cannot say
-- "Chrome on Windows" is useless to the person reading it.
-- ============================================================================
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists last_seen_at timestamptz;
alter table sessions add column if not exists user_agent text;
alter table sessions add column if not exists ip_hash text;
create unique index if not exists sessions_id_idx on sessions (id);

-- Stamped whenever a password changes (reset today; a future change-password
-- endpoint too). Revocation itself is still a hard DELETE of the user's session
-- rows -- this column is the audit answer to "when did this account's
-- credentials last change?", which a device list and an incident review both need.
alter table users add column if not exists password_changed_at timestamptz;

-- auth_events: the security timeline for one account. Powers new-device
-- detection and the "was this you?" surface W-06 will render.
--
-- Deliberately NOT a general audit log: it records only authentication outcomes,
-- never what the user then did, and never a token, password, code or receipt
-- value. Retention is P-07's job (these should not live forever).
create table if not exists auth_events (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  user_id     uuid        references users(id) on delete cascade,  -- null for a failure against an unknown account
  event       text        not null
    check (event in ('login_ok', 'login_fail', 'logout', 'session_revoked', 'password_changed', 'new_device')),
  ip_hash     text,                                 -- salted hash, never the raw IP
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists auth_events_user_idx on auth_events (account_id, user_id, created_at desc);
create index if not exists auth_events_created_idx on auth_events (created_at);

alter table auth_events enable row level security;
-- service_role bypasses RLS; no anon policy -> anon denied (SEC-8, same as every table).
