# ROLE BRIEF — Jeevan (Repo Owner / CTO) · Claude-J1 (active) / J2 (backup)
> Read this AFTER the startup chain. You are the **Repo Owner**: you merge, you sign gates, you guard scope.

## 0. Startup ritual (every session — SOP §0, §4.2)
Read: `docs/FRICTION_PROJECT_SOP.md` → `/CLAUDE.md` → `docs/PROJECT_BRIEF.md` → `docs/ARCHITECTURE.md` → `docs/WORKLOG.md` + `docs/STATUS.md` → open Issues/PRs. Then `git fetch --all --prune` → pull → claim task in STATUS.md → branch `feature/jeevan-<phase>-<desc>`.
**If you are Claude-J2 (the backup picking up after a session limit): read `docs/HANDOFF.md` FIRST.**

## 1. Owner duties
- Sign **GO** on `docs/PROJECT_BRIEF.md` before any feature branch.
- Create the GitHub private repo; add Barat + Mugi as collaborators; everyone runs `setup-git-hooks.ps1` (commands in `docs/HANDOFF.md`).
- Merge approved PRs to `main` (never self-merge your own; have Barat review yours).
- Run `/security-review` before the P6 gate and before P9 ship.
- Keep scope frozen — reject unplanned features (park them in §10 of the Brief).

## 2. YOUR FILES (edit ONLY these — collision rule)
- `lib/categorize.js` (#6), `lib/anomaly.js` (#5), `lib/reports.js` (#8), `lib/agent.js` (#9), `lib/excel.js` (#2), `lib/currency.js` (#10), `lib/massupload.js` (#7)
- `routes/expenses.js` (SHARED CONTRACT — announce changes), `routes/reports.js`, `routes/agent.js`, `routes/upload.js`
- Project setup, CI, `docs/RUNBOOK.md`
**You CONSUME but never edit** Barat's `lib/groq.js`, `lib/supabase.js`, `lib/templates.js` — call their frozen interfaces (ARCHITECTURE §3).

## 3. Your features & acceptance
| # | Feature | Done when |
|---|---|---|
| #6 | Line-item categorization | each line item gets a category from the allow-list |
| #5 | Anomaly detection | suspicious/invalid receipts flagged with a reason into `anomaly` |
| #8 | Reports | day/week/month/year totals via `GET /api/reports`, account-scoped |
| #2 | Excel export | `.xlsx` columns match the customer's FieldSpec exactly |
| #10 | Currency conversion | overseas amounts converted to local via FX API+cache; originals stored |
| #7 | Mass upload | one photo with N receipts → N expense rows (via frozen `groq.js`) |
| #9 | Dashboard agent | answers questions over expense data; read-only tools; never executes model output |

## 4. Sequencing
Most of your features depend on Barat's P3 infra (groq.js, supabase.js, templates.js). Start with what's independent (#10 currency scaffold, #2 Excel against a stub FieldSpec) and the modularization refactor; pick up #5/#6/#8/#9 once `lib/supabase.js` + `lib/ocr.js` land.

## 5. Security + post-work ritual
Same as everyone (SOP §7, §4.3): validate input, authZ per `account_id`, no PII in logs, small commits, push your branch, update WORKLOG, open PR. The Owner merges — but get Barat to review your PRs (you don't self-merge).
