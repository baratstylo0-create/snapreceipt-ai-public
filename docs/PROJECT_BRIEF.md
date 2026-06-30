# PROJECT BRIEF — Receipt Analyser SaaS
### (Filled Friction Kickoff Plan — the frozen intake. SOP §1.2: no feature code until this is signed off.)

> This is the single source of truth for scope. If a request conflicts with this, STOP and ask the Repo Owner.
> Source of authority order: **Repo Owner → FRICTION_PROJECT_SOP.md → this Brief → repo CLAUDE.md → defaults.**

---

## STATUS
- **Filled by:** Claude (acting Friction CTO) for Jeevan
- **Date submitted:** 2026-07-01
- **CTO review status:** ✅ Approved (GO) — Jeevan, 2026-07-01 (verbal "go for it"). Cost cap §10 set provisionally; adjust anytime.

---

## SECTION 1 — Project Overview

| Field | Answer |
|---|---|
| **Project name** | Receipt Analyser SaaS |
| **One-sentence pitch** | A SaaS that reads any receipt/invoice (photo or PDF), extracts exactly the fields each customer defines via an imported CSV template, and auto-organises them into a live dashboard + Excel export — with AI anomaly detection, currency conversion, and a dashboard assistant. |
| **Client / internal product?** | Internal product (SaaS we own and sell) |
| **Track** | ☑ Vertical AI solution (Groq vision OCR + LLM is the core capability) |
| **Regulated data?** | No formal regime for personal v1, BUT financial PII is present (merchant, amounts, possibly card last-4). Standard security baseline **plus** masking + retention (see §4, §7). Revisit GDPR/PCI scoping before the business/multi-customer launch. |
| **Repo Owner (primary merger)** | Jeevan (GitHub: Jeevan1811) |
| **Deputy (backup merger)** | Barat |

---

## SECTION 2 — Problem & Users

- **Problem:** Individuals and businesses waste hours manually typing receipts into spreadsheets, lose receipts, miscategorise spend, and can't trust the numbers. Generic tools force *their* schema on you.
- **Who it's for:** v1 persona — an individual / sole operator who photographs receipts and wants them auto-logged into **their own** spreadsheet format. (Business persona — admin + collaborators — comes after personal architecture is proven; owned by Mugi's structure.)
- **Pain today:** manual data entry, inconsistent categories, no anomaly/fraud check, no easy multi-currency totals, rigid output that doesn't match how they actually track expenses.
- **Top 3 user journeys:**
  1. Customer imports a CSV template (their column layout) → sends a receipt photo on Telegram → bot extracts exactly those fields → row appears on the live dashboard and in their Excel export.
  2. Customer uploads a single photo containing several receipts (or a PDF) on the dashboard → each receipt is split out, parsed, and logged separately.
  3. Customer asks the dashboard assistant "how much did I spend on food last month?" → gets an answer + a report (day/week/month/year), with any suspicious receipts flagged for review.

---

## SECTION 3 — MVP Scope (Milestone 1 = Personal version)

**Must-have for MVP (the 12 features, personal version):**
- #1 Extract data from receipts — images **and PDFs**
- #2 Save/organise expenses in **Excel** (matching the customer's template)
- #3 Live expense data on HTML dashboard
- #4 AI/LLM receipt parsing (Groq vision)
- #5 AI anomaly detection (flag suspicious/invalid receipts)
- #6 Line-item categorization
- #7 Mass upload (multiple receipts from one photo)
- #8 Expense reports (day / week / month / year)
- #9 Dashboard AI agent bot
- #10 Automatic overseas → local currency conversion
- #11 Low-confidence OCR alerts (flag fields for manual review, never silently guess)
- #12 **Custom Field Template** — customer imports a CSV template that defines what to extract and how to save it (foundational; drives #1/#2/#4)

**Explicitly NOT in MVP (anti scope-creep):**
- Business-account structure (admin/roles/collaborators) — that's the M2 layer; Mugi builds the structure in parallel, we integrate the proven personal features into it afterward.
- Payment/billing, subscriptions, plan tiers.
- Mobile native app, OCR redaction-before-send (deferred), real-time webhooks to 3rd-party accounting tools.
- Multi-language UI.

