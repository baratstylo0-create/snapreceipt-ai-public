# Phase 9 — Petty-cash floats + claim engine

> ADR-023, spec §4–§6 of `docs/specs/2026-07-06-petty-cash-statement-format.md`. The heart of the
> Premala deliverable: floats, running-balance maths, claims. Branch: `feature/jeevan-m2-pettycash`
> off `main` (after Phase 8 merges).

## The maths (frozen — do not re-derive, spec §6)

- `cashInHand(branch, period) = balance_bf + Σ cash_in rows for that branch+period`
- `expenditure(branch, period) = Σ that branch's expenses in the period` (by `expense_date` prefix
  `YYYY-MM`; exclude soft-deleted; non-finite amounts contribute 0 and are reported as excluded)
- `balance = cashInHand − expenditure` — **positive = surplus (no claim), negative = overspent**
- **Claim** = the expenses past the float: walk the branch's period expenses in `expense_date`
  order (tie-break `created_at`), accumulate; once the running total exceeds `cashInHand`, that
  expense and everything after it is claim (the crossing expense is claim for its full amount —
  simplest defensible rule; note it in a comment). Per-expense `claim_override`
  (`'claim'`/`'petty_cash'`) beats the computed result for that row.
- **The canonical correctness test (the client's own sheet got this wrong):** float 3000,
  expenditure 2924.91 ⇒ balance **+75.09, zero claims**. Assert exactly this.
- Claim status is **computed on read, never stored** — it can't drift from the numbers.
  Reimbursement state rides the existing `payment_status` (Phase 4).

## Task 9.1 — Flag + schema

- `lib/account.js`: `pettyCash: bool(process.env.CAP_PETTY_CASH, false)` (+ flags test).
- `schema.sql`, new `-- Migration M2-P9` block (house style, idempotent, RLS + no anon policy on
  BOTH new tables — SEC-8):

```sql
create table if not exists petty_cash_floats (
  id         uuid        primary key default gen_random_uuid(),
  account_id text        not null default 'default',
  company_id uuid,
  branch_id  uuid        not null,
  period     text        not null,               -- 'YYYY-MM'
  balance_bf numeric     not null default 0,     -- carried in from the prior month
  currency   text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (account_id, branch_id, period)
);

create table if not exists cash_in (
  id         uuid        primary key default gen_random_uuid(),
  account_id text        not null default 'default',
  company_id uuid,
  branch_id  uuid        not null,
  period     text        not null,
  date       text,                                -- display date for Section A (TEXT like expense_date)
  description text,
  amount     numeric     not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists cash_in_branch_period_idx on cash_in (account_id, branch_id, period);

alter table expenses add column if not exists claim_override text
  check (claim_override in ('claim', 'petty_cash') or claim_override is null);
```

## Task 9.2 — `lib/pettyCash.js` (new; PURE maths first, TDD hard here)

Export two layers:
1. **Pure, no-I/O functions** (unit-test these exhaustively):
   `computeBalance({ balanceBf, cashIn: [{amount}...], expenses: [{amount}...] })` →
   `{ cashInHand, expenditure, balance }` (round to cents like `lib/excel.js`'s `round2`), and
   `computeClaims({ cashInHand, expenses: [{id, amount, expense_date, created_at, claim_override}...] })`
   → `{ claimIds: [...], claimTotal }` per the frozen rules above.
2. **Thin DB wrappers** that fetch (`sbSelect` on `petty_cash_floats` / `cash_in` / `expenses`) and
   call the pure layer.

Pure-layer tests (≥ 10): under-budget (the +75.09 case, zero claims); exact-zero balance (no
claim); over-budget (crossing expense + all after = claims, claimTotal correct); override forces a
mid-float expense into claim and an over-float one out; date-order determinism (shuffled input,
same result); garbage amounts (NaN → 0 + excluded count); empty month; missing float row (⇒
cashInHand = 0, everything claim).

## Task 9.3 — `routes/pettyCash.js` (new; mount in `server.js`, announce in WORKLOG)

Gate: 404 unless `multiUser` AND `pettyCash`. Limiter `PETTYCASH_RATE_MAX` default 60. Mirror the
submissions-route structure.

- `GET /api/petty-cash?branch=&period=` — the period summary
  `{ float, cashIn: [...], cashInHand, expenditure, balance, claims: { ids, total } }`.
  Admin: any branch (branch param required). Clerk: forced to own branch (ignore the param).
- `PUT /api/petty-cash/float { branchId, period, balanceBf, currency? }` — **admin-only** (clerk
  403; the Owner's rule: only the admin sets floats, incl. Head Office). Upsert on
  (branch, period) via select-then-insert/update like submissions. Validate: period `YYYY-MM`,
  `balanceBf` finite ≥ 0 (SEC-5).
- `POST /api/petty-cash/cash-in { branchId, period, date?, description?, amount }` — admin-only.
  Validate amount finite > 0, strings length-capped. `DELETE /api/petty-cash/cash-in/:id` —
  admin-only (hard delete is fine here: it's a ledger the admin owns; note it).
- `PATCH /api/expenses/:id { claim_override }` — do NOT widen the general PATCH allow-list.
  Instead add `claim_override` handling INSIDE `sanitizeExpensePatch`'s allow-list
  (`lib/expenseValidation.js`) with value validation (`'claim'|'petty_cash'|null`), and add a
  role guard in the route: clerk may set it only on own-branch rows (`canTouchExpense` already
  enforces this), admin anywhere.

Route tests (stubDb harness): flag off 404; clerk float write 403; admin float upsert
(insert-then-update, no duplicate); clerk summary forced to own branch (URL assert); bad
period/amount 400; summary numbers match the pure layer on a seeded fixture.

## Done when

- Suite green (expect ≈ +20 tests), flag-off byte-for-byte, no PII in logs.
- Commit: `feat(m2): Phase 9 — petty-cash floats + claim engine (balance maths, reimbursement)`;
  PR lists the M2-P9 migration, cites the +75.09 test explicitly (the Owner cares about it).
