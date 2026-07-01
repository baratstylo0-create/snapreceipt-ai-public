# WORKLOG — Receipt Analyser SaaS
> Append-only ledger of every push. **A push that isn't logged here did not happen** (SOP §4.3, §7).
> Format: date · who (Claude/human) · branch · files touched · what changed · what's next · new assumptions.

---

## 2026-07-01 · Claude-J2 (for Jeevan) · feature/jeevan-p4-categorize (PR #6)
- **Files:** created `lib/categoryMemory.js`, `db/2026-07-01-category_corrections.sql`, `tests/categorize.engine.test.js`, `tests/categoryMemory.test.js`, `docs/specs/2026-07-01-categorize-design.md`; extended `lib/categorize.js`; hooked the learning loop into `routes/expenses.js` (PATCH).
- **What changed:** #6 line-item categorization — **LLM-supervised, learning categorizer** (design approved by Owner; SparkReceipt-benchmarked). Cascade per item: **MEMORY** (learned corrections) → **RULES** (keyword engine, expanded to an ~18-category chart of accounts) → base; then an **LLM WATCHDOG** (one batched Groq `classify` call/receipt) confirms / overrides (only when confident ≥0.75) / flags. LLM is caged: output **clamped to the allow-list** (can't invent a category), receipt text passed as **untrusted DATA** (anti-injection, SOP §7.2). Human corrections are ground truth — the LLM never overrides them, only flags. Learning loop live via `PATCH /api/expenses/:id` → `recordCorrection` (best-effort). New `category_corrections` table (Barat applies) — code **degrades gracefully** if absent. Legacy `normaliseExpenseCategory` (5-bucket; used by ocr.js + dashboard colours) left **UNCHANGED**. **Tests: 50/50** (22 new).
- **What's next:**
  1. Tier-2 + QA review of PR #6.
  2. **Barat:** apply `db/2026-07-01-category_corrections.sql` in Supabase + fold into `schema.sql`; wire `categorizeLineItems(receipt, fieldSpec)` into `lib/ocr.js` where it currently calls `normaliseExpenseCategory` (his file — cross-team handoff).
  3. **Mugi (later):** expand dashboard category pills/colours from the legacy 5 to the new chart.
  4. **Jeevan:** #5 anomaly next (duplicates + personal-expense **admin accept/reject queue**) — reuses the `flagged` field this PR introduces.
