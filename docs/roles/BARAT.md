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
When Jeevan (Owner) is away, you may approve + merge others' PRs to `main` — same bar, never your own PR, never a direct push.
