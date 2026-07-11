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
- **Tests: `.env` move-aside** — `mv .env .env.local.bak` before `node --test`, restore after (CI is hermetic since `.env` is gitignored). Suite **1800+** green on `main` (was 1515 on 2026-07-08; grown via the M2 QA round + Falc/PWA work). Run serial: `--test-concurrency=1` (Windows parallel-mode hang is a known non-bug).
- **Supabase MCP ≠ the live instance.** The MCP token only reaches the FrictionAI parent project (`fziaxuhonvrhqjulhcyu`); the receipt-analyser data plane is Premala `xurnpvesgcybrnilxszf` (from `.env` `SB_URL`). Apply schema via the instance's **SQL Editor**, NEVER MCP `apply_migration`. **Verify the project ref before any DB write** (this once caught a cross-project write).
- **WORKLOG is append-only + prepend-newest** → parallel branches always conflict there; resolve by keeping ALL entries newest-first (mechanical). It's usually the ONLY conflict.
- **M2 isolation contract:** `lib/auth.scopeForUser` → admin `{account_id}` (sees all), clerk `{account_id, branch_id, company_id?}`. `lib/supabase.scopeEq` hard-ANDs account_id+branch_id; `scopeOr` adds null-tolerant `or=(company_id.eq.X,company_id.is.null)`. The **branch filter is the leak guarantee**; the null-tolerant company group keeps legacy null-company rows visible (#133). Routes pass `scope:req.scope`; bot stamps from the binding. **⚠️ #164 (multi-branch clerk, Owner-approved 2026-07-11 — admin-assigned arbitrary subset) WILL change this contract:** clerk scope becomes `branch_ids:[...]` and `scopeEq` emits `branch_id=in.(…)` not `=eq.X`. Needs an ADR + isolation tests BEFORE code (rewrites the leak guarantee + live Premala schema).

## Status (2026-07-11 — M2 + QA round + Falc/PWA shipped; live on Premala VPS)
**P4 core + M2 business layer** long since on `main` (epic #106/#107): business auth+roles (ADR-021), `CAP_*` flags (ADR-022), company dimension + petty-cash floats/claims + dual xlsx/pdf Petty-Cash Statement (ADR-023/024), branch/company DB isolation (scope bouncer #119 + wiring #131/#132 + null-tolerant company filter #133/#134), security gate (ADR-025), business Telegram bot. **Operationalisation (code side) done:** CI, hosting artifacts (`render.yaml`/`Dockerfile`+`fly.toml`), structured logs (`lib/log.js`) + `/ready`, ADR-026.
- **DEPLOYED & LIVE:** auto-deploys to **Premala VPS `31.97.70.50`** on every merge to `main` (`.github/workflows/deploy.yml`, unprivileged `deploy` user). Standing blocker before go-live: **self-signed TLS** (real cert needed) + Groq ZDR on the account.
- **Recently shipped (2026-07-10/11):** QA round D10–D13 bot fixes (#162→PR166), batch/album capture (#152→PR168), dashboard staff-assign grid (#153→PR172), Team org-hierarchy tree (PR186), installable PWA/manifest (#188, no service worker per ADR-025), **Falc PRODUCT_GUIDE** — Falc now answers "how do I use this" for dashboard+bot, reusing real `lib/bot.js` strings verbatim (PR190) + WORKLOG/STATUS log (PR191).
- **Issue triage 2026-07-11 (CTO pass):** closed #162/#152/#153/#106/#107 as **stale-open-but-shipped** (verified on `main`; the Owner-names-every-merge flow means issues don't auto-close). **Genuinely open:** **#151** (staff picker doesn't scale >~10 — REAL, Owner-approved to build: paginate + type-to-search the Telegram picker, `lib/bot.js`, no schema); **#164** (multi-branch clerk — Owner-approved 2026-07-11, **admin-assigned arbitrary subset**; needs ADR + `user_branches` join table + `scopeEq` `in.()` change + isolation tests BEFORE code); **#31** (per-image batch meta — deferred).
- **Remaining OPS (live instance, not code):** real TLS cert; uptime monitor on `/health`; host log-drain; Groq ZDR.
- **Truth sources:** `docs/WORKLOG.md` (top = newest), `docs/STATUS.md`, `docs/SYSTEM_COMPLETENESS.md`, `docs/DECISIONS.md` (ADR-001…026).
