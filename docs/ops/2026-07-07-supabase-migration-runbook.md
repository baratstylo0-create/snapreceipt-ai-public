# Supabase Migration Runbook — M2 Phases 4–9 (+ Barat #123)

> **Target:** a client instance's Supabase project (managed-silo — one project per client; Premala is first).
> **How:** Supabase Dashboard → SQL Editor (runs as service-role).
> **As of:** `main` @ `720c8ce` (Phases 1–10 merged). Source of truth for the SQL: `schema.sql`.
> **Author:** Jeevan (CTO session), 2026-07-07. Ops layer per `docs/SYSTEM_COMPLETENESS.md`.
>
> **✅ APPLIED to the Premala instance (`xurnpvesgcybrnilxszf`) on 2026-07-08** — the instance had only
> the P4 receipt core, so the **whole `schema.sql` was run wholesale** (not just Blocks B–E: the M2-P1
> base tables were also missing). Post-verify: zero missing objects, RLS=true on all 8 new tables,
> admin (`premala-admin` + Head Office) provisioned via `setup-admin`. **Block F
> (`field_templates.categories`) applied + verified 2026-07-08** (the wholesale apply predated #123's
> merge, so it needed the one extra ALTER; column now present + queryable on the live DB). **All
> migration blocks are now applied on Premala.** See WORKLOG 2026-07-08.

This runbook applies the M2 schema changes that are **code-merged but not yet applied** to the live
database. Until they're applied, the business/petty-cash/statement features 404 or error at runtime
even with the `CAP_*` flags on.

---

## ⚠️ Target project — READ THIS FIRST (verify before a single statement)

Apply ONLY to the receipt-analyser's own database. Confirm the project ref in the SQL Editor URL
matches the app's `.env` `SB_URL` before running anything.

| | Project ref | Apply here? |
|---|---|---|
| **Receipt-analyser (the app — Premala instance)** | `xurnpvesgcybrnilxszf` | ✅ **YES** — the ref in the app's `.env` `SB_URL` |
| **FrictionAI (the parent project this repo was extracted from)** | `fziaxuhonvrhqjulhcyu` | ❌ **NO** — different app, has its own `companies`/`expenses` tables (name collisions) |

**Why this warning exists:** the Supabase MCP token wired into the Claude sessions reaches **only**
`fziaxuhonvrhqjulhcyu` (FrictionAI) — `list_projects` returns just that one, and `get_project` on
`xurnpvesgcybrnilxszf` returns *"You do not have permission"*. So this schema **cannot be applied
programmatically through that MCP**; a "just apply it" would have silently no-op'd against FrictionAI's
`companies` table and then errored on the missing `branches`. Two safe paths:

1. **Recommended — Supabase Dashboard → SQL Editor on `xurnpvesgcybrnilxszf`** and run the blocks below.
2. **Programmatic —** reconnect the Supabase MCP with a token scoped to `xurnpvesgcybrnilxszf`, then
   an agent can run pre-flight → apply → post-verify end-to-end.

The pre-flight in §1 is the second safety net: if it returns FrictionAI-shaped results (e.g. a
`companies` table but no `field_templates`/`account_settings`), you are on the wrong project — stop.

---

## 0. Safety properties (why this is low-risk)

- **Additive only** — no `drop`, no type changes, no data rewrites. Safe to run against live data.
- **Idempotent** — every statement is `create table if not exists` / `add column if not exists` /
  `create or replace` / `drop … if exists`. Re-running an already-applied block is a **no-op**; you
  will not double-create or error. You can therefore run the whole script top-to-bottom without
  knowing exactly what's already applied.
- **Dormant until switched on** — every new surface is gated by a `CAP_*` env flag (`CAP_MULTI_USER`,
  `CAP_COMPANY_DIMENSION`, `CAP_PETTY_CASH`, …). Applying the schema changes **nothing** users see
  until the flag is flipped, so it's safe to apply ahead of go-live.
- **One real ordering rule:** Block D (`M2-P8`) alters `branches/users/sessions/bot_bindings` to add
  `company_id`, so those tables must exist first (`M2-P1`, the business-identity foundation). Every
  other block is order-independent.

---

## 1. Pre-flight — see what's already applied (read-only; run first)

```sql
-- Identity check FIRST: these tables are receipt-analyser core and do NOT exist on FrictionAI.
-- Expect ALL THREE rows back. If this returns 0 rows, you are on the WRONG project — STOP.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('field_templates','account_settings','voucher_counters')
order by table_name;

-- Which M2 tables exist?
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('branches','users','sessions','bot_bindings',
                     'submissions','companies','petty_cash_floats','cash_in')
order by table_name;

-- Which M2 columns exist?
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name='expenses' and column_name in
        ('payment_status','paid_at','paid_note','updated_at','company_id','claim_override'))
    or (table_name in ('branches','users','sessions','bot_bindings') and column_name='company_id')
    or (table_name='field_templates' and column_name='categories'))
order by table_name, column_name;
```

**If `branches` is absent** from the first result, the base business-identity migration (`M2-P1`) has
not been applied — apply the `-- Migration M2-P1` block from `schema.sql` (search for it; ~lines
206–299) **before Block D**. It is almost certainly already applied: the login and Telegram-bot
flows in Phases 6–7 were live-verified against this instance.

