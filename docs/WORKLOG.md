# WORKLOG — Receipt Analyser SaaS
> Append-only ledger of every push. **A push that isn't logged here did not happen** (SOP §4.3, §7).
> Format: date · who (Claude/human) · branch · files touched · what changed · what's next · new assumptions.

---

## 2026-07-02 · Claude-J1 (for Jeevan) · feature/jeevan-p4-massupload (#7 mass upload — IN PROGRESS, handoff to J2)
- **Files:** `docs/specs/2026-07-02-mass-upload-design.md`, `docs/plans/2026-07-02-mass-upload.md`, `lib/massupload.js` + `tests/massupload.test.js` (Task 1 of 3).
- **What changed (mid-build — brainstorm → spec → plan → subagent-driven TDD, mirroring #9):**
  - **Brainstormed #7 with the Owner.** Decisions: entry surface = **BOTH** dashboard (now, my lane) + Telegram multi-photo (later, Barat's lane) → so the orchestrator is transport-agnostic and shared. Failure model = **best-effort + summary** (one bad photo never blocks the rest). Limits = **conservative + sequential** (~10 images/batch, one Groq call at a time).
  - **Spec + plan written & committed.** ORCHESTRATION ONLY — I do NOT build vision/OCR (Barat's lane).
  - **Task 1 DONE (commit `5fb57a6`):** `lib/massupload.js` `runBatch(images, fieldSpec, { extractReceipts, assembleExpense, meta, extractOpts }) -> { images, receipts, saved, failed, flagged, truncated_images }`. Best-effort, **never throws** (every image + receipt try/caught). DI so it's fully unit-tested with fakes (no network/DB). **Tests: 5/5 new; full suite 195/195.** ⚠️ **NOT yet reviewed** — the two-stage spec + code-quality review still owes running before Task 2.
- **Verified cross-lane contract (Barat, `feature/barat-p4-mass-ocr`):** `extractReceipts(image, fieldSpec, {maxReceipts?}) -> { receipts:[{fields,rawParsed}], truncated }` (already implemented + exported on his branch). `assembleExpense({chatId,repName,fileId,fields,rawParsed,fieldSpec}) -> {expense,flagged}`.
- **What's next (J2):** review Task 1 (spec + code-quality) → Task 2 `routes/upload.js` (POST /api/upload, checkDash, base64→Buffer, ≤10 → 413, **503 dark-path** until Barat's extractReceipts merges) → Task 3 docs/env → final independent Tier-2 QA → PR. Separately: **open + independently QA Barat's `feature/barat-p4-mass-ocr`** (focus: extractReceipt untouched, array-parse + unterminated-`<think>` rejection + extra-key stripping, stripThink behaviour-preserving, and `assembleExpense` tolerates `fileId:null`).
- **Assumptions:** `lib/massupload.js`/`routes/upload.js` are Jeevan's files; `extractReceipts`/`assembleExpense`/`getFieldSpec` consumed read-only (Barat's). Telegram multi-photo wiring is a Barat-lane follow-up reusing `runBatch`.

## 2026-07-02 · Claude-J1 (for Jeevan) · chore/jeevan-j1-housekeeping
- **Files:** `tests/groq.test.js` (cherry-picked +2 QA tests), `docs/DECISIONS.md` (ADR-013), `docs/HANDOFF.md` (top block refresh), `docs/STATUS.md`, this WORKLOG entry.
- **What changed:** Session-open housekeeping after picking up a stale-context handoff (re-synced from ground truth: #9 + #26 were already merged by a prior session; my old in-context memory was behind).
  1. **QA'd + merged PR #26** (Barat's additive `groqChatTools()` in `lib/groq.js`) — fresh independent Tier-2 subagent, verdict **APPROVE clean**: `groqChat`/`groqVision` byte-unchanged (ocr/bot/categorize unaffected), 429 backoff intact (exactly 4 attempts), returns the full assistant message incl. `tool_calls`, degrades safely on malformed shapes, no secret leakage. Merged (`cbfae82`). **#9's live tool-calling path is no longer dark.** QA's 2 adversarial regression tests (safe-degradation + 429-exhaustion) **cherry-picked here** rather than pushed to Barat's branch (SOP §4.4 — don't push to a teammate's branch); they're additive hardening, no defect was found. `main` = 190; this branch = **192**.
  2. **Closed PR #24** (my earlier docs refresh) — it went `CONFLICTING` once #9's PR #25 merged and advanced the same docs (same pattern as the superseded PR #23). Its substantive history (the #22 exceljs-`node_modules` GOTCHA) is preserved in STATUS + HANDOFF, so no append-only work record is lost.
  3. **Refreshed the badly-stale HANDOFF top block** (was still "Claude-J2 / main = PR #19 / 150 passing") and STATUS to current reality.
  4. **ADR-013:** recorded Owner-approved decision to promote `jszip` to an explicit dep for chart-preserving business Excel (zero added weight — already transitive via exceljs); package.json promotion deferred to the business-Excel Phase-1 PR since **the business phase is PARKED** (Owner: personal M1 first).
