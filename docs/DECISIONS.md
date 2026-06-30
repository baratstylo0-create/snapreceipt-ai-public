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

## ADR-007 · VISION_MODEL = qwen/qwen3.6-27b (llama-4-scout is Preview-only; llama-4-maverick not listed)
**Date:** 2026-07-01 · **Status:** Accepted · **Author:** Barat (verified at wire-up per BARAT.md §1)
**Context:** Barat verified all model IDs against `console.groq.com/docs/models` on 2026-07-01.
Findings:
- `meta-llama/llama-4-scout-17b-16e-instruct` — **Preview only**; docs say "intended for evaluation purposes only and should not be used in production; may be discontinued at short notice."
- `meta-llama/llama-4-maverick-17b-128e-instruct` — **Not listed** anywhere in the current model docs. Likely not available or not yet GA on Groq.
- `qwen/qwen3.6-27b` — **Production** vision model; 27B params; supports images, tool use, JSON mode, 131K ctx, up to 5 images/req.
- `llama-3.3-70b-versatile` ✅ Production. `openai/gpt-oss-20b` ✅ Production (ADR-006 confirmed).
**Decision:** Switch `VISION_MODEL` and `VISION_MODEL_HEAVY` to `qwen/qwen3.6-27b`. Updated `.env.example` and `ARCHITECTURE.md §3.5`. Since there is currently no heavier production vision model, both slots use the same model; escalation means higher `max_tokens` / retry with more context.
**Owner action required:** Jeevan to confirm this substitution is acceptable. If a production llama-4-maverick equivalent ships on Groq, update `VISION_MODEL_HEAVY` and log in WORKLOG.
**Consequences:** Code using `VISION_MODEL`/`VISION_MODEL_HEAVY` env vars requires no change (ADR-006 general rule: IDs always from `.env`). Reassess when Groq graduates llama-4-scout or releases a production-grade heavy vision model.

## ADR-005 · Currency conversion is NOT an LLM task
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** #10 needs accurate FX rates.
**Decision:** Use an FX rate API (Frankfurter / exchangerate.host — final choice in §10) with a daily cache; the LLM only detects the source currency (already in OCR). Store `amount_original`, `currency_original`, `fx_rate`, and converted `amount`/`currency`.
**Consequences:** Deterministic, auditable conversions; no hallucinated rates.
