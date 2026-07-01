# MEMORY_LEDGER — Receipt Analyser SaaS
> Compact durable memory (lean-context). Load this FIRST on a returning session; don't re-derive.

## What this is
SaaS: read receipts (photo/PDF) → extract customer-templated fields → dashboard + Excel. Vertical AI track. Under Friction SOP.

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
- gh authed as Jeevan1811. No GitHub remote yet. No commit yet.

## Status (2026-07-01, J2 mid-session)
**P4 features.** MERGED to main: #12 template engine + `/api/templates` route (PR#9, PR#13), **#6 categorization (PR#10)**, **#5 anomaly + ADR-010 (PR#11)**, #10 currency, **#4 OCR + #11 confidence (PR#12)**, **#8 reports (PR#8)**, **#2 Excel export (PR#19, ADR-012 exceljs)**. `npm test` main = **150**. No open PRs. Barat's ingestion-wiring PR (categorizeLineItems + detectAnomalies + convertCurrency into lib/ocr.js/lib/bot.js) STILL not opened — check `gh pr list` first thing next session. Non-blocking hardening tracked: issue #14 (categorizer), #17 (templates label sanitization), #20 (exceljs uuid audit bump). Merge authority delegated to J1/J2 (but auto-mode classifier blocks self-authored merges — Owner must direct, or do full read-diff+test review first). Next: Barat's ingestion PR (when opened) → Jeevan #9 agent → #7 mass upload → ADR-011 reference frontend. Full detail: `docs/HANDOFF.md` (J2 session block at top).

## Status (earlier — 2026-07-01)
**P4 features underway.** PR #9 (templates #12 FieldSpec, Barat) **MERGED** to `main`. Open: **PR #8** reports (QA fixes pushed, re-review) + **PR #6** categorization (J2 — LLM-supervised learning categorizer, 50/50 tests, `category_corrections` migration in `db/` handed to Barat; code degrades gracefully until applied). Next for Jeevan after #6/#8 land: **#5 anomaly** (duplicates + personal-expense admin accept/reject queue — reuses #6's `flagged` field). Barat: apply the migration + wire `categorizeLineItems` into `lib/ocr.js`. `npm test` on categorize branch = 50/50.
Modularization MERGED to `main` (PR #1 + #2). `main` = modularized: server.js 31 lines + lib/* + routes/* + tests; `npm test` 8/8. `npm install` needed after clone (node_modules git-ignored). Direct push to main blocked (pre-push hook) — branch + PR only.
Next: Barat fills lib/ infra (groq/supabase/templates) off main + runs schema + confirms vision routing (ADR-007); then Jeevan's features. Mugi deferred. See `docs/HANDOFF.md` for exact next actions.