- **What's next:** #7 mass upload — `lib/massupload.js` + `routes/upload.js`, ORCHESTRATION ONLY over Barat's `extractReceipts()` (deps-injected/defensive; open + QA his `feature/barat-p4-mass-ocr`). Then #1 PDF (joint brainstorm), then ADR-011 reference frontend.
- **Assumptions:** none new. Owner decisions this session: business phase parked; jszip approved (ADR-013).

## 2026-07-02 · Claude-B1/B2 (for Barat) · feature/barat-p4-groq-tools
- **Files:** `lib/groq.js` (additive), `tests/groq.test.js` (new).
- **What changed:** Added `groqChatTools(messages, { model?, max_tokens?, temperature?, tools?, tool_choice? })` to `lib/groq.js` — the cross-lane dependency #9's `routes/agent.js` was calling defensively (dark until this landed, per `docs/plans/2026-07-01-dashboard-agent.md`). Implemented exactly to the "Cross-lane dependency" spec in that plan / `docs/ARCHITECTURE.md` §3.2: forwards `tools`/`tool_choice` into the request body when provided, returns the **full assistant message** (`{ role, content, tool_calls? }`, not just `.content`), same exponential-backoff-on-429 pattern as `groqChat`. Purely additive — `groqChat`/`groqVision` untouched (ocr/bot/categorize unaffected), confirmed by full suite still green.
  - **Tests: 190/190 pass** (4 new: forwards `tools`/`tool_choice` + returns full message on a text reply; returns `tool_calls` when the model emits them; 429-shaped error body retries then succeeds; omits `tools`/`tool_choice` from the request body when not passed — same hermetic `global.fetch` stub pattern as `tests/ocr.test.js`).
  - Confirmed `routes/agent.js`'s `require('../lib/groq').groqChatTools` now resolves to a real function (was `undefined` before this PR) — #9's live path is no longer dark.
- **What's next:** push branch, tell Jeevan/J1 (no `gh` auth) — Tier-1-ish per J1 (additive Groq wrapper, no untrusted-input/money surface) so should move fast. Then Barat's own remaining item: #1 PDF ingestion (his call on timing).
- **Assumptions:** none new; implementation matches the plan doc's reference snippet verbatim (no design decisions of my own).

