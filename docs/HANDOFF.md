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
- **No feature code written. No git commit yet. No GitHub remote yet.** (Awaiting Jeevan's GO.)

## Decisions locked (see DECISIONS.md)
- Repo Owner = Jeevan (gh: Jeevan1811); Deputy = Barat.
- Track = Vertical AI. M1 = personal version, 12 features.
- Modularize server.js FIRST (ADR-001). Groq data = masking + retention (ADR-002). CSV field template #12 foundational (ADR-003). Coupling-based split (ADR-004): Barat=infra+#4,#1,#11,#12; Jeevan=#5,#6,#8,#9,#2,#10,#7; Mugi=#3+business. Currency = FX API not LLM (ADR-005).

## EXACT NEXT ACTIONS (in order)
1. **Jeevan signs GO** in `docs/PROJECT_BRIEF.md` (CTO Validation → Decision line). Until then, no feature code.
2. **First git commit** of the scaffolding (suggested):
   ```
   cd C:\Users\Asus\Downloads\receipt-analyser-saas
   powershell -ExecutionPolicy Bypass -File .\setup-git-hooks.ps1
   git add -A
   git commit -m "chore: kickoff scaffolding, Friction governance docs, git hooks"
   ```
3. **Create GitHub remote + add collaborators** (gh is authed as Jeevan1811):
   ```
   gh repo create receipt-analyser-saas --private --source=. --remote=origin --push
   gh repo edit --enable-issues
   gh api -X PUT repos/Jeevan1811/receipt-analyser-saas/collaborators/<barat-gh>   -f permission=push
   gh api -X PUT repos/Jeevan1811/receipt-analyser-saas/collaborators/<mugi-gh>    -f permission=push
   ```
   (Replace `<barat-gh>` / `<mugi-gh>` with their GitHub usernames — still NEEDED from Jeevan.)
4. (Optional, paid/public) branch protection: a `setup-branch-protection.ps1` can be added; local pre-push hook already enforces it for free private repos.
5. **First feature branch = the modularization** (ADR-001): `feature/jeevan-p2-modularize-server` — move logic from `server.js` into `lib/` + `routes/` per ARCHITECTURE §2, no behaviour change. Open PR, Barat reviews, Owner merges.
6. Then Barat starts P3 infra; parallel feature work begins.

## STILL NEEDED FROM JEEVAN (open inputs)
- Barat's + Mugi's **GitHub usernames** (to add as collaborators).
- **AI monthly cost cap** ($) — PROJECT_BRIEF §10.
- FX API choice, hosting choice, PDF rasterisation approach (PROJECT_BRIEF §10 — can be decided later).
- Confirm whether to push to GitHub now or after GO.
