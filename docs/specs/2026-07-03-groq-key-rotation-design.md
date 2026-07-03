# Design — Groq multi-key rotation (quota pool)

> **Decision:** ADR-016. **Status:** pending Barat sign-off (touches his frozen `lib/groq.js`).
> **Owners:** `lib/groqkeys.js` + its tests = **Jeevan** (new infra module). Call-site change in `lib/groq.js` = **Barat**.
> **Tier:** Tier-2 (multiple third-party secrets). Config-driven, backward-compatible, model-quality-neutral.

## Goal
Pool several free Groq accounts' keys so the system's daily AI ceiling is ~Nx a single account's, at $0, with graceful fall-through on rate limits. Same model, same output quality — a key only changes *who pays*, never *how the AI thinks*.

## New module — `lib/groqkeys.js` (Jeevan)
Pure, dependency-free, no network. Parses the pool once at load.
```
// keyPool() -> string[]   parsed from process.env.GROQ_KEYS (comma-separated, trimmed,
//                          empties dropped); falls back to [process.env.GROQ_KEY] if
//                          GROQ_KEYS is unset/empty. [] only if neither is set.
// pickKey() -> string|null           a RANDOM key from the pool (null if pool empty)
// nextKey(tried:Set) -> string|null  a RANDOM key NOT in `tried` (null when all tried)
```
Random selection per ADR-016 (Owner's call). No per-request state held in the module; the caller owns the `tried` set for one call's fall-through.

## Call-site change — `lib/groq.js` (Barat) — additive, keeps today's shape
Both `groqChat` and `groqChatTools` already loop up to 4 attempts and detect 429. Change so that, per call:
```
tried = new Set()
key = pickKey()                       // random start
loop:
  set Authorization: 'Bearer ' + key
  send request
  if ok -> return
  if 429/rate-limited:
     tried.add(key); k = nextKey(tried)
     if k -> key = k; continue (NO sleep — different account, fresh quota)
     else  -> pool exhausted -> today's sleep+backoff, then retry (start=pickKey again)
  else (non-429 error) -> today's behavior (backoff/throw as now)
```
If the pool has one key (or `GROQ_KEYS` unset), behavior is **identical to today** — single key, backoff on 429. So it's a safe no-op for existing single-key deploys.

## Config
- `.env`: `GROQ_KEYS=key1,key2,key3,key4` (new). `GROQ_KEY` still honored as the fallback.
- `.env.example` + README: document the pool + that all keys are server-side-only secrets, rotated per ADR-015 launch gate.

## Tests (Jeevan, `tests/groqkeys.test.js`)
- `keyPool`: parses comma list, trims, drops empties; falls back to `GROQ_KEY`; `[]` when neither set.
- `pickKey`: returns a member of the pool; `null` on empty pool; (statistical) uses more than one key over many calls.
- `nextKey(tried)`: never returns a tried key; returns `null` when all tried; random among the untried.
Barat adds a `lib/groq.js` test proving: 429-on-key-A → retries key-B (no sleep); all-keys-429 → falls to backoff; single-key pool → unchanged behavior.

## Non-goals (YAGNI)
- No round-robin/fairness accounting (random is enough).
- No per-key health tracking / cooldown windows (a 429'd key is just skipped for *this* call; next call may pick it again — free tiers reset, and a still-limited key just falls through again). Revisit only if it proves wasteful.
- No model downgrade on fall-through (explicitly rejected — that WOULD change quality).
- No paid-tier billing logic (ADR-015 tier ladder handles that later).

## Security
Multiple plaintext secrets in `.env`/deploy — never logged, never client-sent (server-only, unchanged), rotated pre-launch (ADR-015). A pool leak exposes N accounts vs 1 — accepted pre-launch on host-only secrets.