## 2026-07-01 · Claude-J1/J2 (for Jeevan) · feature/jeevan-p4-agent (#9 dashboard agent, Phase 1)
- **Files:** created `lib/agent.js`, `routes/agent.js`, `tests/agent.test.js`, `tests/agent.route.test.js`, `docs/specs/2026-07-01-dashboard-agent-design.md`, `docs/specs/2026-07-01-dashboard-agent.md` (plan); modified `server.js`, `tests/smoke.test.js`, `.env.example`, `docs/ARCHITECTURE.md` (§3.2 groqChatTools + new §3.6 agent interface).
- **Final Tier-2 QA (independent subagent, AI prompt boundary):** verdict **APPROVE WITH MINOR FINDINGS**. Prompt-injection risk verified **LOW/mitigated** — tool results are `JSON.stringify`'d into a single `role:'tool'` message so injected text (fake `"role":"system"` strings, "ignore previous instructions") stays inert escaped data and can't splice a new turn; the iteration cap is unconditional (proven: exactly `MAX_ITERATIONS+1` chat calls, forced-final turn returns before executing any tool call). Money integrity (`toAmount` strict coercion), `ai_raw` non-leakage, rejected-row exclusion, `checkDash` auth, transcript caps, safe-502s, and prototype-pollution/`__proto__`/negative-limit arg probes all verified clean. **One Minor fixed inline (J2):** `listExpenses`/`topMerchants` shared the same 10000-row `loadExpenses` cap as `getReport` but didn't surface `truncated`/`fetched_count` — so past the cap the model (told "never invent numbers") could get a silently-partial dataset. Fixed to return `{ items, fetched_count, truncated }` mirroring `getReport`; QA's 2 failing tests strengthened + kept as regressions; updated the existing list/top tests to the new `.items` shape. **Tests: 186/186.** APPROVE + merge.
- **What changed:** #9 dashboard agent, Phase 1 (read-only, write-ready). Owner asked for "full-fledged" — CTO-recommended and Owner-confirmed direction: **constrained tool-calling** (not curated-context) + **stateless multi-turn** (client resends the transcript each request; no server session storage). Built via subagent-driven TDD (fresh implementer per task + separate spec-compliance and code-quality review stages, mirroring #2 Excel's process) across 6 tasks:
  1. **Tool registry + `getReport`** — money-safety review caught a genuine divergence from the project's own bar (`routes/reports.js`): `status=rejected` was excluded only in JS, not at the query level; the row cap was 2000 (not the established 10000); and no `truncated`/`fetched_count` was surfaced. Fixed to match `routes/reports.js` exactly (query-level `status=neq.rejected`, `ROW_FETCH_LIMIT=10000`, truncation surfaced) → re-reviewed → approved.
  2. **`listExpenses`** — filter + projection (never returns `ai_raw` to the model) + limit clamp (500 max). Approved both review stages; one Minor (no multi-row test proving merchant/category filters actually discriminate) deferred to final QA.
  3. **`topMerchants`** — aggregation using the same `toAmount()` strict coercion as #8/#2 (garbage/boolean amounts contribute nothing, never fabricate money). Approved clean.
  4. **`runAgent`** — the bounded native tool-calling loop (Groq `tools`/`tool_calls`, `MAX_ITERATIONS=6` then `tool_choice:'none'` forces a final answer). Code-quality review found a **Critical**: `call.function || {}` sat outside the try block, so a malformed `tool_calls:[null]` from the model/provider threw a raw `TypeError` out of `runAgent` — exactly the crash the loop exists to prevent. Fixed (null-guard + missing-`call.id` handling) + regression tests → re-reviewed → approved.
  5. **`routes/agent.js`** — `POST /api/agent`, `checkDash` auth, transcript caps (20 msgs/12k chars → 413), safe 502s. Approved, but the reviewer flagged cheap worthwhile hardening at the auth boundary (dead `cfg` import, a lazy `require` moved to module scope, a defensive `out.answer || ''` guard, and — notably — **no test anywhere exercised `checkDash` enforcement**). Fixed + added an auth-enforcement test and a content-type/malformed-message-rejection test.
  6. **Docs + env** (this entry): `.env.example` (`AGENT_MODEL`, `AGENT_MAX_TOKENS`), `ARCHITECTURE.md` §3.2 (documented `groqChatTools` as Barat's additive cross-lane function) + new §3.6 (the agent's frozen interface: `TOOLS`/`buildToolSpecs`/`runAgent`).
  - **Cross-lane dependency on Barat (flagged in the PR, does not block this PR):** `lib/groq.js` needs an **additive** `groqChatTools(messages, {..., tools, tool_choice}) -> full assistant message (incl. tool_calls)` — the existing `groqChat` only returns content string and can't carry tool calls. Until Barat adds it, `routes/agent.js`'s `require('../lib/groq').groqChatTools` resolves to `undefined` (no import-time throw; only throws if the live path is actually invoked) — verified deliberately dark, all tests inject a fake `chat` so nothing here depends on it existing yet.
  - **Tests: 184/184 pass** (34 new across the 6 tasks). Security posture (SOP §7.3): the model can only name a tool + args from the fixed allow-list; every arg is server-validated and clamped; it never executes anything; all reads are account-scoped + exclude rejected/soft-deleted rows, inherited from the same `sbSelect`/`buildReport` shapes already hardened in #8/#2/#22.
