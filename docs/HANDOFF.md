# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION END — Claude-J1. READ THIS FIRST.  (updated 2026-07-02, latest — #1 PDF dispatched)

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #36 merge. gh authed as Jeevan1811. `npm install` after clone; direct push to main blocked — branch + PR only. `npm test` on main = **275 passing**. **No open PRs.**

### State: #1 PDF ingestion is IN BUILD (Barat's lane)
Brainstormed with Owner → spec + **ADR-014** (`@hyzyla/pdfium`, WASM PDFium) + full TDD plan, all merged to main (PR #35, #36). **J1 ran the Task-0 interop spike in-session** (throwaway, not committed) and it **PASSED**: dynamic `import()` from CJS works, `page.render()`→RGBA→`node:zlib` PNG (no `sharp`) produced a legible page, zero-dep confirmed. **Fallback not needed.** Full detail in ADR-014 (`docs/DECISIONS.md`) and `docs/plans/2026-07-02-pdf-ingestion.md`.

**Barat was dispatched** (full task list relayed in-session) to build `feature/barat-p4-pdf`: `lib/pdf.js` (rasterizer) + Telegram PDF path in `lib/bot.js`, TDD, Tier-2. His Task 0 is reduced (spike pre-done) to: install dep + generate fixtures + confirm the encrypted-PDF error string.

### EXACT NEXT ACTIONS for next Claude
1. **`gh pr list`** — check if Barat's `feature/barat-p4-pdf` PR is open.
   - **If open:** read the plan (`docs/plans/2026-07-02-pdf-ingestion.md`) Tasks 0–5 as the acceptance checklist, do the **independent Tier-2 QA** (untrusted PDF parser + new dep — fixture coverage: native/scanned/multi-page/encrypted/corrupt/oversized/non-PDF, no leaked internals, `MASS_MAX_IMAGES` cap respected), then merge if clean (Owner delegated authority) or hand findings back.
   - **If not open yet:** nothing to do on #1 — check WORKLOG.md top for anything else pending; otherwise this is a natural idle window (non-blocking issues below, or wait).
2. **After Barat's `lib/pdf.js` merges:** J1's own **Task 7** — `routes/upload.js` PDF glue (fork branch AFTER his merge, `npm install` first since a dep landed). Plan has full task+code.
3. **ADR-011 reference frontend** for Mugi — after #1 fully lands.

### Decisions locked (2026-07-02)
- ADR-014: `@hyzyla/pdfium` (WASM, MIT/BSD, zero-dep) for PDF rasterization; MuPDF rejected (AGPL); PNG encoded via `node:zlib` (NOT `sharp` — vendor's example uses sharp, we rejected it to keep exactly 1 added dep).
- Business Excel stays PARKED; jszip ADR-013 stands.
- One fresh session per feature; HANDOFF contract designed for exactly this.

### GOTCHAs (carry forward)
- (a) **`npm install` before diagnosing "post-merge test failures"** — a dep added to `main` after your branch forked leaves `node_modules` stale.
- (b) Auto-mode classifier **blocks self-authored PR merges** (even Tier-1 docs, even with prior "merge the branches" authorization — it does NOT extend to PRs created after that authorization). Owner must explicitly name/authorize each PR, or you do full read-diff+test review first.
- (c) A subagent QA-ing a teammate's PR **checks out that branch in the shared working tree** — don't do local git ops while it runs.
- (d) `@hyzyla/pdfium`'s `page.render()` returns raw RGBA, not PNG — don't add `sharp`; use the `node:zlib` encoder in the plan (Task 2, code is spike-verified).

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
