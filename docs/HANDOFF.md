# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION IN PROGRESS — Claude-J2. READ THIS FIRST.

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #8 merge (`5759ec1`). gh authed as Jeevan1811. `npm install` after clone; direct push to main blocked — branch + PR only. `npm test` on main = **127 passing**. No open PRs.

### What J2 did this session
1. **Merged PR #13 — Barat's `/api/templates` (#12 HTTP door).** Dispatched a fresh non-author QA subagent → **CHANGES REQUESTED (1 Critical)**: malformed JSON / unsupported charset made `express.json()`/`express.text()` throw synchronously, bypassing the route's try/catch and leaking a full stack trace + server file paths via Express's default handler (SOP §7.2). Fixed inline (route-local error middleware on the POST chain + a global app-level fallback in `server.js` — neither file is on Barat's protected list). QA's 5 adversarial tests kept as permanent regressions. Non-blocking stored-XSS-supply-risk + control-char findings → **GitHub issue #17**. Merged, `main` = 101 tests.
2. **Merged PR #8 — reports (#8).** Dispatched a fresh QA subagent to re-review (prior fixes were pushed but never re-reviewed). Verified the prior fixes hold; fresh pass found **2 Important, verified bugs**: `Number(e.amount) || 0` in `lib/reports.js` turned non-numeric garbage into fake money and let `Infinity` poison the whole report. Fixed with a strict `toAmount()` helper. Also added the queued `status=neq.rejected` filter to `routes/reports.js` so #5-rejected expenses never count toward totals. Merged, `main` = 127 tests.
3. **Barat's ingestion-wiring PR is NOT open yet** — he's still working on it (categorizeLineItems + detectAnomalies + convertCurrency into `lib/ocr.js`/`lib/bot.js` + `db/2026-07-01-category_corrections.sql`). Next Claude: check `gh pr list` for it before starting anything else — it's Tier-2 and next in the review queue when it lands. Remind Barat: `detectAnomalies` opts must be built server-side only, never from client body (ADR-010).
4. Starting Jeevan's own features next: **#2 Excel** (reads FieldSpec, unblocked) → **#9 dashboard agent** → **#7 mass upload**. Each = brainstorm/design-first + spec in `docs/specs/` + branch + PR + QA (per SOP, since these touch money/AI surfaces).

### Open PRs at handoff
None open as of this refresh.

### EXACT NEXT ACTIONS for next Claude (in order)
1. **Check `gh pr list`** — if Barat's ingestion-wiring PR has landed, review it first (Tier-2: touches `lib/ocr.js`/`lib/bot.js` ingestion + a DB migration).
2. **Jeevan's remaining features:** #2 Excel → #9 dashboard agent → #7 mass upload. Each = branch + PR + QA (money/AI surfaces = Tier-2).
3. **Then ADR-011 reference frontend** for Mugi.
4. **Merge conflicts:** every feature PR touches WORKLOG/STATUS/HANDOFF/MEMORY. WORKLOG = keep-both (append-only, never drop an entry). State docs (STATUS/HANDOFF/MEMORY) = take `--theirs` (main) then refresh once.
5. **Gotcha learned this session:** feature branches that forked before a batch of P4 PRs landed on `main` (e.g. #13, #8) will show a stale test count when run standalone — `git merge origin/main` into the branch (resolving WORKLOG keep-both + doc conflicts) BEFORE re-running `npm test` or attempting `gh pr merge`, or the merge will report "not mergeable." Also: right after `git push`, `gh pr view --json mergeable` can return `UNKNOWN` for a few seconds while GitHub recomputes — wait/retry rather than assuming failure.

### Merge-decision authority (Owner delegated to J1/J2)
Merge when the independent QA/Tier-2 review is clean OR after fixing its findings; HOLD on Critical/Important, or when the fix is the author's (Barat's file: `lib/ocr.js`, `lib/groq.js`, `lib/supabase.js`, `lib/templates.js`, `lib/confidence.js`). Auto-mode may prompt before merging a teammate's PR — verify the precondition landed (git log), then proceed.

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
