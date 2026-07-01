# WORKLOG — Receipt Analyser SaaS
> Append-only ledger of every push. **A push that isn't logged here did not happen** (SOP §4.3, §7).
> Format: date · who (Claude/human) · branch · files touched · what changed · what's next · new assumptions.

---

## 2026-07-01 · Claude-J1 (for Jeevan) · setup (pre-branch)
- **Files:** repo created at `C:\Users\Asus\Downloads\receipt-analyser-saas` (copied from `Downloads\receipt-saas`); `git init` on `main`; scaffolded `lib/ routes/ docs/ docs/roles docs/templates docs/specs templates/ .githooks/`; added `.githooks/pre-push`, `setup-git-hooks.ps1`; wrote `docs/FRICTION_PROJECT_SOP.md`, `docs/PROJECT_BRIEF.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `docs/WORKLOG.md`, `docs/DECISIONS.md`, `docs/HANDOFF.md`, `docs/roles/{JEEVAN,BARAT,MUGI}.md`, updated root `CLAUDE.md`, `MEMORY_LEDGER.md`.
- **What changed:** P0 kickoff. Brief filled, track = Vertical AI, 12 features scoped, ownership split locked (coupling-based; #7 + #10 moved from Barat to Jeevan), Groq data posture = masking + retention.
- **What's next:** Jeevan signs GO → create GitHub remote + add collaborators → first feature branch = modularization (`feature/jeevan-p2-modularize-server`).
- **Assumptions:** repo lives at the path above (NOT `Gold_Bot`, which is an unrelated trading bot the SOP folder was mistakenly dropped into). Groq is inference-only (Barat to confirm at wire-up).

## 2026-07-01 · Claude-J1 (for Jeevan) · setup (pre-branch)
- **Files:** `.env.example`, `docs/ARCHITECTURE.md`, `docs/PROJECT_BRIEF.md`, `docs/DECISIONS.md`.
- **What changed:** Groq deprecation handled (ADR-006) — `CLASSIFY_MODEL` switched from `llama-3.1-8b-instant` (decommission 2026-08-16) to `openai/gpt-oss-20b`. Reinforced rule: model IDs always from `.env`.
- **What's next:** commit scaffolding, create GitHub remote + push, queue modularization plan.
- **Assumptions:** `openai/gpt-oss-20b` is live on Groq (Barat confirms at wire-up).

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p3-infra-schema
- **Files:** `schema.sql`, `.env.example`, `docs/ARCHITECTURE.md` (§3.5), `docs/DECISIONS.md` (ADR-007)
- **What changed:**
  - **Schema migration written** (not yet applied — needs Jeevan to confirm then run in Supabase SQL editor):
    - New table `field_templates` (account_id, name, columns jsonb, timestamps) with unique index + RLS enabled.
    - New columns on `expenses`: `confidence jsonb`, `anomaly jsonb`, `currency_original text`, `amount_original numeric`, `fx_rate numeric`, `template_id uuid FK→field_templates`.
    - All `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — fully idempotent.
  - **Groq model IDs verified live** against console.groq.com/docs/models (2026-07-01):
    - `llama-4-scout-17b` → Preview-only (docs say "not for production; may be discontinued without notice"). Replaced with production model.
    - `llama-4-maverick-17b` → Not listed at all on Groq.
    - `qwen/qwen3.6-27b` → Production vision model. Set as both VISION_MODEL and VISION_MODEL_HEAVY.
    - `llama-3.3-70b-versatile` ✅ Production. `openai/gpt-oss-20b` ✅ Production (ADR-006 confirmed).
  - **ADR-007 written** in DECISIONS.md.
  - **`.env.example` and ARCHITECTURE.md §3.5 updated** with verified IDs.
  - **`.env` created locally** (git-ignored, never committed) with blanks ready to fill.
  - Setup: ran `setup-git-hooks.ps1` (hooks active, main/develop push blocked).