---

## 2. Apply in this order

### Block B — M2-P4: payments + optimistic-concurrency trigger (ADR-021 Phase 4)

```sql
alter table expenses
  add column if not exists payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid')),
  add column if not exists paid_at   timestamptz,
  add column if not exists paid_note text,
  add column if not exists updated_at timestamptz not null default now();

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
```

### Block C — M2-P7: "Send to Admin" branch submissions (ADR-022 Phase 7)

```sql
create table if not exists submissions (
  id           uuid        primary key default gen_random_uuid(),
  account_id   text        not null default 'default',
  company_id   uuid,
  branch_id    uuid        not null,
  period       text        not null,
  submitted_by uuid,
  status       text        not null default 'submitted'
    check (status in ('submitted', 'withdrawn')),
  note         text,
  submitted_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create unique index if not exists submissions_branch_period_idx
  on submissions (account_id, branch_id, period);
create index if not exists submissions_account_period_idx on submissions (account_id, period);
alter table submissions enable row level security;
```

### Block D — M2-P8: company dimension (ADR-023) — *needs the M2-P1 tables to exist*

```sql
create table if not exists companies (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  name        text        not null,
  currency    text,
  template_id uuid,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists companies_account_active_idx on companies (account_id) where active;

alter table branches     add column if not exists company_id uuid;
alter table users        add column if not exists company_id uuid;
alter table sessions     add column if not exists company_id uuid;
alter table bot_bindings add column if not exists company_id uuid;
alter table expenses     add column if not exists company_id uuid;
create index if not exists expenses_account_company_idx on expenses (account_id, company_id)
  where company_id is not null;

alter table companies enable row level security;
```

### Block E — M2-P9: petty-cash floats + claim engine (ADR-023)

```sql
create table if not exists petty_cash_floats (
  id         uuid        primary key default gen_random_uuid(),
  account_id text        not null default 'default',
  company_id uuid,
  branch_id  uuid        not null,
  period     text        not null,
  balance_bf numeric     not null default 0,
  currency   text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (account_id, branch_id, period)
);

create table if not exists cash_in (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  company_id  uuid,
  branch_id   uuid        not null,
  period      text        not null,
  date        text,
  description text,
  amount      numeric     not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists cash_in_branch_period_idx on cash_in (account_id, branch_id, period);

alter table expenses add column if not exists claim_override text
  check (claim_override in ('claim', 'petty_cash') or claim_override is null);

alter table petty_cash_floats enable row level security;
alter table cash_in           enable row level security;
```

### Block F — Barat #123: per-company category set — ✅ **APPLIED + verified on Premala 2026-07-08** (#123 merged)

```sql
alter table field_templates
  add column if not exists categories jsonb;
```

Integration note: once this column is populated, `lib/templates.getFieldSpec()` returns `categories`,
and Phase 10's `lib/statement.js` (`fieldSpec.categories || CATEGORIES`) automatically drives
per-company category blocks in the generated statements. No application change is required.

---

## 3. Post-apply verification

Re-run the two **pre-flight** queries — you should now see all 8 tables and every listed column.
Then confirm RLS is enabled (anon denied — SEC-8):

```sql
select relname, relrowsecurity as rls_on
from pg_class
where relname in ('submissions','companies','petty_cash_floats','cash_in');
-- expect rls_on = true for all four
```

---

## 4. Git-side conflict resolution for PR #123 (separate from applying the SQL)

PR #123 (`feature/barat-m2-fieldspec-categories`) branched from `231d4c0` — **before** Phases 7–10.
When it merges `main`, the conflicts are **append-only, no logic**:

- **`schema.sql`** → keep **both** sides: all of `main`'s `M2-P4/P7/P8/P9` blocks **and** #123's
  `field_templates.categories` block. Order doesn't matter (`field_templates` predates all of them).
- **`docs/WORKLOG.md`** → keep **both** sets of entries, newest-first.
- No other file overlaps — `lib/templates.js`, `lib/bot.js`, `lib/ocr.js`, `routes/templates.js` are
  #123-only; the Phase 8–10 code files are `main`-only.

After resolving, re-run the full suite (`.env` moved aside per convention) so CI validates the
combined tree, not either half in isolation.

---

## 5. Break-glass rollback (not recommended)

These changes are additive and harmless while the `CAP_*` flags are off, so the preferred "undo" is
simply to leave the schema in place and keep the flags off. If a full reversal is genuinely required:

```sql
-- DANGER: destroys petty-cash / submission / company data. Only on an instance with none of it live.
drop table if exists cash_in, petty_cash_floats, submissions, companies cascade;
alter table expenses drop column if exists claim_override;
-- (company_id / payment_status columns are best left in place — dropping them buys nothing.)
```

---

## Related

- Canonical SQL: `schema.sql` (each block carries a `-- Migration M2-Px` header + rationale).
- Feature context: `docs/handoff/2026-07-07-phases-8-10/` (Phases 8–10), `docs/DECISIONS.md`
  (ADR-021 M2, ADR-022 profiles, ADR-023 company + petty cash, ADR-024 pdfkit, ADR-025 security).
- Other pre-live ops gates (not covered here): Groq ZDR toggle, hosting/HTTPS, `npm run setup-admin`,
  secret custody (ADR-015).
