# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION IN PROGRESS — Claude-J2. READ THIS FIRST.  (updated 2026-07-02, later)

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #29 merge (`d52bc96`). gh authed as Jeevan1811. `npm install` after clone; direct push to main blocked — branch + PR only. `npm test` on main = **~212 passing** (post-#29). On the `feature/jeevan-p4-massupload` branch = **266**.

### What landed recently (state as of this refresh)
1. **PR #27 (housekeeping) — MERGED (`a13ba6d`).** ADR-013 (jszip), refreshed HANDOFF/STATUS, 2 cherry-picked groq QA tests. Merged after the full read-diff + test-run self-review protocol (self-merge is auto-blocked).
2. **PR #29 — MERGED (`d52bc96`, Barat's `extractReceipts()` in `lib/ocr.js`).** The #7 cross-lane dep. Opened on Barat's behalf (no `gh` auth); fresh independent Tier-2 QA = **APPROVE WITH MINOR FINDINGS** — verified `extractReceipt`/`parseModelJson` behaviour-preserved, array-rejection intact, unterminated-`<think>`→`[]`, extra-key stripping, `fileId:null` tolerated. +19 QA regression tests (new file, `lib/ocr.js` untouched). The one Minor (single-object-array leak on the singular path) is **pre-existing on main, not a regression** → filed as **issue #30** (Barat, low priority). Branch conflict (WORKLOG) resolved keep-both before merge.
3. **#9 (PR #25) + `groqChatTools()` (PR #26)** — merged earlier this day (see prior HANDOFF history / WORKLOG).

### Open PRs
- **PR #28 `feature/jeevan-p4-massupload`** (#7 mass upload) — **CLEAN/MERGEABLE, awaiting OWNER merge** (self-authored → sandbox blocks self-merge; independent Tier-2 QA already APPROVE, 266/266). `lib/massupload.js` `runBatch` + `routes/upload.js` `POST /api/upload`. Synced with main (has #29). **Owner: just merge it.**

### EXACT NEXT ACTIONS for next Claude (in order)
1. **Owner merges PR #28** (#7 mass upload). After it lands, #7's live `POST /api/upload` un-darkens on the next **server restart** (dep resolved at mount time; `ocr.extractReceipts` is already on main via #29).
2. **#1 PDF ingestion** — PARKED pending a **joint rasterization brainstorm with the Owner** (the no-build-step constraint makes the dependency choice non-trivial). Barat is holding; don't let him start solo. **This is the next thing that needs the Owner.**
3. **Barat's next build:** Telegram multi-photo adapter (`lib/bot.js` gathers a media group → calls the transport-agnostic `runBatch`) — his lane, spec-only until #28 lands. #1 PDF stays held for the brainstorm.
4. **ADR-011 reference frontend** for Mugi (after the backend features land).

### Decisions locked this session (2026-07-02)
- **Business Excel phase: PARKED** (personal M1 first per SOP). Barat's spike done (exceljs drops charts → jszip XML-injection validated); resume when personal M1 backend is complete.
- **jszip → explicit dep: APPROVED in principle (ADR-013)**; the actual `package.json` promotion is deferred to the business-Excel Phase-1 PR (don't add an unused dep while parked).

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