- **WIRE-UP VERIFICATION (2026-07-01, live, with real keys):**
  - `.env` filled: BOT_TOKEN, GROQ_KEY, SB_URL (https://xurnpvesgcybrnilxszf.supabase.co), SB_KEY (sb_secret_…). Owner provided.
  - **Supabase REST**: service key authenticates ✅ (GET /rest/v1/expenses → 404 PGRST205 "table not found" = auth OK, schema not yet applied).
  - **Groq /models live list confirms ADR-007**: `qwen/qwen3.6-27b` ✅ present; `llama-3.3-70b-versatile` ✅; `openai/gpt-oss-20b` ✅; **`llama-4-maverick` CONFIRMED ABSENT**; `llama-4-scout` present but Preview-only.
  - **Groq chat round-trips** (HTTP 200): llama-3.3-70b-versatile ✅, openai/gpt-oss-20b ✅.
  - **Groq vision round-trip** (HTTP 200): qwen/qwen3.6-27b accepted an inline base64 PNG and analyzed it ✅ — OCR vision pathway proven.
  - Bonus: `openai/gpt-oss-safeguard-20b` + `meta-llama/llama-prompt-guard-2-*` available on the account → candidates for prompt-injection defense at P6.
  - ADR-007 marked Owner-confirmed.
- **VISION ROUTING FINALISED (2026-07-01):**
  - Direct base64-image test of the OLD default `meta-llama/llama-4-scout-17b-16e-instruct` → **HTTP 200, alive** ("Red.") — but Groq docs keep it **Preview-only** ("not for production").
  - Exact qwen id reconfirmed verbatim from the 200 request body: **`qwen/qwen3.6-27b`** (also in `/models`).
  - **Final routing:** `VISION_MODEL` = `VISION_MODEL_HEAVY` = `qwen/qwen3.6-27b` (only production vision model; escalate = same model + higher max_tokens, not a swap). Scout kept out of prod path; promote only if it graduates. Updated `.env.example`, `ARCHITECTURE.md §3.5`, `DECISIONS ADR-007` together.
  - qwen `<think>` note: OCR needs generous max_tokens or thinking disabled.
  - **FOLLOW-UP (post-merge infra PR):** `lib/config.js` (from modularization) still defaults `visionEscalate` to the dead maverick id. Env overrides it (no runtime break) but Barat removes the dead default once the modularization PR is merged and lib/* editing is unblocked.
- **SCHEMA APPLIED + VERIFIED (2026-07-01):**
  - Owner signed into Supabase; Barat ran the full `schema.sql` in the SQL Editor (project `xurnpvesgcybrnilxszf`, "RECEIPT ANALYZER" org) → **"Success. No rows returned"** (no destructive-query prompt; idempotent DDL).
  - REST verification with service key: `expenses` exposes all 6 new columns (confidence, anomaly, currency_original, amount_original, fx_rate, template_id) → HTTP 200; `field_templates` table → HTTP 200.
  - **Insert→read→delete round-trip** (account_id `__wireup_test__`): POST 201 with new cols populated → GET 200 correct values → DELETE 200 → table confirmed clean. Supabase pipeline proven end-to-end.
  - P3 data-foundation gate: schema migrated ✅, RLS enabled (service-role bypass by design, anon denied) ✅, no secrets in repo ✅.
  - Remaining owner-only item: invite Jeevan as Supabase project member (access-control change Barat can't perform).
- **What's next:**
  1. **Barat needs credentials from Jeevan**: `BOT_TOKEN`, `GROQ_KEY`, `SB_URL`, `SB_KEY` to fill `.env`.
  2. **Owner action**: Jeevan to confirm ADR-007 (qwen vision model substitution).
  3. Once `.env` is filled → apply schema.sql in Supabase SQL Editor → verify with `/health`.
  4. Wait for modularization PR (`feature/jeevan-p2-modularize-server`) to merge before starting `lib/groq.js`, `lib/supabase.js`, etc.
- **Assumptions:** Groq is inference-only (no training on API data) — reconfirmed needed once GROQ_KEY is in hand and terms confirmed; will note in DECISIONS ADR-002 update.

<!-- New entries ABOVE this line, newest first. Template:
## YYYY-MM-DD · Claude-?? (for Name) · feature/<branch>
- Files:
- What changed:
- What's next:
- Assumptions:
-->
