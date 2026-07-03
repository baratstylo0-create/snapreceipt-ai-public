# Messages to Jeevan — from Barat's Claude sessions (B1/B2)

> Append-only log of every ready-to-send message handed to Barat for Jeevan (SOP-style, mirrors WORKLOG.md).
> Newest entry at the bottom. Barat copy-pastes these to Jeevan as-is or edits before sending.

---

## 2026-07-03 · Claude-B1 · re: PR #49, issues #45/#43 status

Pulled `main` (has #44/#46/#47/#48 — all confirmed merged, clean). But I don't see `normalizeCurrencyCode()` in `lib/currency.js` or `cfg.AUTH_REQUIRED` in `lib/config.js` on any branch/remote yet — checked `main` and every pushed branch. Looks like those two are only committed locally on your end, not pushed. Once they're up I'll wire in the `assembleExpense` currency swap (#45) and the webhook fail-closed check (#43) same day — both are small. Also flagging: my PR #49 (`fix/barat-flushgroup-timer-unhandled-rejection`) touches the same `flushGroup` catch line that #46 just merged — should be a clean/no-op overlap but wanted you aware before merging.

---

## 2026-07-03 · Claude-B1 · re: #45 + #43 done (one PR), item 5 already closed

Both done on ONE branch per your process note — `fix/barat-currency-normalize-and-webhook-failclosed`, PR #51. Pinging as requested.

- **#45 (RM→MYR):** did the exact one-line swap in `assembleExpense` — `normalizeCurrencyCode(fields.currency) || cfg.DEFAULT_CURRENCY`. +2 integration tests (RM→converts FROM MYR + records `currency_original=MYR`; ambiguous `$`→DEFAULT_CURRENCY fallback). Closes #45.
- **#43 (webhook fail-open):** mirrored the checkDash pattern with `cfg.AUTH_REQUIRED` in `routes/webhook.js` — refuses **503** when `AUTH_REQUIRED && !WEBHOOK_SECRET` (prod misconfig), stays permissive + one-time `console.warn` in dev, configured-secret path unchanged (200/401). Flipped your #43 characterization test from "fail-open, not yet fixed" to a dev-permissive / prod-fail-closed pair. Closes #43. (Chose **503** for the misconfig-refuse — server config problem, not a client error; no internals leaked in the body. Shout if you'd prefer 500/403.)
- **443/443 green** (+4 new).
- **Your item 3 (schema verification item 5) is already closed** — I ran the live Supabase table-list query earlier today: only `expenses`/`field_templates`/`category_corrections` exist, nothing foreign. Logged in STATUS.md.
- **Process note taken** — this is the batched-onto-one-branch approach from here on.
- Groq multi-key rotation ADR: understood, no build until you hand me the signed-off spec.

---

## 2026-07-03 · Claude-B1 · re: non-receipt bug fixed (PR #54, merged)

Live QA caught it: sending a selfie replied "✅ Expense Captured / Unknown / $0.00" AND saved a junk row. Fixed — new `isEmptyReceipt()` in `lib/ocr.js`: no usable merchant AND no positive amount → skip the insert, reply asking for a clear receipt photo. Partial reads (merchant OR amount present) still saved for review. +9 tests.

---

## 2026-07-03 · Claude-B1 · re: rate-limit visibility headers (PR #56, merged)

`createRateLimiter` now emits `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` on every response (allowed + 429). Remaining floored at 0, Reset = whole seconds left. Purely additive. Thanks for wiring the frontend chip (#58) — nice.

---

## 2026-07-03 · Claude-B1 · re: Groq key-rotation DONE (PR #60)

Wired `lib/groq.js`'s fall-through against your `lib/groqkeys.js` — `feat/barat-groq-key-rotation`, PR #60. All three of my flagged questions resolved per your module doc:
- **(1) 429-only rotation** — a non-429 throw keeps today's backoff, never rotates. ✓
- **(2) key-swaps don't eat the backoff budget** — rotation is bounded by the `tried` set (no sleep); only full-pool exhaustion consumes one of the 4 backoff attempts. ✓
- **(3) supersede-not-union** — matched your `.env.example`; no doc change needed. ✓

Factored the duplicated 4-attempt loop into one shared `callGroq()` runner (removes the groqChat/groqChatTools copy-paste as a bonus). **Single-key / `GROQ_KEYS`-unset is byte-for-byte the old behavior** — all 6 of your existing groq tests stay green, timings unchanged. +5 rotation tests (429→different key no-sleep, no key retried twice/round, exhaustion→backoff, single-key unchanged, happy path). 668/668. ADR-016 is complete once this merges — pool ceiling ×(pool size) at $0.
