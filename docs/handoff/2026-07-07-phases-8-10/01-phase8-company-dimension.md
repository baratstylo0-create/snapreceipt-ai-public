# Phase 8 — Company dimension (Group → Company → Branch → Staff)

> ADR-023. Premala operates multiple legal-entity companies under one account. Additive +
> flag-gated: `companyDimension` OFF ⇒ single-company behaviour, byte-for-byte today's product.
> Branch: `feature/jeevan-m2-company-dim` off `main`.

## Task 8.1 — Flag

`lib/account.js` `getCapabilities()`: add `companyDimension: bool(process.env.CAP_COMPANY_DIMENSION, false)`
next to the other ADR-022 flags (same comment style). Test in `tests/account.flags.test.js`
(extend the existing `withEnv` harness — add `CAP_COMPANY_DIMENSION` to its `KEYS`): default false,
env override true, and the Premala combo now includes it.

## Task 8.2 — Schema (append a new `-- Migration M2-P8` block at the END of `schema.sql`)

Follow the exact house style of the M2-P1/P4/P7 blocks (banner comment with date + plan reference,
idempotent DDL, RLS + no-anon-policy comment):

```sql
create table if not exists companies (
  id          uuid        primary key default gen_random_uuid(),
  account_id  text        not null default 'default',
  name        text        not null,
  currency    text,                              -- statement currency (falls back to account default)
  template_id uuid,                              -- the company's FieldSpec (category set), field_templates.id
  active      boolean     not null default true, -- soft-delete only
  created_at  timestamptz not null default now()
);
create index if not exists companies_account_active_idx on companies (account_id) where active;

alter table branches add column if not exists company_id uuid;
alter table users    add column if not exists company_id uuid;   -- denormalised for one-lookup scope
alter table expenses add column if not exists company_id uuid;   -- stamped from branch/session
create index if not exists expenses_account_company_idx on expenses (account_id, company_id)
  where company_id is not null;

alter table companies enable row level security;
-- service_role bypasses RLS; no anon policy → anon denied (SEC-8).
```

Nullable everywhere ⇒ existing rows/personal mode unaffected. Note the migration in the PR body.

## Task 8.3 — Scope contract gains `company_id` (`lib/auth.js`)

`scopeForUser` (frozen contract, ADR-021 — this widening was agreed with Barat on issue #107):

- `admin` → `{ account_id, role: 'admin' }` (unchanged — sees all companies + branches).
- `clerk` → `{ account_id, company_id?, branch_id, role: 'clerk' }` — include `company_id` when the
  session row carries one (sessions denormalise it the same way they carry `branch_id`; add
  `company_id` to the `sessions` insert in `mintSession` + the M2-P8 schema block:
  `alter table sessions add column if not exists company_id uuid;`).
- A clerk without `company_id` (pre-Phase-8 data) stays valid — the field is optional in the scope.

Tests (`tests/auth.test.js`, extend): clerk scope carries company_id when present; absent ⇒ omitted
(NOT null-keyed); admin unchanged. Do NOT break the existing scope-shape tests — they assert exact
`deepStrictEqual` shapes; update them deliberately and say so in the commit body.

**Coordination note for the PR body:** Barat's `lib/supabase.js` scope hook (#107 B1) applies
`company_id` when present — that half is his; do not touch `lib/supabase.js`.

## Task 8.4 — Company CRUD (`routes/companies.js`, new; mount in `server.js` — announce the shared-file touch in WORKLOG)

Mirror `routes/branches.js` exactly (its gate/limiter/role-guard pattern is the house pattern):

- Gate: 404 unless `multiUser` AND `companyDimension`.
- `GET /api/companies` — admin + clerk (clerk sees only their own company when scoped; filter like
  submissions does). `POST /api/companies { name, currency?, template_id? }` — **admin-only**,
  name required/length-capped (SEC-5). `DELETE /api/companies/:id` — admin-only soft-delete
  (`active=false`); refuse (409) if the company still has active branches.
- `POST /api/branches` gains optional `companyId` (admin assigns a branch to a company;
  `lib/branches.js createBranch` already accepts `companyId` — it has since Phase 2).
- Per-route rate limiter (`COMPANIES_RATE_MAX`, default 120). No PII in logs.

Tests (`tests/companies.route.test.js`, copy the stubDb harness from `tests/submissions.route.test.js`):
flag off 404; no session 401; clerk POST/DELETE 403; admin create → row insert with name; delete
with active branches → 409; clerk GET filtered to own company (assert the query URL carries
`company_id=eq.<theirs>` or the route filters in-memory — match how you implement it).

## Task 8.5 — Reports gain the company dim

`lib/reports.js` `buildReport`: `groupBy: 'company'` alongside the existing `branch`/`staff` dims
(same invariant test: **sum(groups) == report.total**). `routes/reports.js`: accept
`?groupBy=company` + admin `?company=` drill-down filter; a clerk is already hard-scoped by branch —
verify that stays. Tests: extend `tests/reports.groupby.test.js` + `tests/reports.route.scope.test.js`
following their existing shapes.

## Task 8.6 — Write-path stamping

Wherever `branch_id` is stamped today, stamp `company_id` beside it from the same source
(session scope for dashboard uploads in `routes/upload.js`; the submissions route already writes
`company_id: null` — leave for Barat's bot/binding path to fill from `bot_bindings`). Test: the
upload meta carries `company_id` when the session has one.

## Done when

- `npm test` fully green (expect ≈ +15 new tests), flag-off byte-for-byte (run the suite once with
  no CAP_ env at all and confirm identical pass count to main's baseline).
- Commit: `feat(m2): Phase 8 — company dimension (Group→Company→Branch→Staff)`; PR references
  epic #106 + ADR-023, lists the M2-P8 migration as an ops step, notes the scope-contract widening
  for Barat's review.