**Success metric:** On a test set of clear receipts, ≥90% field-level extraction accuracy for the customer's templated fields; every low-confidence field is flagged (zero silent wrong guesses on flagged fields); a customer can go template-import → receipt → correct Excel row with no manual typing.

---

## SECTION 4 — AI-Specific (Vertical AI track)

| Field | Answer |
|---|---|
| **What the AI does** | (a) Vision OCR extraction of receipts, **driven by the customer's field template**; (b) line-item categorization; (c) anomaly/fraud flagging; (d) per-field confidence + low-confidence alerts; (e) dashboard assistant (chat + tools over expense data). Currency conversion is **not** AI — it's an FX API. |
| **Input sources & data quality** | Customer-supplied receipt images (phone photos — variable lighting/blur), PDFs, and multi-receipt photos. Treated as hostile/untrusted input. |
| **Required accuracy / acceptable error rate** | Target ≥90% field-level on clear receipts. Below the confidence threshold → **flag, don't guess** (§ feature #11). Anomaly detection optimises for recall (better to over-flag for human review). |
| **3+ golden eval examples** | 1) Clear café receipt → `{merchant:"Starbucks", date:"2026-06-12", total:14.50, currency:"USD", category:"Food"}`. 2) Blurry total line → total field returned with `confidence:"low"` and surfaced for review (NOT a guessed number). 3) Photo with 2 receipts → 2 separate expense rows, each with its own merchant/total. (Eval suite expands at P8; these are the seed cases.) |
| **What happens when model is unsure (fallback)** | Per-field confidence; low-confidence fields flagged in the dashboard review queue; user edits/confirms (human-in-the-loop). Never auto-save a guessed critical field silently. |
| **Human-in-the-loop checkpoints** | Dashboard edit endpoint (exists), low-confidence review queue (#11), anomaly review queue (#5). |
| **PII / sensitive data handling** | Groq is **inference-only (does not train on API data — Barat confirms current terms at wire-up)**. We: never write receipt images or PII to logs; mask card last-4 in stored output; set a retention policy for raw images / `ai_raw`; auth on every endpoint. (Owner sign-off: masking + retention — DECISIONS.md ADR-002.) |
| **Model(s) to use** | Tiered routing (cheap default, escalate on low-confidence/complexity) — see ARCHITECTURE.md "Model routing". Vision default `llama-4-scout-17b-16e-instruct`; escalate `llama-4-maverick-17b-128e-instruct`; text/agent `llama-3.3-70b-versatile`; cheap classify `openai/gpt-oss-20b` (replaces the deprecated `llama-3.1-8b-instant`, decommission 2026-08-16 — see DECISIONS ADR-006). Barat verifies live IDs on console.groq.com at wire-up. |
| **Monthly AI cost budget (hard cap)** | **Provisional: US$50/mo for dev** (start on Groq free tier, alert at 80%). Set by Jeevan 2026-07-01; adjust anytime. |

---

## SECTION 5 — Tech Stack (LOCKED — Claudes cannot change without Owner approval)

| Layer | Choice | Notes / version |
|---|---|---|
| **Frontend** | Vanilla JS + HTML (`public/index.html`), no framework, no build | Keep zero-build; Mugi owns |
| **Backend / API** | Node 20+ (running v22) + Express, modularised into `lib/` + `routes/` | Was single-file; modularising is the first task |
| **Database** | Supabase (PostgreSQL) via REST, service-role key server-side only | Browser never touches Supabase directly |
| **Auth & permissions** | v1: per-endpoint token gate (`DASHBOARD_TOKEN`) + Supabase RLS (anon denied). Multi-tenant JWT-scoped RLS comes with the business layer | |
| **Hosting / cloud** | TBD at P9 (Owner) — must support a long-running Node process + HTTPS public URL for Telegram webhook | §10 |
| **CI/CD** | GitHub + local `.githooks/pre-push`; GitHub Actions for lint/test at P2+ | |
| **Key third-party services** | Telegram Bot API (input), Groq (vision OCR + LLM), Supabase (DB), FX rate API (e.g. Frankfurter/exchangerate.host) for #10 | |
| **Forbidden (libs/patterns/vendors)** | No `axios`/`node-fetch`/`multer` (use Node 20 native `fetch`/`Buffer`/`hreq()`); no new heavy deps without Owner approval; no SQL string-concat; no secrets in git; no Supabase key in the browser | |

---

## SECTION 6 — System Design Sketch
> Expanded in `docs/ARCHITECTURE.md` at P1.

**Components:**
```
Input:  Telegram bot  ─┐
        Dashboard upload┘─▶  routes/  ─▶  lib/templates (field spec per account)
                                         lib/ocr  ─uses─▶ lib/groq (model routing)
                                         lib/massupload, lib/confidence, lib/currency,
                                         lib/categorize, lib/anomaly  ─▶ lib/supabase
        Dashboard (public/index.html) ──fetch──▶ /api/* (server holds service key)
                                         lib/reports, lib/agent, lib/excel  ─▶ /api/*
```
**Data model (entities):** `accounts (1) ──< expenses` ; `accounts (1) ──< field_templates (the customer CSV schema)`. Expense carries: account_id, merchant, date(TEXT), amount, currency, category, subtotal, tax, line_items(jsonb), confidence(jsonb), anomaly flags, receipt_file_id, ai_raw, status, deleted_at.
**External integrations:** Telegram, Groq, Supabase, FX API.
**Scaling:** Launch ~1–10 users / low volume. 6 months: multi-tenant business accounts, hundreds of users — design account-scoped from day one.

---

## SECTION 7 — Threat Model

| Field | Answer |
|---|---|
| **Sensitive data** | Receipt images, merchant/amount/financial data, possibly card last-4; Telegram chat IDs; service-role DB key; Groq/Telegram tokens |
| **Likely attackers / abuse** | Anyone hitting the public webhook/API; a user trying to read another account's expenses; prompt-injection via crafted receipt text; spam/cost-drain on the Groq endpoint |
| **Where untrusted input enters** | Telegram webhook, dashboard upload, CSV template import, all `/api/*` inputs, **and the model's own output** (treated as untrusted) |
| **Top risk #1 + prevention** | **Cross-account data access** → every query scoped by `account_id`; RLS on; multi-tenant JWT-scoped RLS before business launch |
| **Top risk #2 + prevention** | **Prompt injection via receipt content / template fields** → isolate user content from system instructions; never execute model output; allow-list categories & field names; human-in-the-loop for anything destructive |
| **Top risk #3 + prevention** | **Secret / PII leakage** → `.env` git-ignored (verified); no images/PII in logs; mask card last-4; retention policy; errors never leak internals; webhook secret + auth on every endpoint; rate-limit auth/write/AI endpoints (P6) |

---

## SECTION 8 — Team & Claude Assignment

### The team
| Person | Role | Claude instances | Branch prefix |
|---|---|---|---|
| Jeevan | Repo Owner / CTO | Claude-J1 (active), Claude-J2 (backup/handoff) | `feature/jeevan-...` |
| Barat | Deputy | Claude-B1, Claude-B2 | `feature/barat-...` |
| Mugi | Worker | Claude-M1 | `feature/mugi-...` |

### Module Ownership Map (no overlapping owners)
| Module / Area | Owner | File(s) | Notes |
|---|---|---|---|
| Project setup & CI/CD (P2) | Jeevan | `.githooks/`, CI | Owner does repo + protection |
| DB schema & migrations (P3) | Barat | `schema.sql`, `lib/supabase.js` | Infra |
| Auth & permissions (P3) | Jeevan | `routes/` gate, RLS | Owner |
| Groq connection + model routing | Barat | `lib/groq.js` | Infra — frozen interface |
| Custom Field Template #12 | Barat | `lib/templates.js` | **Shared contract — frozen at P1** |
| OCR core #4 + PDF #1 | Barat | `lib/ocr.js` | Vision |
| Low-confidence alerts #11 | Barat | `lib/confidence.js` | Coupled to OCR pass |
| Line-item categorization #6 | Jeevan | `lib/categorize.js` | Consumes parsed data |
| Anomaly detection #5 | Jeevan | `lib/anomaly.js` | Consumes parsed data |
| Reports #8 | Jeevan | `lib/reports.js`, `routes/reports.js` | Aggregation |
| Dashboard agent #9 | Jeevan | `lib/agent.js`, `routes/agent.js` | Uses frozen groq.js |
| Excel export #2 | Jeevan | `lib/excel.js` | Reads field-template spec |
| Currency conversion #10 | Jeevan | `lib/currency.js` | FX API + cache (standalone) |
| Mass upload #7 | Jeevan | `lib/massupload.js`, `routes/upload.js` | Uses frozen groq.js (contract only) |
| Frontend #3 + Business structure | Mugi | `public/index.html` | Dashboard + admin/collaborators layer (M2) |
| Observability / logs (P7) | Jeevan | shared | No PII in logs |
| Tests & evals (P8) | Owner-coordinated | `tests/` | Each owner tests their module |
| Deploy & runbook (P9) | Jeevan | `docs/RUNBOOK.md` | Owner |

### Within-person Claude split
| Person | Claude-1 handles | Claude-2 handles |
|---|---|---|
| Jeevan | Active feature work (one branch at a time) | Backup/handoff — picks up from `docs/HANDOFF.md` when session limit hit |
| Barat | Infra (groq.js, supabase.js, schema) | OCR cluster (ocr.js, templates.js, confidence.js) |
| Mugi | Dashboard + business structure (only 1 Claude) | — |

---

## SECTION 9 — Milestones & Timeline

| Milestone | Description | Phases | Target |
|---|---|---|---|
| M1 — MVP (Personal) | 12 features on personal/single-account architecture | P0 → P9 | Week(s) TBD by Owner |
| M2 — Business layer | Integrate proven features into Mugi's admin/collaborator structure (multi-tenant) | P3→P6 re-applied | After M1 |
| M3 — Ship | Deploy, runbook, scaling, security review | P9 | After M2 |

---

## SECTION 10 — Open Questions / Deferred (only place "TBD" is allowed)

| Question | Owner | Resolve by |
|---|---|---|
| Monthly AI cost hard cap ($) | Jeevan | Before P3.5 (AI pipeline) |
| Hosting provider (P9) | Jeevan | Before P9 |
| FX rate API choice (Frankfurter vs exchangerate.host vs paid) | Jeevan/Barat | Before #10 starts |
| PDF rasterisation approach (Groq-native vs a converter dep) | Barat | Before #1 starts |
| Timeline / sprint length | Jeevan | At first sprint plan |

---

## CTO VALIDATION

| # | Check | Pass/Fail | Note |
|---|---|---|---|
| 1 | Brief complete — no empty fields outside §10 | ✅ | Only §10 TBDs |
| 2 | Track chosen; AI checklist filled | ✅ | Vertical AI |
| 3 | Stack locked | ✅ | §5 |
| 4 | Ownership map — no overlaps | ✅ | One owner per file |
| 5 | Owner + Deputy named | ✅ | Jeevan / Barat |
| 6 | Threat model specific | ✅ | 3 concrete risks |
| 7 | MVP scope realistic | ✅ | Personal first, business deferred |
| 8 | AI eval examples concrete | ✅ | 3 seed cases |
| 9 | No compliance gap | ⚠️ | Financial PII handled via masking+retention; revisit GDPR/PCI pre-business |
| 10 | Team Claude split sensible | ✅ | Coupling-based, collision-safe |

### Decision
- **GO** ✅ — Jeevan (Founder / CTO), 2026-07-01. Proceed to P1. First task: modularization (ADR-001).
- **NO-GO** ❌ — n/a
