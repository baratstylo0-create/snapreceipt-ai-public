# MEMORY_LEDGER — Receipt Analyser SaaS
> Compact durable memory (lean-context). Load this FIRST on a returning session; don't re-derive.

## What this is
**Delivered, per-client automation SYSTEM** (NOT a multi-tenant SaaS — ADR-020, 2026-07-05): read receipts (photo/PDF) → extract client-templated fields → dashboard + Excel + Telegram bot + Falc agent. Vertical AI track. Under Friction SOP. We build once, deploy/customise an instance per client (their template/categories/branding/features). No self-serve signup / billing / app-store / installer. ALL features stay; only packaging changed. "SaaS phases" (public onboarding, billing, store, marketplace multi-tenancy) flagged N/A; multi-tenant/roles = per-client option. "16-layer" completeness image not yet in repo (pending Owner).

## Architecture (one line each)
- Node 22 + Express, **no build**, deps = express+dotenv (+ approved). Native fetch/Buffer, `hreq()` helper. No axios/node-fetch/multer.
- Supabase Postgres via REST, **service-role server-side only**; browser uses `/api/*`. RLS on, anon denied.
- Groq vision OCR + LLM; tiered model routing; backoff on 429.
- Telegram bot + dashboard upload = inputs. `account_id` scopes everything (multi-tenant-forward).
- Being modularized: `server.js` (wiring) + `lib/*` (one concern/file) + `routes/*`. See `docs/ARCHITECTURE.md` §3 frozen interfaces.

## Ownership (collision-safe; edit only your files)
- **Barat:** lib/groq, lib/supabase, schema.sql, lib/templates(#12 shared), lib/ocr(#4,#1), lib/confidence(#11), routes/webhook, routes/templates.
- **Jeevan:** lib/categorize(#6), lib/anomaly(#5), lib/reports(#8), lib/agent(#9), lib/excel(#2), lib/currency(#10), lib/massupload(#7), routes/{expenses,reports,agent,upload}, setup/CI.
- **Mugi:** public/index.html (#3) + business-account structure (M2).

## Key facts / GOTCHAS
- Active repo: `C:\Users\Asus\Downloads\receipt-analyser-saas`. NOT `Gold_Bot` (that's an unrelated forex bot).
- `expense_date` is TEXT on purpose (messy OCR dates). Don't make it a strict date column.
- Groq is inference-only (Barat reconfirm at wire-up). No images/PII in logs; mask card last-4; retention policy (ADR-002).
- Currency conversion = FX API, NOT the LLM (ADR-005).
- Modularize BEFORE feature work (ADR-001). No feature code until PROJECT_BRIEF signed GO.
- gh authed as Jeevan1811. **Remote live** (github.com/Jeevan1811/receipt-analyser-saas); **branch→PR→review→merge only** (pre-push blocks direct-to-main). **CI** = `.github/workflows/ci.yml` (`npm ci`+`npm test` on PR/push). **Owner names every merge**; auto-mode classifier blocks self-authored merges + closing issues you didn't open unless the Owner explicitly directs it.
- **Tests: `.env` move-aside** — `mv .env .env.local.bak` before `node --test`, restore after (CI is hermetic since `.env` is gitignored). Suite is currently **1515** green.
- **Supabase MCP ≠ the live instance.** The MCP token only reaches the FrictionAI parent project (`fziaxuhonvrhqjulhcyu`); the receipt-analyser data plane is Premala `xurnpvesgcybrnilxszf` (from `.env` `SB_URL`). Apply schema via the instance's **SQL Editor**, NEVER MCP `apply_migration`. **Verify the project ref before any DB write** (this once caught a cross-project write).
- **WORKLOG is append-only + prepend-newest** → parallel branches always conflict there; resolve by keeping ALL entries newest-first (mechanical). It's usually the ONLY conflict.
- **M2 isolation contract:** `lib/auth.scopeForUser` → admin `{account_id}` (sees all), clerk `{account_id, branch_id, company_id?}`. `lib/supabase.scopeEq` hard-ANDs account_id+branch_id; `scopeOr` adds null-tolerant `or=(company_id.eq.X,company_id.is.null)`. The **branch filter is the leak guarantee**; the null-tolerant company group keeps legacy null-company rows visible (#133). Routes pass `scope:req.scope`; bot stamps from the binding.

## Status (2026-07-08 — M2 + operationalisation done; ops-deploy remains)
**P4 core** long since merged. **M2 business layer SHIPPED to `main`** (epic #106/#107): business auth+roles (ADR-021), capability flags `CAP_*` (ADR-022), **company dimension + petty-cash floats/claims + dual xlsx/pdf Petty-Cash Statement** (ADR-023/024), **branch/company DB isolation** (scope bouncer #119 + wiring #131/#132 + null-tolerant company filter #133/#134), security gate (ADR-025), business Telegram bot (bind/capture/staff-tag/today-bills). **Operationalisation done on the code/config side:** CI ✅ (`ci.yml`), **hosting artifacts** (`render.yaml` default / `Dockerfile`+`fly.toml` portable + `docs/ops/2026-07-08-deploy-runbook.md`), **structured error logs** (`lib/log.js`) + **`/ready`** deep probe, **ADR-026** (error-tracking = platform log-drain first, Sentry opt-in). `npm test` main = **1515**.
- **Premala instance provisioned:** schema applied (via SQL Editor), `premala-admin` + Head Office branch, `CAP_*` = business profile (`docs/clients/premala.md §3`), Block F applied. Runbook: `docs/ops/2026-07-07-supabase-migration-runbook.md`.
- **Remaining = OPS ACTIONS on a live instance, not code:** (1) first **Render deploy** of Premala (#7 milestone — needs Owner's account+secrets); (2) external **uptime monitor** on `/health` (#13); (3) enable host **log-drain** (#12); (4) **Groq ZDR** on the account (pre-live). 
- **Open PRs:** #139 (Barat — bot Today's-Bills; **approved**, needs rebase onto current `main` + CI); #140 (docs — ADR-026 + completeness refresh; Owner merge). **Open issues:** #17 (templates label sanitization — Barat), #31 (per-image batch meta — deferred), #107/#106 (M2 epics — effectively done bar ZDR).
- **Truth sources:** `docs/WORKLOG.md` (top = newest), `docs/SYSTEM_COMPLETENESS.md` (16-layer status, refreshed), `docs/DECISIONS.md` (ADR-001…026).