- **What's next:** open the PR → independent Tier-2 QA (AI prompt boundary + tool-calling security) before merge, same bar as #8/#13/#19/#22. Then #7 mass upload, then the ADR-011 reference frontend for Mugi. When Barat's `groqChatTools` lands, no code change needed here — the route already calls it defensively.
- **Assumptions:** `lib/agent.js`/`routes/agent.js` are Jeevan's own files — no cross-team handoff beyond the flagged Barat dependency above. Phase 1 is read-only by design; a future Phase 2 (agentic write — e.g. approve/reject via chat) is explicitly out of scope for this PR (see spec).

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p4-ingestion
- **Files:** `lib/ocr.js` (ingestion pipeline), `schema.sql` (folded in category_corrections), `tests/ingest.test.js` (new). `lib/bot.js` unchanged (expenseFromPhoto signature preserved).
- **What changed:** Wired #5/#6/#10 into ingestion (ARCHITECTURE §4 data flow). New testable `assembleExpense(input, deps)` runs, before insert:
  - **#10 currency** — `convertCurrency(total, cur, DEFAULT_CURRENCY, date)`; on a real conversion it sets `amount`/`currency` + records `amount_original`/`currency_original`/`fx_rate`, and **scales subtotal/tax by the same rate** so the row stays internally consistent (prevents a false "subtotal+tax≠total" anomaly). Fails safe.
  - **#6 category** — `categorizeLineItems(receipt, fieldSpec)` → stored `category` (chart-of-accounts); falls back to the legacy `normaliseExpenseCategory` if the categorizer throws.
  - **#5 anomaly** — `detectAnomalies(expense, { history })` → stores `expenses.anomaly` (reasons) and sets `status = status_suggestion`. **ADR-010 SECURITY:** opts is built SERVER-SIDE ONLY (`{ history }` from a server-side `sbSelect`); no request/model field is ever spread into it, so a personal account can't be forced into the business personal-spend detector. Folded in the #11 low-confidence signal (a low REQUIRED field also routes to `needs_review`).
  - Each stage degrades gracefully (try/catch) so one failing service never blocks the insert.
  - **schema.sql:** folded in `category_corrections` (from `db/2026-07-01-category_corrections.sql`).
  - **Tests: 101/101 pass** (10 new hermetic ingestion tests incl. the ADR-010 opts-only-`{history}` assertion). **Live integration verified** with the REAL modules: "Shell Petrol Station" €50 → `Fuel & Auto`, converted to $58.04 (rate 1.1607, originals recorded), status `saved` — pipeline works end-to-end.
- **What's next:**
  1. **Run `category_corrections` in Supabase** (folded into schema.sql; idempotent). NON-BLOCKING — #6 degrades gracefully (rules+LLM) until it exists; needed only to persist learned corrections. Barat to apply in the Supabase SQL editor.
  2. Open PR — **Tier-2** (ingestion touches untrusted input + the AI boundary) → non-author review + QA pass before merge.
- **Assumptions:** category taxonomy stored is now the #6 chart-of-accounts (e.g. "Fuel & Auto"), not the legacy 5-bucket set — dashboard pill colours (#3, Mugi) may need updating; flagged for cross-team. Line items aren't a default FieldSpec column, so categorization currently keys off merchant (+ line_items when a template provides them).
## 2026-07-01 · Claude-J2 (for Jeevan) · feature/jeevan-p4-excel (PR — #2 Excel export)
- **Files:** created `lib/excel.js`, `routes/excel.js`, `tests/excel.test.js`, `tests/excel.route.test.js`, `docs/specs/2026-07-01-excel-design.md`, `docs/plans/2026-07-01-excel-export.md`; modified `lib/reports.js` (widened exports), `tests/reports.test.js`, `server.js`, `tests/smoke.test.js`, `package.json`/`package-lock.json` (exceljs), `docs/DECISIONS.md` (ADR-012).
- **What changed:** #2 Excel export, built via subagent-driven TDD (fresh implementer per task + spec-compliance & code-quality review after each). `GET /api/excel?from=&to=` streams a real `.xlsx` whose columns exactly match the account's FieldSpec (label + order, ARCHITECTURE §3.1). Canonical fields (merchant/expense_date/amount/currency/category/subtotal/tax/remark) read straight off the expense row; any other FieldSpec key (the canonical-but-columnless `quantity`, or a customer's own custom CSV header) reads from `ai_raw`. Reuses #8's hardened `toAmount()` (rejects booleans/arrays/Infinity — never fabricates money) and `isISO()` (rejects impossible calendar dates) rather than re-implementing them; excludes `status='rejected'` and soft-deleted rows, same rule as reports. Truncation (row cap hit) signaled via an `X-Truncated` response header since the body is binary. Rows built **positionally** (not a key-object) so duplicate FieldSpec keys can't silently drop a column's value. CORS header set before the try so 502 errors carry it (matches reports.js). New dependency **`exceljs`** (ADR-012) — first exception to the "two deps only" rule. **Tests: 150/150 pass** (23 new: 1 reports export-widening, 14 on `lib/excel.js`, 8 on `routes/excel.js`).
- **Code-review fixes folded in:** duplicate-FieldSpec-key data loss → positional rows + regression test (code-quality Important); missing CORS header on the 502 path → moved before try + pinned (code-quality Important); +`amount:0` and array-query-param regression tests.
- **What's next:** Tier-2 review (new third-party dependency + money export, SOP §4.7) → fresh non-author QA subagent before merge, same bar as #8/#13. Then #9 dashboard agent, then #7 mass upload, then the ADR-011 reference frontend for Mugi.
- **Assumptions:** `lib/excel.js`/`routes/excel.js` are Jeevan's own files (`docs/roles/JEEVAN.md`) — no cross-team handoff. `getFieldSpec()`/`sbSelect()` consumed read-only (Barat's frozen contracts, unchanged). A non-canonical FieldSpec key is rendered from `ai_raw` (the OCR-extracted object) — consistent with the #4/#12 convention already logged.