- **Assumptions:** single-account v1 (memory scoped via `cfg.ACCOUNT_ID`); per-account custom taxonomy accepted via `opts.categories` now, FieldSpec-sourced once Barat adds a category list to `templates.js` (shared-contract change → WORKLOG first).

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p3-templates (PR #9 review response)
- **Files:** `lib/templates.js`, `tests/templates.test.js`.
- **What changed:** Addressed Jeevan's Tier-2 review of PR #9 (APPROVE + 1 important + 4 minor):
  1. **Important** (account_id not actually enforced by `saveTemplate`): confirmed `sbInsert`/`sbUpdate` (lib/supabase.js) always scope writes to `cfg.ACCOUNT_ID`, so a non-default `account_id` passed to `saveTemplate` would write under the default account. Harmless in single-account v1. Checked blast radius before deciding — `sbInsert`/`sbUpdate`/`sbSelect` are already used by `lib/bot.js`, `lib/ocr.js`, `routes/expenses.js`, so changing their scoping post-approval was the riskier path. Went with the reviewer's lighter option: documented the limitation with a comment on `saveTemplate`, to be fixed in `lib/supabase.js` if/when multi-tenant lands (flagged as a shared-contract change requiring WORKLOG announcement first).
  2. **Minor — shape-guard:** added `isValidColumn()` in `getFieldSpec`; a stored row's `columns` are now filtered to well-formed entries before use, falling back to `DEFAULT_COLUMNS` if none survive (defense-in-depth, SOP §7.2).
  3. **Minor — splitCsvLine limit:** documented explicitly in a comment (quoted header with an embedded newline won't parse; acceptable since header rows are pre-split on `\r?\n`).
  4. **Minor — mocked fallback test:** added 2 new hermetic tests (`getFieldSpec` empty-row and malformed-row → `DEFAULT_COLUMNS`) plus 1 for the shape-guard partial-filter case, using the same `global.fetch` stub pattern as `tests/currency.test.js` — no network call, CI stays hermetic.
  5. **Product Q answered** (not a bug): `parseTemplate` intentionally doesn't require `amount`/`expense_date` to be present in the CSV — the customer's own sheet defines the schema; `required: true` on those canonical keys only takes effect when the header is present. This is by design (ADR-003).
  - **Tests: 28/28 pass** (25 + 3 new).
- **What's next:** push; Jeevan merges PR #9 → unblocks `lib/ocr.js` (#4/#1/#11) for Barat and Excel (#2) for Jeevan.
- **Assumptions:** none new beyond the account_id limitation above (already noted in code).

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p3-templates
- **Files:** created `lib/templates.js` (#12 FieldSpec engine) + `tests/templates.test.js`. Doc cleanups: `docs/DECISIONS.md` (ADR-007 follow-up → resolved), `docs/WORKLOG.md` (scrubbed key-prefix mention), `docs/STATUS.md`.
- **What changed:**
  - **`lib/templates.js` — the #12 FieldSpec engine (SHARED CONTRACT, ARCHITECTURE §3.1).** Exports:
    - `parseTemplate(csvText) -> columns` — maps CSV headers → canonical keys (merchant/expense_date/amount/currency/category/subtotal/tax/remark/quantity) with types + required flags; unknown headers kept verbatim as `type:"text"` with a safe snake_case key; dedupes by key (first wins). Handles quoted fields, escaped quotes, UTF-8 BOM, blank/trailing cols. Input guards (SOP §7.2): rejects non-string/empty, caps at 100 cols / 128-char labels.
    - `getFieldSpec(account_id) -> FieldSpec` — reads the account's stored template (latest by `updated_at`), falls back to `DEFAULT_COLUMNS` if none.
    - `saveTemplate(csv|columns, {account_id,name}) -> FieldSpec` — parse + upsert into `field_templates` via the account-scoped `sbSelect/sbInsert/sbUpdate` helpers.
    - **Frozen signature** — Jeevan's Excel (#2) + OCR (#4) + dashboard depend on it; any change goes through WORKLOG first.
  - **Tests: 17/17 pass** (9 new for parseTemplate + contract; DB paths kept out of CI to stay hermetic).
  - **Live round-trip verified** against real Supabase `field_templates`: getFieldSpec (empty→DEFAULT) → saveTemplate(CSV) → getFieldSpec (reflects stored) → hard-delete cleanup → confirmed 0 rows. ✅
  - **Two PR#5 review cleanups** (as requested): trimmed the now-resolved ADR-007 `lib/config.js` maverick follow-up; removed the `sb_secret_` key-prefix mention from the WORKLOG.
- **What's next:**
  1. Open PR (Tier-2 — shared contract per SOP §4.7 → Jeevan reviews before merge). `gh` not installed here; PR opened via GitHub UI.
  2. After merge → `lib/ocr.js` (#4/#1/#11): drive extraction from the FieldSpec; give the qwen vision call a generous `max_tokens` (qwen `<think>` gotcha, ADR-007).
- **Assumptions:** single-account v1 — `saveTemplate`/`getFieldSpec` scope via `cfg.ACCOUNT_ID`; multi-account persistence needs `supabase.js` to accept an explicit `account_id` (deferred, forward-compatible).

## 2026-07-01 · Claude-J1 (for Jeevan) · feature/jeevan-p4-currency
- **Files:** created `lib/currency.js` (#10) + `tests/currency.test.js`.
- **What changed:** Currency conversion feature (TDD). `convertCurrency(amount, from, to?, date?)` → converts a foreign amount to the account's local currency using live FX rates (Frankfurter/ECB by default, `FX_API_URL`), caches rates (`FX_CACHE_HOURS`), uses the receipt's-date historical rate when given. **Fails safe** — invalid currency or provider-down returns `{ok:false}` and keeps the original amount (never guesses a rate, never throws). Not an LLM task (ADR-005). Tier-2 review (independent) = APPROVE; 2 minor findings fixed (FX_CACHE_HOURS=0 honored; fail-safe amount rounded) + edge tests → **16/16**.
- **What's next:** merge; Barat wires `convertCurrency` into `lib/ocr.js` at ingestion (snippet in PR).
- **Assumptions:** Frankfurter (free, ECB, daily) is the v1 rate source (Owner-approved); zero-decimal currencies (JPY) kept at 2dp for v1 (known limitation).

## 2026-07-01 · Claude-J1 (for Jeevan) · chore/jeevan-sop-qa-debug
- **Files:** `docs/FRICTION_PROJECT_SOP.md` (§4.8), `docs/roles/QA.md`, `docs/roles/DEBUG.md`, `docs/DECISIONS.md` (ADR-009).
- **What changed:** Codified QA + Debug agents as standard practice (SOP §4.8 + two playbooks). QA = adversarial tester whose output is committed tests + eval cases; Debug = systematic fixer driven by a failing repro; the QA→Debug loop hardens Tier-2 + AI surfaces. Right-sized (skip trivial).
- **What's next:** first live QA target = the #10 currency PR (already partially done by the Tier-2 review). Tier-1 (docs/process) → Owner may fast-track merge.
- **Assumptions:** none new.

## 2026-07-01 · Claude-J1 (for Jeevan) · feature/jeevan-p2-modularize-server
- **Files:** created `lib/{money,categorize,http,config,groq,supabase,telegram,ocr,bot}.js`, `routes/{webhook,expenses,receipt,misc}.js`, `tests/{money,categorize,http,smoke}.test.js`; slimmed `server.js` 311→31 lines (wiring only); added `test` script + ran `npm install`.
- **What changed:** Executed ADR-001 modularization (plan `docs/plans/2026-07-01-modularize-server.md`). Behaviour-preserving — all logic moved out of single-file server.js into focused modules behind the frozen interfaces (ARCHITECTURE §3). No new runtime deps. **Tests: 8/8 pass** (6 unit + 2 smoke). `node server.js` boots, `/health` OK. Note: cluster-2 subagent stalled after `telegram.js`; controller finished `ocr.js`/`bot.js` + cluster 3 inline.
- **What's next:** open PR → Barat reviews → **Jeevan merges** → unblocks Barat's `lib/` infra work and all feature branches off the modularized base.
- **Assumptions:** `node_modules` is git-ignored (installed locally per machine). Vision model routing still pending Barat's confirmation (scout alive? maverick gone — ADR-007).

## 2026-07-01 · Claude-J1 (for Jeevan) · setup (pre-branch)
- **Files:** repo created at `C:\Users\Asus\Downloads\receipt-analyser-saas` (copied from `Downloads\receipt-saas`); `git init` on `main`; scaffolded `lib/ routes/ docs/ docs/roles docs/templates docs/specs templates/ .githooks/`; added `.githooks/pre-push`, `setup-git-hooks.ps1`; wrote `docs/FRICTION_PROJECT_SOP.md`, `docs/PROJECT_BRIEF.md`, `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `docs/WORKLOG.md`, `docs/DECISIONS.md`, `docs/HANDOFF.md`, `docs/roles/{JEEVAN,BARAT,MUGI}.md`, updated root `CLAUDE.md`, `MEMORY_LEDGER.md`.
- **What changed:** P0 kickoff. Brief filled, track = Vertical AI, 12 features scoped, ownership split locked (coupling-based; #7 + #10 moved from Barat to Jeevan), Groq data posture = masking + retention.
- **What's next:** Jeevan signs GO → create GitHub remote + add collaborators → first feature branch = modularization (`feature/jeevan-p2-modularize-server`).
- **Assumptions:** repo lives at the path above (NOT `Gold_Bot`, which is an unrelated trading bot the SOP folder was mistakenly dropped into). Groq is inference-only (Barat to confirm at wire-up).

## 2026-07-01 · Claude-J1 (for Jeevan) · main (bootstrap)
- **Files:** repo published to GitHub.
- **What changed:** Jeevan signed **GO** on PROJECT_BRIEF (verbal). Created private repo `Jeevan1811/receipt-analyser-saas`; pushed `main` + `develop`. Provisional AI cost cap set ($50/mo dev).
- **⚠️ Override logged (SOP §4.5):** initial `main` + `develop` pushes used `git push --no-verify` — legitimate one-time bootstrap (no PR path exists until the remote does). From the modularization branch onward, NO direct pushes to main/develop; all via PR.
- **What's next:** add Barat + Mugi as collaborators (need their GitHub usernames); open `feature/jeevan-p2-modularize-server`.
- **Assumptions:** none new.

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
  - `.env` filled: BOT_TOKEN, GROQ_KEY, SB_URL, SB_KEY (service-role secret). Owner provided.
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
  - Owner decision: inviting Jeevan as a Supabase project member is NOT needed (owner runs Supabase solo; optional later for backup access).
- **BRANCH SYNC + lib/config.js FIX (2026-07-01):**
  - Discovered this branch had forked from the kickoff commit `6230988` — stale, before the modularization (PRs #1–#4) landed on `main`. Merged `origin/main` in (no rebase → no force-push, per SOP §4.4).
  - Resolved 3 doc conflicts (read both sides, per SOP §4.4): `STATUS.md` (reconciled to current reality), `DECISIONS.md` (removed main's ADR-007 *stub*; kept my finalized ADR-007), `WORKLOG.md` (kept both ledgers). Merge commit made; **all 8 tests pass** post-merge.
  - **Fixed `lib/config.js`** (queued ADR-007 follow-up, now unblocked): `MODEL_ROUTES.visionDefault` and `visionEscalate` fallbacks were `llama-4-scout` (Preview-only) and `llama-4-maverick` (dead) → both now default to `qwen/qwen3.6-27b`. `.env` still overrides; this removes the dead id from the codebase.
- **What's next:**
  1. Push the synced branch; refresh/open the PR (Tier-2 per SOP §4.7 — schema/migration → needs non-author review before merge).
  2. Owner (Jeevan) reviews + merges; Barat does not self-merge.
  3. Then begin OCR-coupled feature work off the modularized base (ARCHITECTURE §3 frozen interfaces).
- **Assumptions:** Groq inference-only posture (ADR-002) still to be reconfirmed against current Groq terms.

<!-- New entries ABOVE this line, newest first. Template:
## YYYY-MM-DD · Claude-?? (for Name) · feature/<branch>
- Files:
- What changed:
- What's next:
- Assumptions:
-->
