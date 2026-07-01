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

## ADR-008 · Two-tier PR review (fast-track vs. mandatory-review)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** The modularization was Owner-merged without a separate cross-review (safe — verbatim, test-covered). To prevent "cross-check later" becoming the default on risky changes, we codify when review is mandatory.
**Decision:** Added SOP §4.7. Tier 1 (refactor/docs/config with passing tests) may be fast-tracked; Tier 2 (money math, untrusted input/OCR/AI-prompt boundary, auth/account-isolation, DB schema/migrations, new deps/integrations) requires an approving non-author review BEFORE merge — the Owner's "just merge it" does not waive it.
**Consequences:** Trivial changes stay fast; the genuinely dangerous surfaces (currency #10, OCR #4/#7, auth, schema) always get a second set of eyes before hitting `main`.

## ADR-006 · CLASSIFY_MODEL = openai/gpt-oss-20b (llama-3.1-8b-instant deprecated)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** Groq emailed a deprecation notice: `llama-3.1-8b-instant` is deprecated as of 2026-06/07 and **decommissioned 2026-08-16** (free + developer-tier; enterprise committed-spend unaffected). Groq's recommended replacement is **GPT OSS 20B** (`openai/gpt-oss-20b`).
**Decision:** Switch the cheap-classify/narrate slot (#6 categorization, report narration) to `openai/gpt-oss-20b`. Updated `.env.example`, `ARCHITECTURE.md` §3.5, `PROJECT_BRIEF.md` §4.
**Consequences:** No code depends on the old ID (none written yet). Barat must confirm `openai/gpt-oss-20b` is live at wire-up. General rule reinforced: **all model IDs come from `.env`, never hardcoded**, so future deprecations are a one-line config change. Set a reminder before 2026-08-16 if anything still points at the old model.

## ADR-007 · VISION_MODEL = qwen/qwen3.6-27b for BOTH slots (maverick dead; scout alive but Preview-only)
**Date:** 2026-07-01 · **Status:** Accepted · **Author:** Barat (verified at wire-up per BARAT.md §1)
**Context:** Barat verified every model ID against the **live account** on 2026-07-01 — both the
`GET /v1/models` list AND real `chat/completions` round-trips with a base64 image (not just docs):

| Model | Live test | Status |
|---|---|---|
| `meta-llama/llama-4-maverick-17b-128e-instruct` | **absent from `/models`** | ❌ decommissioned — do not use anywhere |
| `meta-llama/llama-4-scout-17b-16e-instruct` | base64 image → **HTTP 200**, answered "Red." | ⚠️ ALIVE but **Preview-only** ("should not be used in production; may be discontinued at short notice") |
| `qwen/qwen3.6-27b` | base64 image → **HTTP 200**, analyzed image | ✅ **Production** vision (27B; images + tool use + JSON; 131K ctx; ≤5 img/req). Verbatim id confirmed from the 200 request body. |
| `llama-3.3-70b-versatile` | chat → HTTP 200 | ✅ Production |
| `openai/gpt-oss-20b` | chat → HTTP 200 | ✅ Production (ADR-006) |

Note: qwen runs a `<think>` reasoning pass; a 50-token cap was fully consumed by reasoning. OCR must
use a generous `max_tokens` or disable thinking. (scout replied tersely with no think pass.)

**Decision:** Set **both** `VISION_MODEL` and `VISION_MODEL_HEAVY` = `qwen/qwen3.6-27b`. Rationale:
maverick is dead, and the only alternative (scout) is Preview-only — putting a Preview model in the
production path violates the SOP stability/security baseline (§1.4, §7). With one production vision
model, "escalation" = same model with higher `max_tokens`/more context (multi-receipt/PDF page), not
a model swap. The `visionEscalate` interface stays intact so no consumer code changes when a real
heavy vision model later lands.
**Owner action:** ✅ **Confirmed by Owner 2026-07-01.** Override available: if you accept Preview risk,
set `VISION_MODEL_HEAVY=meta-llama/llama-4-scout-17b-16e-instruct` now (it has a larger ctx window for
hard pages); otherwise promote scout only when Groq graduates it to Production. Either way, log in WORKLOG.
**Consequences:** All routing is env-driven (ADR-006 rule), so swaps are one-line config changes.
⚠️ Follow-up: `lib/config.js` (created by the modularization) still defaults `visionEscalate` to the dead
maverick id — env overrides it so nothing breaks at runtime, but Barat fixes that default in the
post-merge infra PR so the dead id is gone from the codebase entirely.

## ADR-005 · Currency conversion is NOT an LLM task
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** #10 needs accurate FX rates.
**Decision:** Use an FX rate API (Frankfurter / exchangerate.host — final choice in §10) with a daily cache; the LLM only detects the source currency (already in OCR). Store `amount_original`, `currency_original`, `fx_rate`, and converted `amount`/`currency`.
**Consequences:** Deterministic, auditable conversions; no hallucinated rates.