## 2026-07-01 · Claude-J2 (for Jeevan) · feature/jeevan-p4-reports (PR #8 QA re-review)
- **Files:** `lib/reports.js`, `routes/reports.js`, `tests/reports.test.js`, `tests/reports.route.test.js`.
- **What changed:** Dispatched a fresh non-author QA subagent to re-review PR #8 (Tier-2, sums money) since the prior round's fixes (truncation, strict date validation) were pushed but never re-reviewed. Verified those fixes correctly (isISO rejects impossible calendar dates, ISO-week bucketing correct at 3 real year-boundary cases, `from`/`to` range filtering inclusive + injection-safe, no stack-trace leak on DB error, account scoping enforced centrally in `sbSelect`). Fresh adversarial pass found **2 Important, real, verified bugs** in `lib/reports.js`'s `Number(e.amount) || 0` coercion: (1) non-numeric garbage (`true`, `[5]`) silently became fake money ($1, $5) instead of being excluded; (2) `Infinity` poisoned the running total/bucket total for the *entire report*. Fixed with a strict `toAmount()` helper (accepts only a real finite number or a numeric string; anything else → record excluded entirely, not counted toward `count` either). Also folded in the queued **`status=neq.rejected` exclusion** (routes/reports.js) — a rejected expense from #5's admin review queue isn't soft-deleted, so it must be excluded from money totals at the query level (`expenses.status` is `not null default 'saved'`, so `neq.rejected` can't silently drop legitimate NULL-status rows). **Tests: 127/127 pass** (4 new QA regression tests + 1 new status-filter test). **APPROVE + MERGED PR #8.**
- **What's next:** Barat's ingestion-wiring PR (remind: `detectAnomalies` opts server-side only, ADR-010) → Jeevan #2 Excel / #9 agent / #7 mass upload.
- **Assumptions:** `lib/reports.js`/`routes/reports.js` are Jeevan's own files (docs/roles/JEEVAN.md) — no cross-team handoff needed for these fixes.

