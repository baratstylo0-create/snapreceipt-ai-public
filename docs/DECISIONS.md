# DECISIONS — Receipt Analyser SaaS (ADR-lite)
> Why we chose X. Append as decisions are made.

## ADR-001 · Modularize the single-file server.js before any feature work
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** `server.js` is one 311-line file. Three Claude Codes (Jeevan, Barat, Mugi) working in parallel on one file = constant merge conflicts (violates SOP §4.6).
**Decision:** First task is a behaviour-preserving refactor into `lib/` + `routes/`, one file per concern, with frozen interfaces (ARCHITECTURE §3). Each feature then lives in its own file.
**Consequences:** One coordinated refactor PR up front; afterwards, near-zero collisions.

## ADR-002 · Groq data posture for v1 = masking + retention (not redaction)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** OCR requires sending receipt images (financial PII) to Groq. SOP §7.3 needs Owner sign-off. Groq API is inference-only (no training on API data — to be reconfirmed at wire-up).
**Decision:** Send images to Groq, but: (a) never write images/PII to logs; (b) mask card last-4 in stored output; (c) set a retention policy for raw images / `ai_raw`; (d) auth on every endpoint. Local pre-send redaction is **deferred** to post-MVP / business launch.
**Consequences:** Strong privacy for low effort; revisit redaction + GDPR/PCI before multi-customer business launch.

## ADR-003 · Customer-defined output via CSV field template (#12) is foundational
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** SaaS must fit every customer's own spreadsheet format. Hardcoding fields doesn't scale across customers.
**Decision:** Customer imports a CSV template; `lib/templates.js` derives a per-account FieldSpec (frozen contract, ARCHITECTURE §3.1); OCR extracts only those fields; Excel/dashboard output matches the template exactly.
**Consequences:** `lib/templates.js` is a shared contract owned by Barat but consumed by Jeevan's Excel/etc. — interface frozen at P1.

## ADR-004 · Coupling-based feature split (not strict equal count)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** Splitting work by equal count would put two owners in the same OCR files.
**Decision:** All OCR/vision-coupled work + infra → Barat; downstream analytics → Jeevan; frontend + business structure → Mugi. Two clean, non-OCR-colliding features (#7 mass upload via frozen groq.js, #10 currency standalone) moved from Barat to Jeevan to balance load.
**Consequences:** Barat = 2 infra + 4 features; Jeevan = 7 features; Mugi = frontend + business. Minimal collisions.

## ADR-006 · CLASSIFY_MODEL = openai/gpt-oss-20b (llama-3.1-8b-instant deprecated)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** Groq emailed a deprecation notice: `llama-3.1-8b-instant` is deprecated as of 2026-06/07 and **decommissioned 2026-08-16** (free + developer-tier; enterprise committed-spend unaffected). Groq's recommended replacement is **GPT OSS 20B** (`openai/gpt-oss-20b`).
**Decision:** Switch the cheap-classify/narrate slot (#6 categorization, report narration) to `openai/gpt-oss-20b`. Updated `.env.example`, `ARCHITECTURE.md` §3.5, `PROJECT_BRIEF.md` §4.
**Consequences:** No code depends on the old ID (none written yet). Barat must confirm `openai/gpt-oss-20b` is live at wire-up. General rule reinforced: **all model IDs come from `.env`, never hardcoded**, so future deprecations are a one-line config change. Set a reminder before 2026-08-16 if anything still points at the old model.

## ADR-005 · Currency conversion is NOT an LLM task
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** #10 needs accurate FX rates.
**Decision:** Use an FX rate API (Frankfurter / exchangerate.host — final choice in §10) with a daily cache; the LLM only detects the source currency (already in OCR). Store `amount_original`, `currency_original`, `fx_rate`, and converted `amount`/`currency`.
**Consequences:** Deterministic, auditable conversions; no hallucinated rates.
