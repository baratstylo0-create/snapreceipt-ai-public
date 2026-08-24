# WORKLOG pending fragments

**Why this exists:** `docs/WORKLOG.md` grew one giant file, and every PR prepends its own entry
at the same line — the top, right after the header. Two PRs branching around the same time
almost always conflict there, even when their actual code never overlaps. Every platform PR
today hit this at least once; some hit it three times as `main` moved underneath them.

**The fix:** don't write directly into `docs/WORKLOG.md` anymore. Write your entry as its own
file in this directory instead. Two different filenames can never conflict, so two PRs landing
the same day never fight over one insertion point.

## Convention

One file per PR/task: `<issue-or-PR-number>-<short-slug>.md`, e.g. `048-p02a-device-sessions.md`.

Content is exactly what would have gone into `docs/WORKLOG.md` — same `## ` heading format
(date · author · branch · title), same body. Copy the shape of any existing entry in
`docs/WORKLOG.md` if unsure.

## Consolidation

Fragments here are **not** the permanent record — they're staged. Whoever merges a PR runs:

```bash
node scripts/consolidate-changelog.js
```

on `main` after the merge. It reads every fragment here (and every migration fragment in
`db/migrations/pending/`), sorts by the leading number, prepends them into
`docs/WORKLOG.md` / appends them into `schema.sql` in that order, deletes the consolidated
fragments, and reports what it did. Commit the result. This step touches only files nobody
else has an open PR against at that moment (the fragments are gone, the canonical files are
current), so it never conflicts with anything.

Until consolidation runs, `docs/WORKLOG.md` itself is untouched by new PRs — only this
directory grows.