## 2026-07-01 · Claude-J1 (for Jeevan) · feature/jeevan-p4-reports
- **Files:** created `lib/reports.js` (#8) + `tests/reports.test.js` + `routes/reports.js`; mounted in `server.js`; added new modules to `tests/smoke.test.js`.
- **What changed:** Expense reports (#8). Pure `buildReport(expenses, period, {from,to})` buckets by day/week/month/year with per-category breakdown + totals (ISO-8601 week keys, year-boundary correct). `GET /api/reports?period=&from=&to=` fetches account-scoped rows via `supabase.js` and aggregates. Sums the stored `amount` (already local-currency-normalized by #10). **Tests 26/26** (10 new, incl. adversarial: empty, deleted, bad dates, ISO-week year boundary, range filter). Boot check: `/api/reports` fails safe (502 JSON, no crash) with no DB.
- **What's next:** open PR (Tier-2 — sums money → non-author review + QA pass per SOP §4.7/§4.8). Then Mugi renders reports on the dashboard (#3).
- **Assumptions:** report totals assume `amount` is in the account currency (true once #10 conversion is wired into ingestion by Barat).

## 2026-07-01 · Claude-J2 (for Jeevan) · feature/barat-p4-templates-route (PR #13 QA fix)
- **Files:** `server.js`, `routes/templates.js`, `tests/templates_route.test.js`.
- **What changed:** Dispatched a fresh non-author QA subagent for PR #13 (Tier-2, untrusted CSV over HTTP). Verdict: **CHANGES REQUESTED (1 Critical)**. `express.json()`/`express.text()` throw synchronously on malformed JSON or an unsupported charset, before the route's own try/catch runs → Express's default handler leaked a full stack trace + absolute server file paths to the client (SOP §7.2). Fixed with a route-local 4-arg error-handling middleware appended to the `POST /api/templates` chain (self-contained — works under the route's own standalone test harness and under the real `server.js`), plus a matching app-level `app.use((err,...))` global handler in `server.js` as defense-in-depth for future routes. QA's 5 adversarial tests kept as permanent regression tests (2 Critical-documenting, now green; 3 characterization tests for XSS-label/NUL/invalid-UTF-8 passthrough, documenting known non-blocking behavior). **Tests: 38/38 pass** (33 + 5 QA). Non-blocking Important (stored-XSS supply risk — `label` must be escaped by downstream Excel/dashboard renderers) + Minor (NUL/invalid-UTF-8 not rejected at boundary) tracked as **GitHub issue #17**. **APPROVE + MERGED PR #13.**
- **What's next:** re-review PR #8 (reports) → merge → `status=neq.rejected` fix → Barat's ingestion-wiring PR (remind: `detectAnomalies` opts server-side only, ADR-010) → Jeevan #2/#9/#7.
- **Assumptions:** `routes/templates.js` and `server.js` are not on Barat's protected-file list (only his `lib/{ocr,groq,supabase,templates,confidence}.js` are off-limits), so fixing the route-level/wiring bug inline (rather than handing back to Barat) was in scope for this review.

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p4-templates-route
- **Files:** created `routes/templates.js` + `tests/templates_route.test.js`; wired `mountTemplates(app)` into `server.js`; added `routes/templates` to the `smoke.test.js` import list.
- **What changed:** The **HTTP door for #12** — customers/dashboard can now import a CSV template and read the current one (the `lib/templates.js` engine had no endpoint yet, so `getFieldSpec` always returned DEFAULT).
  - `GET /api/templates` → current FieldSpec (or DEFAULT). `POST /api/templates` → accepts a `text/csv`(or `text/plain`) body OR JSON `{csv, name?}` (also `?name=`), parses + stores via `saveTemplate`, returns the FieldSpec.
  - Reuses the existing `checkDash` dashboard-token gate (from `routes/expenses.js`). Untrusted-input handling (SOP §7.2): 256 kb body cap; invalid/empty CSV → **400** (parseTemplate errors mapped to client errors), real DB failures → 502.
  - **Tests: 33/33 pass** (5 new hermetic route tests — mount on ephemeral port + real fetch like the smoke test, Supabase calls stubbed by URL so the local request still passes through).
  - **Live HTTP round-trip verified** against real Supabase: POST CSV → 200 stored → GET reflects it → test row deleted → 0 rows. ✅
- **What's next:** open PR (Tier-2 — untrusted CSV over HTTP → non-author review). Independent of the OCR PR (different files); both touch `docs/WORKLOG.md`/`STATUS.md` so expect a keep-both merge there.
- **Assumptions:** single-account v1 (writes scope to `cfg.ACCOUNT_ID` via the supabase helpers, per the #12 limitation already logged). `server.js` touched for one mount line (shared wiring file — minimal, announced here per SOP §4.6).

## 2026-07-01 · Claude-J1 (for Jeevan) · chore/jeevan-handoff-update
- **What changed:** Re-reviewed Barat's #12 Critical fix (unterminated `<think>` → `{}` verified, 43/43) → **APPROVE + MERGED PR #12**. Synced his branch to main (kept-both WORKLOG, `--theirs` STATUS). `main` = **91 tests**. #4 OCR + #11 confidence now live → **Barat unblocked for ingestion wiring**. Refreshed HANDOFF/STATUS.
- **What's next (J2):** review #13 → re-review #8 → Jeevan #2/#9/#7. Ping Barat: he's unblocked.
- **Assumptions:** none new.

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p4-ocr (PR #12 review response)
- **Files:** `lib/ocr.js`, `lib/confidence.js`, `tests/ocr.test.js`, `tests/confidence.test.js`.
- **What changed:** Fixed Jeevan's Tier-2 CRITICAL + 2 QA nice-to-adds on PR #12:
  1. **CRITICAL — `parseModelJson` unterminated `<think>`:** the paired-tag strip left an *opened-but-never-closed* `<think>` (qwen truncated mid-reasoning) in place, then brace-scanning grabbed a `{...}`-shaped EXAMPLE from the reasoning text and accepted it as the real extraction. Fix: after stripping paired blocks, if any `<think>` remains, **return `{}`** (unusable) instead of scanning the reasoning (SOP §7.3). Added the exact failing test (`'<think>...a receipt might look like {"merchant":"X","amount":1}...'` → `{}`), plus cut-off-with-no-braces, last-block-truncated, and a sanity closed-think case.
  2. **QA — garbage confidence stays low:** hardened `isPresent` so a malformed object/array value for a text/date/category field scores `low` (never `high` by accident); added a garbage/malformed test.
  3. **QA — getFieldSpec-throws graceful:** already graceful at the call site — `expenseFromPhoto` wraps `getFieldSpec` in its try/catch, so a DB error becomes the safe "couldn't read it" reply. `getFieldSpec` lives in the merged `lib/templates.js` (not this branch's file), so no change made here.
  - **Tests: 43/43 pass** (41 + 2 new). Ready for Jeevan's re-review + merge.
- **What's next:** on merge (+ #5 anomaly), Barat is unblocked for the ingestion wiring in `lib/ocr.js` + `lib/bot.js`.
- **Assumptions:** unchanged.

## 2026-07-01 · Claude-B1 (for Barat) · feature/barat-p4-ocr
- **Files:** rewrote `lib/ocr.js`; created `lib/confidence.js` (#11), `tests/ocr.test.js`, `tests/confidence.test.js`.
- **What changed:**
  - **`lib/ocr.js` — FieldSpec-driven OCR (#4).** New frozen export `extractReceipt(image, fieldSpec, opts) -> { fields, rawParsed, raw }` (ARCHITECTURE §2/§3.1/§4): builds the extraction prompt dynamically from `getFieldSpec(account).columns` so it extracts **only the customer's fields** (no hardcoded schema); coerces each value by declared type (date→ISO, currency/number→Number, category→canonical set, text→capped string).
    - **Security (SOP §7.3):** system prompt separated from the untrusted image; model told to treat image text as data and never obey embedded instructions; **output treated as untrusted** — `<think>` stripped, defensive JSON parse (garbage/array/truncated → `{}`), and **only FieldSpec keys are read** (extra keys the model volunteers are dropped — tested with an `evil_injected` key).
    - **qwen `<think>` (ADR-007):** `OCR_MAX_TOKENS` defaults to 2500 (env-overridable) so reasoning tokens don't truncate the JSON.
    - `expenseFromPhoto` (Telegram entry, unchanged signature so `lib/bot.js` is untouched) refactored to `getFieldSpec → extractReceipt → scoreConfidence → map to expense row`; now stores `confidence` (jsonb) + `anomaly` (when a required field is low) + full extracted object in `ai_raw`, and warns the sender on low confidence.
  - **`lib/confidence.js` — #11.** `scoreConfidence(fieldSpec, rawParsed) -> { perField, low, flagged, reason }`. Never silently guesses: missing/empty (and money `0`) → `low`; a low **required** field sets `flagged` so it's surfaced for review, not hidden.
  - **Tests: 41/41 pass** (13 new; hermetic — `global.fetch` stub for the Groq call, same pattern as currency/templates).
  - **Live end-to-end verified** against real qwen vision with a synthetic receipt + a custom FieldSpec: extracted merchant/date(DD/MM/YYYY→ISO)/total/tax/category all correct, confidence all-high, ~1.5s.
- **What's next:**
  1. This is **Tier-2** (untrusted input / OCR / AI-prompt boundary) → needs a **non-author review + a QA pass** (SOP §4.7/§4.8) before merge. Open PR.
  2. **#1 PDF is NOT done** — `extractReceipt` accepts an image (URL/data-URI) so a rasterised PDF *page* flows through, but PDF→image **rasterisation is not implemented** (open question §10: no build step / native-only deps). A PDF sent to the bot today will not read correctly. Deferred to a follow-up branch with the rasterisation decision.
- **Assumptions:** custom (non-canonical) FieldSpec keys are extracted and stored in `ai_raw` for Excel (#2)/dashboard to render; only canonical keys populate dedicated `expenses` columns in v1.

## 2026-07-01 · Claude-J1 (for Jeevan) · chore/jeevan-session-handoff
- **Files:** `docs/HANDOFF.md` (J1 session-end block), `docs/STATUS.md` (refreshed), `MEMORY_LEDGER.md`, `docs/DECISIONS.md` (ADR-011).
- **What changed (this session's review train):** Merged **PR #10 (#6 categorization)** — QA APPROVE, clamp proven vs 14 payloads; hardening → issue #14. Merged **PR #11 (#5 anomaly + ADR-010)** — QA found a **Critical** review-queue status-machine bug; **fixed** (404/409 guards + array guard + 4 regression tests + security comment) then merged. Opened + reviewed Barat's PRs: **#12 OCR = CHANGES REQUESTED** (Critical unterminated-`<think>` parse → fabricated data; Barat fixes on branch), **#13 templates-route = unreviewed (next)**. **#8 reports** still needs QA re-review. Built a visual build-status board; ran the real (empty) dashboard for the Owner. **ADR-011:** rough reference frontend for Mugi after backend lands.
- **What's next (J2):** review #13 → re-review #8 → (Barat's #12 fix) → merge → unblock Barat ingestion wiring → Jeevan #2/#9/#7. See `docs/HANDOFF.md` J1 session-end block.
- **Assumptions:** merge authority delegated to J1/J2 by Owner. State-doc conflicts: WORKLOG keep-both; STATUS/HANDOFF/MEMORY take `--theirs` then refresh.

## 2026-07-01 · Claude-J1 (for Jeevan) · feature/jeevan-p5-anomaly (PR #11 QA fix)
- **Files:** `routes/review.js`, `lib/anomaly.js`, `tests/review.route.test.js`.
- **What changed:** Fixed the **Critical** integrity bug found by the independent Tier-2/QA review of PR #11: `POST /api/review/:id` had NO status-machine enforcement — a rejected expense could be flipped to approved, a never-flagged `saved` one "reviewed", and a nonexistent id returned a fake 200. Now: 404 if not found, **409 if status !== 'needs_review'**, and the `anomaly` array-guard (`!Array.isArray`) so the audit record can't silently vanish. Added a SECURITY comment in `lib/anomaly.js` (Important #3): `opts` must be built server-side; never spread client body into it (would let a personal account force the LLM personal detector on, ADR-010). +4 integrity regression tests. **54/54 pass.**
- **What's next:** merge PR #11. Remaining QA minors (money-math boundary tests, decision naming, spec gap) → non-blocking follow-up.
- **Assumptions:** none new.

## 2026-07-01 · Claude-J2 (for Jeevan) · feature/jeevan-p5-anomaly (PR #5)
- **Files:** created `lib/anomaly.js`, `lib/account.js`, `routes/review.js`, `tests/anomaly.test.js`, `tests/review.route.test.js`, `docs/specs/2026-07-01-anomaly-design.md`; +1 mount line in `server.js`; **ADR-010** in `docs/DECISIONS.md`; capability flags in `.env.example`.
- **ADR-010 (account model):** after reviewing a receipt-SaaS video (BookZero.ai) with Owner — decided **one codebase + capability flags** (personal default = all off), NOT a personal/business fork. New `lib/account.js` `getCapabilities()` (env-driven v1, DB later). First consumer: #5's personal-vs-business detector is now **gated on `businessProfile`** (off for personal accounts; the other 3 detectors run for everyone). Video also surfaced future features to consider: **bank reconciliation** (receipt↔statement matching — pairs with #5), tax-recovery metric, observability (Sentry/PostHog), email import.
- **What changed:** #5 anomaly detection + admin review queue (design approved by Owner). `detectAnomalies(expense, opts)` runs **4 detectors** → `{flagged, reasons[], status_suggestion}`:
  1. **duplicate** (deterministic) — same merchant+amount+date within ±3d of a `history` row.
  2. **outlier** (deterministic, robust) — amount > 5× the **median** for that merchant (≥4 peers).
  3. **data_quality** — missing/≤0 amount, impossible date, `subtotal+tax ≠ total`.
  4. **personal** (LLM watchdog, TEXT_MODEL) — conservative, **business-context aware**, flags only when clearly personal AND confident ≥0.8. Caged like #6 (JSON, receipt text as untrusted data, graceful on failure).
  Never auto-acts → flagged expenses get `status='needs_review'`. **Admin queue** = new `routes/review.js`: `GET /api/review` (queue), `POST /api/review/:id {decision,note}` → sets `approved`/`rejected` and records the audit into the existing `expenses.anomaly` jsonb (**no schema change**). Status machine: `saved→needs_review→approved|rejected`. **Tests: 49/49** (21 new).
- **What's next:**
  1. Tier-2 + QA review of PR #5.
  2. **Barat** (`lib/ocr.js`/`lib/bot.js`): at ingestion call `detectAnomalies(expense, {history, businessType})`, store in `expenses.anomaly`, set `status = status_suggestion`.
  3. **J1** (`reports`/`excel`, after #8 merges): exclude `status='rejected'` from totals (1-line `status=neq.rejected`).
  4. **Mugi** (later): dashboard review-queue UI.
- **Assumptions:** single-account v1; thresholds (dup window 3d, outlier 5×/≥4 samples, personal conf ≥0.8) are opts-overridable defaults; review note capped at 500 chars, stored in `anomaly.review`.

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
