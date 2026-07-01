# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

## Where things physically are
- **Active repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas` ← launch Claude Code HERE, not in `Gold_Bot`.
- ⚠️ `C:\Users\Asus\Downloads\Gold_Bot` is an **unrelated forex trading bot**. The Friction SOP folder was mistakenly dropped inside it. Ignore it for this project.
- Source it was copied from: `C:\Users\Asus\Downloads\receipt-saas` (leave as-is, untouched backup).
- Canonical SOP also at `C:\Users\Asus\Downloads\Friction_SOP_Foundation\FRICTION_PROJECT_SOP.md` (copied into `docs/`).

## What's DONE (this session)
- Clean git repo created on `main` (local only — no GitHub remote yet).
- Module dirs scaffolded: `lib/ routes/ docs/ docs/roles docs/templates docs/specs templates/ .githooks/`.
- Git safety: `.githooks/pre-push` (blocks direct push to main/develop) + `setup-git-hooks.ps1`.
- Governance docs written: `FRICTION_PROJECT_SOP.md`, `PROJECT_BRIEF.md` (filled kickoff), `ARCHITECTURE.md` (module map + frozen interfaces), `STATUS.md`, `WORKLOG.md`, `DECISIONS.md`, this `HANDOFF.md`, `roles/{JEEVAN,BARAT,MUGI}.md`, root `CLAUDE.md` updated, `MEMORY_LEDGER.md`.
- **Brief signed GO; repo published to GitHub; modularization MERGED to `main`.**
  - `main` is now the modularized codebase: `server.js` 31 lines (wiring only) + `lib/{money,categorize,http,config,groq,supabase,telegram,ocr,bot}.js` + `routes/{webhook,expenses,receipt,misc}.js` + `tests/`. **`npm test` = 8/8 green.**
  - Merged: PR #1 (kickoff docs), PR #2 (modularization). Barat collaborator = `baratstylo0-create` (push).
  - ⚠️ Run `npm install` after cloning (node_modules is git-ignored).
  - ⚠️ Direct push to `main` is blocked by the pre-push hook — all changes via branch + PR.

## Decisions locked (see DECISIONS.md)
- Repo Owner = Jeevan (gh: Jeevan1811); Deputy = Barat.
- Track = Vertical AI. M1 = personal version, 12 features.
- Modularize server.js FIRST (ADR-001). Groq data = masking + retention (ADR-002). CSV field template #12 foundational (ADR-003). Coupling-based split (ADR-004): Barat=infra+#4,#1,#11,#12; Jeevan=#5,#6,#8,#9,#2,#10,#7; Mugi=#3+business. Currency = FX API not LLM (ADR-005).

## EXACT NEXT ACTIONS (in order)
> **UPDATE 2026-07-01 (Claude-J2):** P3 done; **PR #9 templates MERGED**. Now in **P4 features**.
> Open PRs: **#8 reports** (QA re-review), **#6 categorization** (PR #10), **#5 anomaly**. List below supersedes the P3 plan.

1. **Review + merge the open feature PRs** (Owner): #8 reports (after QA), #6 categorization, #5 anomaly. Each Tier-2 + QA where it touches an AI surface.
2. **Barat (after #6/#5 merge):** apply `db/2026-07-01-category_corrections.sql`; wire BOTH `categorizeLineItems(receipt, fieldSpec)` and `detectAnomalies(expense, {history, businessType})` into `lib/ocr.js`/`lib/bot.js` at ingestion (store category + `anomaly`, set `status`). Plus the currency (#10) wire-up.
3. **Jeevan remaining features:** #2 Excel (reads FieldSpec, unblocked by #9), #9 agent, #7 mass upload. Also: after #8 merges, add `status=neq.rejected` to report/Excel totals (from #5). Each = one branch = one PR.
4. **Mugi:** deferred (#3 dashboard + business structure) — needs GitHub username; owes dashboard category-pill expansion (#6) + review-queue UI (#5).

## Pending inputs / open items
- Barat: run schema in his Supabase; invite Jeevan to that project for visibility; confirm vision routing (ADR-007).
- CTO flag (open question): production Supabase should move off Barat's personal account to a shared org/Owner account before launch.
- Mugi GitHub username (when he starts).

## STILL NEEDED FROM JEEVAN (open inputs)
- Barat's + Mugi's **GitHub usernames** (to add as collaborators).
- **AI monthly cost cap** ($) — PROJECT_BRIEF §10.
- FX API choice, hosting choice, PDF rasterisation approach (PROJECT_BRIEF §10 — can be decided later).
- Confirm whether to push to GitHub now or after GO.
