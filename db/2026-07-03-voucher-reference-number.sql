-- ============================================================================
-- Migration: per-expense human-readable reference number (ADR-017)
-- Barat · 2026-07-03
-- Format: RC-<YYYY>-<NNNN>  e.g. RC-2026-0041 (Owner-approved prefix: "RC" for
-- "Receipt", not the spec's default "V"). Generated DB-side (BEFORE INSERT
-- trigger + atomic per-(account,year) counter) so every insert path — single
-- photo, Telegram album, PDF, dashboard mass-upload — gets a correct, race-free
-- number without each caller re-implementing it. Idempotent: safe to re-run.
-- ============================================================================

-- 1) New column on expenses (nullable; the trigger fills it on insert).
alter table expenses add column if not exists voucher_no text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'expenses_voucher_uq'
  ) then
    alter table expenses add constraint expenses_voucher_uq unique (account_id, voucher_no);
  end if;
end $$;

-- 2) Per-(account, year) counter. One row per account per year; the last issued seq.
create table if not exists voucher_counters (
  account_id text not null,
  year       int  not null,
  last_seq   int  not null default 0,
  primary key (account_id, year)
);

alter table voucher_counters enable row level security;
-- service_role bypasses RLS; no anon policy -> anon denied (same posture as every other table).

-- 3) Atomic "give me the next seq for this account+year" via upsert-increment.
--    ON CONFLICT ... DO UPDATE ... RETURNING is row-level atomic, so concurrent
--    inserts (e.g. N receipts from one Telegram album) serialize on this row and
--    each gets a distinct, contiguous sequence number. This is the piece that
--    makes DB-side generation safe where an app-side count(*)+1 would race.
create or replace function next_voucher_seq(p_account text, p_year int)
returns int language sql as $$
  insert into voucher_counters (account_id, year, last_seq)
  values (p_account, p_year, 1)
  on conflict (account_id, year)
  do update set last_seq = voucher_counters.last_seq + 1
  returning last_seq;
$$;

-- 4) Trigger: assign voucher_no on insert if not already set. Decision A (Owner):
--    number by the RECEIPT's own date (expense_date), falling back to the insert
--    date only when expense_date is null, so a Dec-2025 receipt entered in Jan
--    2026 still files under 2025. Assignment is INSERT-only and immutable
--    thereafter (a later UPDATE/PATCH never re-fires this trigger).
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

-- 5) Backfill existing rows (Decision B, Owner-approved: yes, number old rows too).
--    Ordered by created_at per account+year so the numbering reads chronologically.
--    Safe to re-run: only touches rows where voucher_no is still null.
do $$
declare r record; y int; s int;
begin
  for r in
    select id, account_id, expense_date, created_at
    from expenses
    where voucher_no is null
    order by account_id, coalesce(expense_date::date, created_at::date), created_at
  loop
    y := extract(year from coalesce(r.expense_date::date, r.created_at::date))::int;
    s := next_voucher_seq(r.account_id, y);
    update expenses set voucher_no = 'RC-' || y::text || '-' || lpad(s::text, 4, '0') where id = r.id;
  end loop;
end $$;
