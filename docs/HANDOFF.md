# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J1) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION END — Claude-J2 (context ran low, ~6% budget left). READ THIS FIRST.

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas` (NOT `Gold_Bot` — unrelated forex bot; ignore it).
**Local branch checked out right now:** `feature/jeevan-p5-anomaly` — clean, fully pushed, nothing uncommitted.
**GitHub:** https://github.com/Jeevan1811/receipt-analyser-saas

### What J2 did this session (in order)
1. **Merged PR #9** (Barat's `lib/templates.js` FieldSpec engine, #12) into `main`. Verified sync + Tier-2 review notes were addressed, 28/28 tests, clean merge-tree — then Owner approved and it was merged + branch deleted.
2. **Pushed PR #8's pending QA fixes** (reports #8) that a prior session had written but not committed: strict ISO date validation, truncation surfaced (`{truncated, fetched_count}`, limit 5000→10000), route-level tests. Commit `3157e08`. **Still awaiting QA re-review — J2 never merged this, it's Owner/QA's call.**
3. **Built feature #6 — categorization** (brainstormed + designed with Owner first, spec at `docs/specs/2026-07-01-categorize-design.md`). LLM-supervised **learning** categorizer: MEMORY (learned corrections) → RULES (keyword engine, ~18-category chart of accounts) → LLM WATCHDOG (one batched Groq call/receipt, confirms/overrides-only-if-confident≥0.75/flags). Anti-hallucination: LLM output clamped to an allow-list, receipt text treated as untrusted data. New `lib/categorize.js` extension + `lib/categoryMemory.js` + migration `db/2026-07-01-category_corrections.sql` (Barat to apply — code degrades gracefully without it). **50/50 tests.** → **[PR #10](https://github.com/Jeevan1811/receipt-analyser-saas/pull/10)**, branch `feature/jeevan-p4-categorize`. Open, awaiting review.
4. **Built feature #5 — anomaly detection + admin review queue** (same design-first process, spec at `docs/specs/2026-07-01-anomaly-design.md`). `lib/anomaly.js` `detectAnomalies()`: 4 detectors — duplicate (deterministic, merchant+amount+date window), outlier (deterministic, amount vs median), data_quality (deterministic, missing/impossible dates, subtotal+tax math), personal/non-business (LLM watchdog, caged like #6). New admin queue `routes/review.js` (`GET /api/review`, `POST /api/review/:id {decision,note}`) — status machine `saved→needs_review→approved|rejected`, audit stored in existing `expenses.anomaly` jsonb (**no schema change**). **50/50 tests.** → **[PR #11](https://github.com/Jeevan1811/receipt-analyser-saas/pull/11)**, branch `feature/jeevan-p5-anomaly`. Open, awaiting review.
5. **Watched a YT video on BookZero.ai (a similar receipt SaaS) with the Owner and made an architecture call: ADR-010.** Owner raised a real scenario — a single user might be "personal" day-to-day but also run a small side business and want to claim tax. Decided **against** a personal/business fork (duplicate codebase) — instead **one codebase + capability flags**, personal is the default (all business capabilities off). New `lib/account.js` `getCapabilities()` = single source of truth (env-driven v1: `ACCOUNT_TYPE`, `CAP_BUSINESS_PROFILE`, `CAP_CLAIMS_TAX`, `CAP_BANK_RECONCILIATION`, `CAP_MULTI_USER`, `BUSINESS_TYPE` in `.env.example`). **First consumer, already wired:** #5's personal-vs-business detector is gated on `businessProfile` — OFF for personal accounts (the other 3 detectors still run for everyone). This is on **PR #11** too (commit `e8cc23b`). Full reasoning in `docs/DECISIONS.md` ADR-010.
   - **Video ideas logged but NOT built** (Owner said "not necessarily," just wanted them noted): bank-statement reconciliation (receipt↔bank-transaction matching — pairs naturally with #5's anomaly work: unmatched receipt = suspicious, unmatched bank charge = "missing receipt"), a tax-recovery dashboard metric, Sentry+PostHog observability, email-inbox import. All are `claimsTax`/`bankReconciliation` capability (business) features — exactly why ADR-010 had to land first. See MEMORY_LEDGER for the one-line summary.

### Open PRs right now (none merged by J2 except #9)
| PR | Feature | Branch | State |
|---|---|---|---|
| #8 | reports | `feature/jeevan-p4-reports` | QA fixes pushed, awaiting QA re-review |
| #10 | #6 categorization | `feature/jeevan-p4-categorize` | Open, awaiting Tier-2 + QA review |
| #11 | #5 anomaly + ADR-010 | `feature/jeevan-p5-anomaly` | Open, awaiting Tier-2 + QA review |

### Exact next actions for J1
1. Review/merge #8, #10, #11 (Tier-2 + QA — these touch AI/money surfaces). **Heads-up:** all three touched `docs/WORKLOG.md`'s top entry independently — expect a trivial merge conflict there; resolve by keeping both/all entries, newest-first.
2. After #10 + #11 merge → hand to **Barat**: apply `db/2026-07-01-category_corrections.sql` (fold into `schema.sql`); wire `categorizeLineItems(receipt, fieldSpec)` AND `detectAnomalies(expense, {history, businessType})` into `lib/ocr.js`/`lib/bot.js` at ingestion (his files — do not edit them yourself).
3. After #8 merges → add a `status=neq.rejected` filter to report/Excel totals (1 line; #5 introduced the `rejected` status).
4. Then continue Jeevan's remaining features: **#2 Excel** (reads FieldSpec, unblocked since #9 merged) or **#9 agent** or **#7 mass upload**.
5. Any new business-only feature (bank reconciliation, tax recovery, multi-user) MUST be gated behind a `lib/account.js` capability per ADR-010 — do not build a separate business codepath.
6. **Housekeeping:** a stray background `node -e` process may still be holding port 3001 from J2's testing — check/kill it if `npm test`/`node server.js` complains about the port. Also there's a harmless orphaned `git stash` (`"ledger note"`) from earlier in the session — safe to `git stash drop` in a normal terminal whenever convenient.

### Gotchas learned this session (don't repeat)
- Auto-mode blocks `git stash drop` and broad `taskkill /IM node.exe` as irreversible/blast-radius actions — do targeted kills or ask the user in a real terminal instead.
- Auto-mode blocks merging a teammate's PR without an explicit confirmation that their named precondition (e.g. "once he syncs") actually landed — verify with git log, then still ask before merging someone else's work.
- `MEMORY_LEDGER.md`/`WORKLOG.md`/`STATUS.md`/`HANDOFF.md` get edited on EVERY feature branch — expect trivial merge conflicts on these when multiple feature PRs merge close together; always keep all entries (they're append-only logs), never drop one side.

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
