# Spec — #9 Dashboard Agent (Phase 1: read-only, write-ready)

> Status: approved (brainstorm 2026-07-01). Owner: Jeevan. Branch: `feature/jeevan-p4-agent`.
> Track: Vertical AI (SOP §3) → **Tier-2** (SOP §4.7: AI prompt boundary + untrusted model output).
> New frozen interface (ARCHITECTURE §3): `lib/agent.js` exports `runAgent(messages, deps)` (transport-agnostic).
> Consumes (read-only): `sbSelect()` (Barat, `lib/supabase.js`), `buildReport()` (Jeevan, `lib/reports.js`),
> the Groq chat client (Barat, `lib/groq.js`), `cfg` (`lib/config.js`). No new dependency.

## Goal
A natural-language chat over the account's own expense data. The user types a question
("how much on fuel last month?", "top 5 merchants this quarter", "everything over $200 in June")
and gets an answer **computed from real rows**, never fabricated. The model may only *request*
one of a fixed set of allow-listed, server-validated **read** tools; the server runs the query and
feeds real results back. This is a Vertical-AI feature (agentic reasoning over the user's data).

## Scope (this PR = Phase 1)
- **Read-only.** Three tools, all thin wrappers over code that already exists. The agent literally
  cannot mutate or delete anything — there are no write tools registered.
- **Write-ready framework.** The tool registry and loop are built so Phase 2 (agentic write actions
  with a Claude-Code-style ask/auto permission model) plugs in by *adding* tools, not refactoring.
  See "Forward-compat" below. **No write behaviour ships in this PR.**
- **Transport-agnostic core.** `lib/agent.js` knows nothing about HTTP or Telegram, so the same brain
  can later serve `routes/agent.js` (this PR) and Telegram (Barat's lane, future) unchanged.

Explicitly **out of scope for Phase 1** (own specs later): write/mutation tools; the confirmation
handshake + permission modes (#9b); column add/remove via `mutateFieldSpec` (Phase 2b, needs Barat);
the Telegram adapter; per-account tool gating by capability flag (ADR-010); rate limiting (P6).

## Model & mechanism
- **Native Groq function-calling** (OpenAI-compatible `tools`/`tool_calls`). Barat verified live on
  2026-07-01 that `qwen/qwen3.6-27b` does the full round-trip cleanly (tool_calls with correct fn
  name + JSON args + id → `role:tool` result appended → correct final answer). **No JSON-protocol
  fallback.**
- Model id is **env-driven** (ADR-006 rule — never hardcoded): `AGENT_MODEL`, default
  `qwen/qwen3.6-27b`. Routed through `lib/groq.js` (Barat's frozen client) like all other model calls.
- **Generous `max_tokens`** (default 1500, env `AGENT_MAX_TOKENS`): qwen runs a `<think>` pass before
  emitting `tool_calls`/the answer, so a tight cap gets consumed by reasoning (per ADR-007 note +
  Barat's confirmation). `temperature` 0 for determinism.

## The three tools (allow-list)
Each is a pure server function over account-scoped reads. The model sees only these; anything else is
rejected. All amounts are already account-currency-normalized at ingestion (#10), consistent with #8.

| Tool | Args (validated) | Returns | Backed by |
|---|---|---|---|
| `getReport` | `period` ∈ {day,week,month,year} (required); `from?`,`to?` ISO dates | `buildReport()` output (total, count, buckets w/ byCategory) | `sbSelect('expenses',…)` + `buildReport()` |
| `listExpenses` | `from?`,`to?` ISO; `category?` str; `merchant?` str; `status?` str; `limit?` int | array of `{merchant,expense_date,amount,currency,category,status,remark}` (projected — no `ai_raw`) | `sbSelect('expenses',…)` + in-memory filter |
| `topMerchants` | `from?`,`to?` ISO; `limit?` int | `[{merchant, total, count}]` desc by total | `sbSelect` + aggregate |

Row source for all three: the same `sbSelect('expenses', { extra: 'deleted_at=is.null', … })` used by
routes/expenses.js/reports.js — so **account scoping and soft-delete exclusion are inherited**, not
re-implemented. `status='rejected'` rows are excluded from money math (same rule as #8 reports).
Amounts coerced with #8's `toAmount()` (never fabricate money); dates validated with #8's `isISO()`.

## Guardrails (the Tier-2 surface — server is the sole enforcer)
Because the conversation is **stateless** (client resends the whole transcript each request), the
server is the only place cost/abuse can be bounded. All limits are constants (env-overridable):

- **Tool-call loop cap:** ≤ **6** iterations/request. On the 6th, make one final model call with
  `tool_choice:'none'` to force a text answer (never loop forever, never leave the user hanging).
- **Transcript caps:** ≤ **20** messages AND ≤ **~12 000** chars total. Over → `413` (no model call).
- **Server-side arg clamps regardless of what the model asks:** `listExpenses.limit` clamped to
  ≤ **500**; `topMerchants.limit` clamped to ≤ **20**. `period` must be in the allow-list; `from`/`to`
  must pass `isISO()`. Unknown arg keys are dropped, not passed through.
- **Unknown tool / invalid args → a structured `{error:…}` tool result fed back to the model** so it
  can self-correct within the iteration cap. Never crash, never a `500`, never leak a stack trace
  (SOP §7.2). The model's requested tool name is validated against the registry before dispatch.
- **Model output is untrusted (SOP §7.3):** the server executes only registry tools with validated
  args; the model's free text is only ever returned to the user, never `eval`'d or used for authz.
- **Prompt-injection posture:** user turns are carried as `role:user` content, isolated from the
  `role:system` instructions; the system prompt states the model may answer *only* from tool results
  and must not invent numbers. Even a fully-hijacked model can do nothing but call the 3 read tools
  with clamped args — the blast radius is "read your own already-accessible expenses."

## `lib/agent.js` (pure-ish, transport-agnostic core)
`async runAgent(messages, deps) -> { answer, toolCalls, iterations }`

- `messages`: the prior transcript (array of `{role, content}` / tool messages) — supplied by the
  caller (route/Telegram). `runAgent` does **not** persist anything (stateless).
- `deps`: injected for testability — `{ chat, sbSelect, buildReport, now }` (default to the real
  modules). Tests pass a fake `chat` that scripts `tool_calls` and a fake `sbSelect` returning fixed
  rows → the whole loop is unit-testable with **no network and no DB**, exactly like `buildReport`.
- **Tool registry** shape (write-ready): `{ name, kind:'read'|'write', destructive:boolean,
  schema (JSON-schema for the `tools` param), validate(args)->cleanArgs|throw, run(cleanArgs,ctx) }`.
  Phase 1 registers three `kind:'read'` tools. Phase 2 will register `kind:'write'` tools whose
  presence flips the loop into propose-confirm mode (not built now, but the field exists so the loop
  branch is a one-line check later).
- The loop: build `tools` from the registry → call `chat` → if `tool_calls`, validate+run each,
  append `role:tool` results, repeat (≤6) → else return the text answer.

## `routes/agent.js` (thin HTTP adapter)
- `POST /api/agent`, gated by the existing **`checkDash`** middleware (reuse from routes/expenses.js —
  no new auth). CORS header set before the try (matches reports.js/excel.js 502 convention).
- Body: `{ messages: [{role, content}, …] }` (the client-held transcript). `express.json({limit:'256kb'})`.
- Validates transcript caps → calls `runAgent` → responds `{ answer, messages: <updated transcript
  incl. this turn's assistant message> }` so the client stores it and resends next time.
- All errors → safe JSON (`400` bad body, `413` transcript too big, `502` upstream/model failure),
  never a stack trace. Mounted in `server.js` alongside the other routes.

## Forward-compat (Phase 2, NOT this PR — documented so Phase 1 doesn't paint us in a corner)
- **Write tools** register with `kind:'write'` + `destructive`. When any write tool is *invoked*, the
  loop returns a `{type:'confirmation_required', action, token}` envelope instead of executing; the
  client (dashboard dialog / Telegram inline buttons) confirms; a follow-up request with the token
  executes via existing validated mutations (`sbUpdate`/`sbSoftDelete`). **Ask mode** (default) always
  confirms; **auto mode** auto-approves `destructive:false` only — destructive/structural ops always
  confirm (SOP §7.3 mandate). Every executed write is audit-logged.
- **Column add/remove** (Phase 2b) is a write tool gated on a new safe `mutateFieldSpec()` in Barat's
  `lib/templates.js` (his lane) — always confirmed, never a direct template hand-edit.
- **Telegram** reuses `runAgent` verbatim; Barat adds `callback_query` to `allowed_updates` + an
  inline-keyboard confirmation handler in `lib/bot.js` (his lane).

## Testing (TDD, hermetic — mirrors #2 Excel / #8 reports)
Unit (`lib/agent.js`, fake `chat`+`sbSelect`, no I/O): single-turn no-tool answer; single tool call →
result → final answer; multi-tool sequence; **iteration cap forces `tool_choice:'none'` final answer**;
unknown tool name → structured error result (not a throw); invalid args (bad period, non-ISO date,
non-numeric limit) → error result; **limit clamp** (model asks 100000 → server runs ≤500 / ≤20);
`status='rejected'` excluded from money; `toAmount` rejects garbage; account scoping inherited (asserts
`sbSelect` called with the soft-delete `extra`, never a raw client-supplied filter).
Route (`routes/agent.js`): `checkDash` enforced when `DASHBOARD_TOKEN` set; transcript-too-big → 413;
malformed body → 400 (no stack trace); model/DB failure → 502 JSON; happy path returns updated
transcript. Boot/smoke: `/api/agent` mounts and fails safe with no DB.

## Definition of Done
Frozen `runAgent` interface; 3 read tools with server-side validation + clamps; loop cap; transcript
caps; `checkDash` auth; no new dependency; env-driven model id; all tests green; WORKLOG/STATUS/
ARCHITECTURE (add `lib/agent.js` to the module map) updated; PR → **independent Tier-2 QA** (AI
boundary) before merge, same bar as #8/#13/#19/#22.
