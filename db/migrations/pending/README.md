# Schema migration pending fragments

**Why this exists:** every new migration used to get appended straight onto the tail of
`schema.sql`. Two branches adding their own migration around the same time both diverge from
the same "last block" and conflict when either one lands — not because the SQL actually
overlaps, but because they're editing adjacent lines in the same file. This is the same
problem `docs/worklog/pending/` solves, applied to schema.

**The fix:** write a new migration as its own file here instead of editing `schema.sql`
directly. `schema.sql` stays the single, copy-pasteable bootstrap file for a fresh Supabase
project (per `README.md`/`CLAUDE.md` — "SQL Editor → paste schema.sql → Run") — nothing about
that workflow changes. New work just doesn't touch it directly until consolidation.

## Convention

One file per PR/task: `<issue-or-PR-number>-<short-slug>.sql`, e.g. `037-p04a-rate-limiting.sql`.

Same content and commenting style as any existing dated migration block already in
`schema.sql` — a `-- ============...` header, a `-- Migration: <name> (<date>)` line, a short
prose comment explaining *why*, then the idempotent DDL (`create table if not exists`,
`alter table ... add column if not exists`, etc.). Every migration in this codebase is written
additive and idempotent — keep that discipline in fragments too.

## Consolidation

Not applied automatically and not the live schema on its own. Whoever merges a PR runs:

```bash
node scripts/consolidate-changelog.js
```

on `main` after the merge — it appends every fragment here (sorted by the leading number) onto
`schema.sql`, deletes the consolidated fragments, and reports what it did. Commit the result,
then apply the new tail of `schema.sql` to the real database as usual (Supabase SQL editor or
`apply_migration`) — consolidation only updates the *file*, it never touches a live database.
