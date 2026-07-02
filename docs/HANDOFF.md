# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION END — Claude-J1. READ THIS FIRST.  (updated 2026-07-02, latest)

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #32 merge (`0e48033`). gh authed as Jeevan1811. `npm install` after clone; direct push to main blocked — branch + PR only. `npm test` on main = **273 passing** (274 on the open `chore/jeevan-j1-session-end` branch with 1 cherry-picked QA test).

### What landed recently (state as of this refresh)
1. **#7 MASS UPLOAD — COMPLETE ON BOTH SURFACES.**
   - **PR #28 MERGED** (`a3b800b`) — Jeevan's `lib/massupload.js` `runBatch` (best-effort, never-throws batch orchestrator) + `routes/upload.js` `POST /api/upload` (checkDash, base64→Buffer, ≤10 → 413, 503 dark-path). Independent Tier-2 QA APPROVE.
   - **PR #29 MERGED** (`d52bc96`) — Barat's `extractReceipts()` in `lib/ocr.js` (the #7 OCR dep). QA APPROVE-with-minor; the one Minor is pre-existing → **issue #30** (low priority, Barat's `lib/ocr.js`).
   - **PR #32 MERGED** (`0e48033`) — Barat's **Telegram multi-photo adapter** (`lib/bot.js` buffers a media group by `media_group_id`, debounces ~2s, clamps to `MASS_MAX_IMAGES`=10 → ONE `runBatch` → one counts-only summary). Independent Tier-2 QA = **APPROVE (clean)**: buffering/debounce correct, never-throws holds, `failed[].reason` non-leak confirmed (planted-secret regression test), single-photo path unchanged. `meta.fileId:null` (Option A; per-image links = **issue #31**, deferred).
2. **PR #27 (housekeeping) MERGED** — ADR-013 (jszip), + groq QA tests.
3. **#9 (PR #25) + `groqChatTools()` (PR #26)** — merged earlier (see WORKLOG).

### Open PRs
- **`chore/jeevan-j1-session-end`** (this refresh) — cherry-picked the PR #32 QA's 1 hardening test (download-rejection safety) so it lands on main (SOP §4.4 — not pushed to Barat's branch), + this HANDOFF/STATUS refresh. Tier-1; self-merge auto-blocked → **Owner merges, or next Claude read-diff+test reviews first.**

### EXACT NEXT ACTIONS for next Claude (in order)
1. **Merge the `chore/jeevan-j1-session-end` PR** (Owner, or self-review-first).
2. **#1 PDF ingestion — THE ONLY REMAINING BACKEND ITEM.** Blocked on a **joint rasterization brainstorm with the Owner** (turning a PDF into page images with the project's no-build-step + minimal-deps constraint makes the dependency choice non-trivial — likely a new ADR). **Owner asked to do this as a FRESH SESSION** (budget: one session per feature — this session did #9 + #7 end-to-end and ran heavy). Barat is HOLDING — do not let him start #1 PDF solo; it needs the brainstorm first. Start: brainstorm → spec → plan → subagent-TDD, same as #2/#9/#7.
3. **ADR-011 reference frontend** for Mugi (after #1 PDF, or in parallel — surfaces every /api/* feature for Mugi to design production UI from).

### Barat status (his #7 work is DONE)
`extractReceipts` (#29) + Telegram multi-photo (#32) both merged. Nothing urgent open in his lane. Remaining: **#1 PDF (WAIT for the joint brainstorm)**, business Excel (PARKED). Issue #30 (low-priority hardening in his `lib/ocr.js`) is his call, non-blocking.

### Decisions locked (2026-07-02)
- **Business Excel phase: PARKED** (personal M1 first per SOP). jszip validated for it (exceljs drops charts).
- **jszip → explicit dep: APPROVED in principle (ADR-013)**; package.json promotion deferred to business-Excel Phase-1.
- **Workflow: one fresh session per feature** going forward (marathon multi-feature sessions burn the quota window fast; the HANDOFF contract is designed for exactly this).

### GOTCHAs (carry forward)
- (a) **Before diagnosing "post-merge test failures" as a code bug, run `npm install`** — a dependency added to `main` after your branch forked leaves your local `node_modules` missing it (whole-test-file load failures + an "all modules import" failure = a missing dep, not logic). PR #22 was nearly mis-triaged this way (missing `exceljs`).
- (b) The auto-mode classifier **blocks self-authored PR merges** (even Tier-1 docs) — the Owner merges, OR you do the full read-diff + run-tests review yourself first. It also blocks `git reset --hard` that would discard a local-only commit a handoff relied on.
- (c) A subagent dispatched to QA a teammate's PR **checks out that branch in the shared working tree** — don't do local git ops while it runs; wait for it to finish.

### Merge-decision authority (Owner delegated to J1/J2)
Merge when the independent QA/Tier-2 review is clean OR after fixing its findings; HOLD on Critical/Important, or when the fix is the author's (Barat's files: `lib/ocr.js`, `lib/groq.js`, `lib/supabase.js`, `lib/templates.js`, `lib/confidence.js`). Auto-mode may prompt before merging a teammate's PR — verify the precondition landed (git log), then proceed.

---

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
> **UPDATE 2026-07-01 (Claude-J2):** P3 infra done; **PR #9 templates MERGED**. Now in P4 features.
> Open PRs: **#8 reports** (QA fixes pushed, re-review) and **#6 categorization** (built, 50/50, awaiting review).
> Next actions below supersede the P3 list.

1. **Review + merge the open feature PRs:**
   - **PR #8 (reports #8):** QA-requested fixes pushed (truncation surfaced, strict date validation, +route/data-quality tests). Awaiting QA re-review → then Owner merge.
   - **PR #6 (categorization #6):** LLM-supervised learning categorizer. Awaiting Tier-2 + QA review → Owner merge.
2. **Barat (after PR #6 merges):** apply `db/2026-07-01-category_corrections.sql` in Supabase + fold into `schema.sql`; wire `categorizeLineItems(receipt, fieldSpec)` into `lib/ocr.js` where it currently calls `normaliseExpenseCategory`. Also the currency (#10) wire-up snippet from that PR.
3. **Jeevan's remaining features:** #5 anomaly (duplicates + **personal-expense admin accept/reject queue** — reuses #6's `flagged` field), #2 Excel (reads FieldSpec, unblocked by #9), #9 agent, #7 mass upload. Each = one branch = one PR = cross-reviewed.
4. **Mugi:** deferred (#3 dashboard + business structure) — needs GitHub username; also owes the dashboard category-pill expansion to the new #6 chart of accounts.

## Pending inputs / open items
- Barat: run schema in his Supabase; invite Jeevan to that project for visibility; confirm vision routing (ADR-007).
- CTO flag (open question): production Supabase should move off Barat's personal account to a shared org/Owner account before launch.
- Mugi GitHub username (when he starts).

## STILL NEEDED FROM JEEVAN (open inputs)
- Barat's + Mugi's **GitHub usernames** (to add as collaborators).
- **AI monthly cost cap** ($) — PROJECT_BRIEF §10.
- FX API choice, hosting choice, PDF rasterisation approach (PROJECT_BRIEF §10 — can be decided later).
- Confirm whether to push to GitHub now or after GO.
