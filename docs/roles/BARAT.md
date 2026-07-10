# ROLE BRIEF — Barat (Deputy) · Claude-B1 / B2
> Read this AFTER the startup chain. You are the **Deputy** and you own the **infra + OCR/vision** surface.

## 0. Startup ritual (every session, before any work — SOP §0, §4.2)
Read in order:
1. `docs/FRICTION_PROJECT_SOP.md` (the constitution)
2. `/CLAUDE.md` (repo technical guide)
3. `docs/PROJECT_BRIEF.md` (scope — do not exceed it)
4. `docs/ARCHITECTURE.md` (module map + **frozen interfaces** — build against §3)
5. `docs/WORKLOG.md` (what others did) + `docs/STATUS.md` (phase/blockers)
6. Open GitHub Issues + PRs
Then: `git fetch --all --prune` → `git pull` base → claim your task in STATUS.md → branch `feature/barat-<phase>-<desc>` from the agreed base.

## 1. YOUR JOB — connect the infrastructure (this is the part Jeevan flagged explicitly)
**You wire up the external services. Nothing else works until these are solid.**
- **Groq** (`lib/groq.js`): create the client, model routing (ARCHITECTURE §3.5), keep the exponential backoff. Confirm at console.groq.com that the model IDs in `.env` are live (Groq deprecates models). Confirm Groq API is inference-only (no training) and note it in DECISIONS.md.
- **Supabase** (`lib/supabase.js` + `schema.sql`): create the account-scoped helpers (§3.3), apply the schema (incl. the new columns in §3.4: `confidence`, `anomaly`, `currency_original`, `amount_original`, `fx_rate`, `template_id`, and the `field_templates` table). DB access is **service-role, server-side only** — never expose the key to the browser.
- Fill real values in **`.env`** (never commit it — it's git-ignored). Use `.env.example` as the key list; add `VISION_MODEL_HEAVY`, `TEXT_MODEL`, `CLASSIFY_MODEL`, `FX_*`, `RETENTION_DAYS`.

## 2. YOUR FILES (edit ONLY these — collision rule, SOP §4.6)
- `lib/groq.js`, `lib/supabase.js`, `schema.sql`  *(infra)*
- `lib/templates.js`  — **#12 Custom Field Template. SHARED CONTRACT** (ARCHITECTURE §3.1). Jeevan's Excel/dashboard depend on `getFieldSpec()` — freeze the signature; if it must change, announce in WORKLOG first.
- `lib/ocr.js`  — **#4 OCR core + #1 PDF**. Drive extraction from the FieldSpec. Treat model output as untrusted.
- `lib/confidence.js`  — **#11 low-confidence alerts**. Emit per-field confidence; flag, never silently guess.
- `routes/webhook.js`, `routes/templates.js`

## 3. Your features & acceptance
| # | Feature | Done when |
|---|---|---|
| infra | Groq + Supabase wired | `/health` ok, a real receipt round-trips through Groq into Supabase |
| #12 | CSV field template | importing a CSV sets the account's FieldSpec; OCR + Excel honour it |
| #4/#1 | OCR images + PDF | clear receipt → correct fields; PDF supported (see §10 open Q on rasterisation) |
| #11 | Low-confidence alerts | low-confidence fields flagged for review, not guessed |

## 4. Security (non-negotiable, SOP §7)
Validate every input (schema/zod-style). Parameterized DB only. No images/PII in logs. Mask card last-4. Isolate user/receipt content from system prompt (prompt-injection). Never execute model output.

## 5. Post-work ritual (every push — SOP §4.3)
Small Conventional Commits → push **your** branch only → update `docs/WORKLOG.md` → open/update a PR to `develop` (or `main`) → **never self-merge** (Owner/Deputy merge; as Deputy you may merge others' approved PRs only when the Owner is unavailable, same review bar). As Deputy you still never push to `main` directly.

## 6. As Deputy

When Jeevan (Owner) is away, you may approve + merge others' PRs to `main` — same bar, never your
own PR (or your own Claude's PR — you still need someone else for that), never a direct push. This
is the concrete checklist your Claude should run through before merging anything, mirroring what
Claude-J has actually been doing all along:

1. **Never merge on the PR description alone — read the real diff.** `gh pr diff <N>` or `git show`
   the branch. A PR that "sounds right" can still be wrong; the description is the author's claim,
   not proof.
2. **Pull the branch and run the full suite locally, not just trust "tests pass" in the PR body.**
   `.env` holds live secrets and must be moved aside first or ~90 tests falsely fail on env
   contamination: `mv .env .env.local.bak && node --test --test-concurrency=1 && mv .env.local.bak .env`.
   (`--test-concurrency=1` avoids a known Windows-only `node --test` parallel-execution hang that has
   nothing to do with the code — don't chase it as a bug if you hit it; serial execution is the fix.)
3. **Confirm CI is actually green on GitHub, not assumed.** `gh pr checks <N> --watch` and wait for
   it — CI only triggers on PRs targeting `main` (`.github/workflows/ci.yml`), so double-check the
   PR's base branch is `main`, not a stale feature branch (this has silently swallowed a "merge"
   before — the PR showed merged on GitHub but the commits never reached `main` because the base was
   wrong, and CI never ran because of it).
4. **Apply the Tier-2 gate (SOP §4.7) honestly, not as a formality.** Money/financial math,
   untrusted input (uploads/OCR/webhooks/AI output), auth/permissions/tenant isolation, schema
   migrations, new dependencies — these need a real approving read from someone other than the
   author, every time, no matter what the Owner says in the moment. "Just merge it" doesn't waive
   this; it's the safeguard for exactly that moment.
5. **Update `docs/WORKLOG.md`** (prepend-newest, append-only — never edit/delete an old entry) the
   moment you merge, so the other Claudes aren't drifting on stale state.
6. **Deploying live is now automatic.** As of `.github/workflows/deploy.yml`, every push to `main`
   (i.e. every merge) auto-deploys to the Premala VPS on its own — tests re-run as a gate, then it
   packages via `git archive` (only git-tracked files, so `.env`/`node_modules` structurally can't
   leak in), uploads, restarts, and verifies `/health` + `/ready`, all as the unprivileged `deploy`
   VPS user (its own pm2 daemon, zero sudo, chown'd only to `/opt/receipt-analyser` — see next
   point). **You don't need VPS access to ship a merge; merging is the whole job.** Just watch the
   Action run (`gh run watch` or the Actions tab) and confirm it went green before telling anyone
   it's live. The old manual method (isolated `git worktree` → tar → scp → `pm2 restart`) still
   works as a fallback if the Action itself is broken or you need to deploy something that isn't on
   `main` yet, but should no longer be the normal path.
7. **Read `/opt/README.md` on the VPS first, every time.** That box is shared — your own
   `frictionai`/`quote-server`/`health-monitor` live there too, alongside `receipt-analyser`. Only
   touch the directory/pm2 process you're deploying. Never run a command (`pm2 restart`/`stop`/
   `delete`, `docker`, system-wide config) that could affect a project you don't own without that
   project's owner (Jeevan, for `receipt-analyser`) signing off first — the same rule this repo's
   Claude follows when it's your `frictionai` sitting on the same box.
