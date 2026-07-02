# DECISIONS — Receipt Analyser SaaS (ADR-lite)
> Why we chose X. Append as decisions are made.

## ADR-015 · Supabase custody: personal free tier (pre-incorporation), bounded by backup + disclosure + rotation — not a privacy breach, not yet "company infra"
**Date:** 2026-07-02 · **Status:** Accepted (Owner: Jeevan)
**Context:** The product's only database is a Supabase project on Barat's personal account, free tier. There is no registered company entity, no company domain/email, and therefore nothing exists yet to legally "own" a company Supabase org — this is normal for a pre-incorporation MVP, not a gap unique to this project. The real question raised (Owner + Claude discussion, 2026-07-02) was whether this constitutes a data-privacy risk, and if so, what actually mitigates it — as opposed to what merely *sounds* like it does.
**Analysis (corrected from an earlier overstated framing this session):**
- **This is NOT a privacy/security breach.** A breach means unauthorized access occurred; nothing here does that. The actual privacy controls — encryption in transit/at rest (Supabase default), RLS, service-role-key-only backend access (`lib/supabase.js`), the browser never touching Supabase directly (CLAUDE.md/ARCHITECTURE §1) — are already in place and are independent of whose email owns the account.
- **Adding a second Owner (Jeevan) to the Supabase project does NOT make it "the company's" infrastructure.** It mitigates exactly one thing: single-person lockout (Barat loses access / is unreachable / leaves). It does not change legal ownership, does not satisfy ToS-as-a-business concerns, and should not be represented as more than a bus-factor fix.
- **The two risks actually being carried are:** (1) bus-factor/continuity — one person's account/credentials are a single point of failure for data availability; (2) no legal entity yet — nothing is "the company's" in a strict sense, which is the normal, accepted state of a pre-incorporation MVP, not a violation to fix urgently.
**Decision — bound and disclose the risk rather than claim to eliminate it (which isn't possible pre-incorporation):**
1. **Independent backup** — Jeevan holds a `pg_dump` (or equivalent export) outside Supabase entirely, refreshed periodically. This is the actual data-loss insurance — it protects against Supabase itself suspending/pausing/purging the project, which multi-owner access does not.
2. **Multi-owner access** — Barat adds Jeevan as a second Owner on the Supabase project (free, ~5 min). Fixes the lockout scenario specifically; claimed for nothing more.
3. **User disclosure** — any real user (including early beta/friends) is told plainly this runs on early-stage developer infrastructure, not yet a registered company. This is what converts an undisclosed risk into an informed, accepted one — the disclosure is the actual control, not the account type.
4. **Key-rotation launch gate (hard blocker, tracked in `docs/STATUS.md` Blockers):** no real user is onboarded until every secret (Supabase service-role key, Groq key, bot token, `DASHBOARD_TOKEN`) has been rotated *after* its last dev-context exposure (shared, committed, pasted, screen-shared) — production must run on secrets that have only ever touched the host — **and** an independent backup (item 1) exists. Fail either → cannot launch.
5. **Tier ladder (Owner-set, recorded here so it isn't re-litigated):** stay on free/personal until ~5 real users or capacity pressure → upgrade to Supabase Pro, billed to/via Barat's account, Owner reimburses, treated informally as the company account → migrate to a company-owned org once a domain/company email exists (re-apply `schema.sql`, migrate data, rotate keys again per item 4).
**Consequences:** No architecture or code change. This ADR exists so the custody arrangement is an explicit, on-the-record decision rather than an implicit assumption — if a dispute or incident ever occurs, there is a clear record that the arrangement was deliberate, bounded, and had backup/disclosure/rotation controls, not negligence. Re-visit this ADR (supersede or close) once the company Supabase org migration (tier-ladder step 5) actually happens.

## ADR-014 · PDF ingestion (#1) rasterizes via `@hyzyla/pdfium` (WASM PDFium) — not MuPDF, not a system binary
**Date:** 2026-07-02 · **Status:** Accepted (Owner: Jeevan) — **LOCKED: spike PASSED (J1, in-session 2026-07-02); fallback not needed**
**Context:** #1 accepts PDFs (digital + scanned, untrusted) on both surfaces. Groq vision reads **images, not PDFs** (ADR-007: qwen is image-only), so a PDF must be **rasterized to page images**, which then feed the existing #7 `runBatch` spine unchanged (page images == `runBatch`'s `images[]`; multi-page and multi-receipt-per-page fall out for free). The only real decision is *how* to rasterize under the project's hard constraints: **no build step, minimal deps, pure Node 22, commercial SaaS (license matters), hostile input.** Options weighed:

| Approach | License | Build step | Deps | Notes |
|---|---|---|---|---|
| **A. `@hyzyla/pdfium`** (WASM PDFium) | **MIT wrapper / BSD-Apache core** ✅ | none (WASM) | **1**, zero-dep | Chrome's PDF engine; renders native+scanned; WASM sandbox |
| B. `mupdf` (official, WASM) | **AGPL or paid commercial** ⚠️ | none (WASM) | 1 | highest fidelity, but AGPL network-service copyleft ⇒ must open-source or buy a license |
| C. `pdf.js` + `@napi-rs/canvas` | Apache-2.0 + MIT ✅ | none (prebuilt) | **2** (one native `.node`) | permissive but platform-specific native binary; JS renderer (slower) |
| D. system binary (poppler/ghostscript) | — | **host install** ❌ | 0 npm | fragile Windows↔Linux, deploy burden, shell-out on hostile input |

**Decision:** Use **A — `@hyzyla/pdfium`**. Rationale: (1) **License is clean for a product we sell** — permissive, no copyleft; **B is disqualified** while a permissive equal exists (AGPL would obligate source release or an Artifex commercial license for our SaaS). (2) **Best fit for "no build / pure Node"** — pure WASM, no native compile, byte-identical on Windows dev and the eventual Linux host; C's `@napi-rs/canvas` works but pulls a platform-specific native binary (the thing most likely to break a deploy). (3) **One zero-dependency package** vs C's two; the WASM blob vendors in, so bus-factor risk sits on a thin JS wrapper, not the renderer (the renderer is the same C++ core shipped in Chrome). (4) **WASM sandbox** (memory-isolated, no shell) is a genuine security win on hostile PDFs — the reason D was rejected. New dep on an **untrusted-input parsing surface** ⇒ **Tier-2** (SOP §4.7, ADR-012 precedent): its own ADR (this) + independent QA before merge.
**Pre-commit check (honest risk):** confirmed from the live API — `@hyzyla/pdfium` is **ESM** (this repo is **CommonJS**), so `lib/pdf.js` loads it via dynamic `import()`; and `page.render()` yields **raw RGBA** (`{data,width,height,channels:4}`), not PNG — the vendor example encodes with **`sharp`**, a heavy native dep we **reject** (it would negate the zero-added-native-deps rationale above). Instead we pass a custom `render` fn that encodes RGBA → **PNG via Node's built-in `node:zlib`** (~40-line in-module helper, no dependency). **Spike result (J1, in-session 2026-07-02):** all of this PASSED on generated native PDFs — dynamic `import()` from CJS works; `PDFiumLibrary.init()` + `page.render({scale, render})` returns `{data,width,height}` RGBA; the `zlib` encoder produced a **legible** PNG (a 300×200pt page at `scale=150/72` → 625×416px, ~9.7 KB); multi-page (3pp) worked; `loadDocument` on non-PDF bytes throws `"File not in PDF format or corrupted"`; init+render ~94ms; `npm install @hyzyla/pdfium` = **"added 1 package"** (zero-dep confirmed). **Fallback = C** (`pdf.js` + `@napi-rs/canvas`) is therefore **not needed** — retained only as a documented contingency. Remaining open item for Barat: confirm the exact error string for a *password-protected* PDF (needs a `qpdf`-generated fixture) so `ENCRYPTED` maps distinctly from `CORRUPT`.
**Consequences:** **Exactly one** dependency added to `package.json` — the WASM `@hyzyla/pdfium` (lands with `lib/pdf.js`, Barat's lane); PNG encoding stays in Node core (`zlib`), no `sharp`. All render knobs env-driven (`PDF_RENDER_DPI`, `PDF_MAX_BYTES`; page cap reuses `MASS_MAX_IMAGES`), so tuning is config not code. Design: `docs/specs/2026-07-02-pdf-ingestion-design.md`; plan: `docs/plans/2026-07-02-pdf-ingestion.md`. Precedent (ADR-012/013) reaffirmed: a new dep gets justify-then-ADR-then-Tier-2-review.

## ADR-013 · `jszip` promoted to an explicit dependency for chart-preserving business Excel
**Date:** 2026-07-02 · **Status:** Accepted in principle (Owner: Jeevan) — *package.json promotion deferred until business Excel Phase 1 builds (business phase currently PARKED, personal M1 first)*
**Context:** The business Excel deliverable is a 9-sheet template with 6 charts + 10 drawings + 2783 formula cells. Barat's Task-1 spike proved `exceljs` load→save **drops all charts/drawings** (formulas survive), so the #2 exceljs-fill approach is unsuitable for the business workbook. The validated alternative is targeted **jszip XML-injection**: inject Master Log data rows (inline strings + numeric `<v>`) into `sheet1.xml` and leave every other zip part byte-preserved → all charts, drawings, and formulas survive and the file stays valid (POC confirmed).
**Decision:** Approve promoting **`jszip`** (already vendored transitively via `exceljs`, so **zero added install weight**) to an *explicit* dependency when the business Excel work lands. Recorded now so the dependency decision isn't re-litigated later; the actual `package.json` entry is added by the business-Excel Phase-1 PR (not now — business is parked, and we don't add an unused explicit dep). New-dep policy (SOP §4.7 / ADR-012 precedent) still applies: the Phase-1 PR is Tier-2 (untrusted-output XML surface + a promoted dep) → independent QA before merge.
**Consequences:** Business workbook can be filled without losing its charts/formulas; no new vendor risk (jszip is already in the tree). Precedent reaffirmed: even a zero-weight promotion of an existing transitive dep gets a recorded decision.

## ADR-012 · Excel export (#2) adds `exceljs` — first exception to the "two deps only" rule
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** CLAUDE.md/ARCHITECTURE §1 keep runtime deps to `express`+`dotenv` only. #2's acceptance criterion is a real `.xlsx` file whose columns match the customer's FieldSpec — a genuine binary OOXML workbook (correct cell types, real Excel metadata) can't be produced with string concatenation, and hand-rolling an XLSX/zip writer is a worse trade (more custom code, more subtle-spec-bug surface, no real security benefit) for a money-facing export.
**Decision:** Add `exceljs` (pure JS, no native bindings, MIT license) as the first approved exception to the minimal-deps rule. New third-party dependency → **Tier-2** per SOP §4.7: independent QA review required before merge, same bar as the money-math/untrusted-input work already landed this session.
**Consequences:** One more dependency to keep patched; in exchange, customers get a real Excel file (correct numeric cells for sums, proper headers) instead of a CSV wearing an `.xlsx` extension. Precedent set: future deps need the same justify-then-ADR-then-Tier-2-review treatment, not a blanket ban.

## ADR-011 · Build a reference frontend prototype before Mugi's production UI/UX
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** All progress so far is backend/infra; the live dashboard (`public/index.html`) is unchanged from day one and surfaces none of the new features (categorization, anomaly review queue, reports, currency, template import). Handing Mugi a spec alone risks a UI that misses functions/flows.
**Decision:** Once the core backend features are merged, Jeevan builds a **rough, functional reference frontend** that surfaces every feature's buttons, functions, and displays (template import, category pills, low-confidence flags, the anomaly review queue with approve/reject, reports view, multi-currency totals, Excel export). It is a *design brief in code* — not the final UI. **Mugi** then designs the production UI/UX (#3) from it. Built after the backend lands, not before (avoids churn).
**Consequences:** Mugi designs from a concrete, working reference instead of prose; the reference doubles as an integration smoke-test of the whole `/api/*` surface.

## ADR-010 · One codebase + capability flags (personal-first), not a personal/business fork
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** M1 was labelled "personal version," but the highest-value features (tax recovery, bank
reconciliation, admin approve/reject, personal-vs-business flagging) are business features, and a
single *person* can be both — e.g. a solopreneur who tracks personal spend AND wants to claim tax on
a side business. Duplicating the code into a separate "business app" would force that user to
re-onboard and lose history, and would create two 80%-identical codebases that drift.
**Decision:** **One codebase.** Model the account as a set of **capability flags** (default = personal,
all off), not a hard `personal|business` binary. Capabilities: `businessProfile` (business-context
categorization), `claimsTax` (reclaimable VAT/GST surfaced), `bankReconciliation` (receipt↔statement
matching), `multiUser` (roles → admin review queue). Personal = all off (simple). Solopreneur = flip
`businessProfile`+`claimsTax`. Full company = also `multiUser`. The only genuinely *new structure* for
business is orgs/users/roles — an additive layer on top of the shared core, NOT a reason to fork
OCR/categorize/reports. Single source of truth = `lib/account.js` (`getCapabilities()`), env-driven
for single-account v1, swappable to a per-account Supabase settings row later without changing callers.
**Consequences:** Personal ships first (business layers simply off); business is an upgrade-in-place,
never a rewrite. Feature code stays shared; capability checks gate business-only behaviour. First
consumer: #5's personal-vs-business detector is gated on `businessProfile` (off for personal accounts).
`docs/ARCHITECTURE.md` module map to note `lib/account.js` when next edited.

## ADR-009 · QA & Debug agents are standard practice (SOP §4.8)
**Date:** 2026-07-01 · **Status:** Accepted (Owner: Jeevan)
**Context:** The independent Tier-2 review of #10 currency found real (minor) edge-case gaps — evidence that a dedicated adversarial pass catches what the author's own tests miss. Owner asked to make this standard for all Claudes.
**Decision:** Added SOP §4.8 + playbooks `docs/roles/QA.md` and `docs/roles/DEBUG.md`. QA agent (adversarial, on Tier-2 + AI eval gate) must output **committed tests + eval cases**, not throwaway reports. Debug agent follows systematic-debugging, driven by a failing repro. The loop: QA breaks it → writes failing test → Debug fixes → test stays green. Right-sized to Tier-2/AI; skip for trivial changes. On-demand roles, not standing processes.
**Consequences:** Durable hardening of money/auth/untrusted-input/AI surfaces; QA feeds the P8 eval gate. No new tooling — uses ephemeral subagents + node:test.

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
✅ Follow-up (done, PR #5): `lib/config.js` `MODEL_ROUTES` vision fallbacks no longer reference dead/preview ids — both `visionDefault` and `visionEscalate` default to `qwen/qwen3.6-27b`.

## ADR-005 · Currency conversion is NOT an LLM task
**Date:** 2026-07-01 · **Status:** Accepted
**Context:** #10 needs accurate FX rates.
**Decision:** Use an FX rate API (Frankfurter / exchangerate.host — final choice in §10) with a daily cache; the LLM only detects the source currency (already in OCR). Store `amount_original`, `currency_original`, `fx_rate`, and converted `amount`/`currency`.
**Consequences:** Deterministic, auditable conversions; no hallucinated rates.
