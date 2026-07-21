# The qwen model era — everything changed since Groq killed llama-4-scout

> **What this doc is:** a single, plain-language timeline of every change made to the receipt
> bot because of one root event — Groq discontinued the accurate vision model this bot ran on,
> forcing a switch to a less reliable replacement. Written so a future reader (human or Claude)
> can see the whole story in one place instead of piecing it together from 20 separate PRs.
> **Not a replacement** for `WORKLOG.md` (full chronological ledger) or `DECISIONS.md` (ADRs) —
> this is a focused narrative pulling the qwen-related thread out of both.

## The root cause (2026-07-17)

Groq discontinued `llama-4-scout-17b-16e-instruct` — the vision model this bot used to read
receipt photos — and force-migrated every account to `qwen/qwen3.6-27b`. Nothing in this
project's code changed that day; the model underneath it did. qwen turned out to be
**meaningfully less reliable** at receipt reading in three specific ways, and almost everything
below traces back to compensating for one of them:

1. **It sometimes returns nothing at all.** qwen runs an internal `<think>` reasoning pass
   before answering. On a hard receipt (ambiguous digit, odd layout) that reasoning can spiral
   and eat the entire token budget, leaving no room for an actual answer — an empty response,
   not a wrong one.
2. **It occasionally misreads a digit** — most visibly a year (`2026` read as `2024`), but the
   same class of error can hit any number.
3. **It shares one rate-limited API key** with every other request this project makes (OCR,
   Falc chat, everything) — a burst of receipts can exhaust the per-minute budget in a way the
   old setup rarely hit.

## Part 1 — Getting qwen to actually answer (2026-07-18, PR #269-era work)

- **`OCR_MAX_TOKENS` raised 2500 → 6000.** Real-receipt testing measured ~33% empty output at
  2500 (the `<think>` pass spiralling past budget on an ambiguous digit). 6000 fixed the tested
  failures. Made the code *default*, not something only a `.env` override fixed — a stale
  server `.env` without the override would otherwise silently regress.
- **Reasoning-off was tested and REJECTED.** Turning `<think>` off entirely (`reasoning_effort:
  'none'`) is ~5-10x faster and kills the spiral — but an A/B test on a stained receipt showed
  it **reliably misread `97.20` as `7.20`, twice**, because the thinking pass is what
  self-corrects via subtotal+tax=total. For a money pipeline, a silently-wrong number is worse
  than an empty one (an empty gets caught; a plausible wrong number doesn't). Kept as an
  opt-in-only knob with an explicit "don't use this in a money pipeline" warning.
  **This lesson mattered again later — see Part 4.**
- **Retry-on-empty added instead.** The empty-output failure is non-deterministic — the same
  image commonly succeeds on a second try — so `extractReceipt`/`extractReceipts` retry once on
  a fully-empty parse. Recovers most of the ~14% empty-output rate for free.
- **Same `<think>` leak hit Falc chat** (PR #273, 2026-07-19) — a *different* surface
  (`lib/agent.js`, the dashboard/Telegram chat assistant) runs on the same `qwen/qwen3.6-27b`
  and had zero handling for a leaked `<think>` block. Reused the OCR fix's tested `stripThink()`
  rather than writing a second copy of the same untrusted-output logic.

## Part 2 — The rate-limit saga: one shared key, many symptoms (2026-07-19 → 2026-07-21)

A single Groq key's per-minute budget is shared by every photo this bot reads, for every user,
plus whatever load testing adds. Under that shared budget, the same underlying constraint
surfaced as several different-looking problems, fixed one at a time:

| PR | What it fixed |
|---|---|
| #274 | Stopped telling the user their **photo** was blurry when the real cause was a 429 rate limit (the two were landing in the same error handler). |
| #275 | Added pacing between bulk-upload image reads so a batch doesn't trip the limit itself. |
| #276 | Coalesced individually-sent bulk photos into one batch instead of firing them all at once. |
| #277 | Widened the bulk pacing gap 3s → 6s (3s still tripped it under real load). |
| #279 | Single-photo path: retry once after a 15s backoff on a rate-limit error before giving up. |
| #281/#283/#285 | Capped bulk photo batches at 2 (was silently 10 via a stale `.env`, see Part 3), and made an over-cap batch reject wholesale/unread instead of partially processing — fewer receipts fighting over the same budget per message. |
| #292 (this session) | The single-photo rate-limit message still said **"too many receipts sent at once"** even for a lone photo — misleading, since the limit is cumulative load over the trailing minute (this account, other accounts, or heavy testing), not something the sender did. Reworded to "the receipt reader is briefly busy" — no blame, same retry behavior. |

**Still true today:** this is a capacity problem, not a bug, and no wording fix removes it.
The real fix is provisioning more Groq keys (a round-robin design across the existing key-pool
mechanism, `lib/groqkeys.js`, is already drafted — see the plan file history) or moving OCR to
a different provider entirely (Part 5, PR #286).

## Part 3 — The `MASS_MAX_IMAGES` / batch-cap saga (2026-07-20)

Separate discovery: `MASS_MAX_IMAGES` was one env var silently shared across three unrelated
uses — the Telegram photo-batch cap, PDF page cap, and dashboard bulk-upload cap. A stale
server `.env` value (`=10`, left over from before the cap existed) silently overrode the code's
new default of 2, because an explicit env var always wins. Live QA (forwarding photos via
Telegram Web) caught this — the "fixed" cap wasn't actually active in production. Fixed by
**hardcoding the Telegram batch cap** (PR #285) so no server's `.env` drift can ever override it
again; the other two uses of `MASS_MAX_IMAGES` were left alone (still legitimately configurable).

## Part 4 — The dashboard/bot date mismatch, and a mid-course correction (2026-07-21)

A user report — the bot's "Today Bills"/"Weekly Record" showed receipts the dashboard's
Activity page said didn't exist — traced to the bot using `created_at` (capture timestamp) and
the dashboard using `expense_date` (the OCR-read date printed on the bill) for their respective
"this month" filters. PR #287 switched the dashboard to `created_at` to match the bot. **The
Owner then explicitly reversed this** — the dashboard should show accounting-period semantics
(the date printed on the bill), not capture semantics — reverted cleanly via `git revert` as
PR #288. **Lesson recorded:** when a user reverses an explicit prior choice, revert cleanly
rather than hand-re-editing, and it's fine — a design call changing isn't a mistake.

## Part 5 — The date-plausibility saga: a real fix, an overcorrection, and the correction (2026-07-21, this session)

This is the big one, and it's worth being honest about the shape of it, not just the outcome.

**The real bug (confirmed via live QA):** a receipt's year got misread (`2026` → `2024`). That
value *parses* fine, so nothing caught it — and the wrong year then (a) hid the receipt from
the dashboard's date-filtered views, (b) corrupted its `RC-<year>-####` reference number, and
(c) made unrelated receipts collide into false "duplicate" rejections when two different
misreads landed on the same fabricated year+amount.

**First fix, PR #289 — too aggressive.** Added `isDatePlausible()` and made the bot **refuse to
save** any receipt whose date looked implausible (or was flat-out unparseable), or whose photo
self-reported `image_unclear:true` for *any* reason. In production this **rejected real,
readable receipts** — including a live receipt the Owner sent during QA, told "not clear, please
resend." Two follow-up PRs (#290, #291) improved the wording of that rejection message, but the
underlying behavior — refusing good receipts — was the actual problem, not the wording.

**The correction, PR #293 — the standing rule going forward.** The Owner's explicit, permanent
rules, now implemented:
1. **Never invent or substitute receipt data.** Save exactly what was read off the bill. No
   silent "corrected" date, no guessed value standing in for a real one.
2. **Only refuse when genuinely unreadable** — no merchant AND no amount at all
   (`isEmptyReceipt`). A receipt with a merchant and an amount is **always** saved, no matter
   how odd its date looks or how uncertain the photo self-reports.
3. **"Blurry/unclear" must mean the amount digits are genuinely illegible** after a careful,
   deliberate read — not a lazy blanket flag on any minor tilt, glare, or thermal-print fade.

Implemented as: `assembleExpense`'s reject gate is now `isEmptyReceipt` alone; an implausible
date or an `image_unclear` signal is a **soft, non-blocking review flag** (the existing
`needs_review`/`⚠️` mechanism) — the receipt saves with the model's real values either way.
`CLARITY_KEY` (the prompt asking the model to self-report legibility) was narrowed to fire only
on genuinely illegible amount digits, and the extraction prompt now explicitly tells the model
to look carefully and transcribe exactly what's printed, never guess or invent.

`isDatePlausible()` (`lib/money.js`) is still in the codebase (harmless, still unit-tested) but
is **deliberately unused** for rejection now — kept as a documented, available building block,
not wired into any reject path.

**The actual lesson, stated plainly for next time:** a guardrail that protects against a rare
bad case must not have a bigger blast radius than the bug it's protecting against. Rejecting
1 in 500 misreads by also rejecting real receipts is a worse trade than the original bug.

## Part 6 — What's still open (not fixed by any of the above)

- **PR #286 — move OCR to OpenRouter, restore the old accurate model.** Groq no longer offers
  `llama-4-scout` at any price; OpenRouter still hosts it (a different provider's copy of the
  same model). This is the only path back to the original reliability — everything else in this
  doc is compensating for qwen's weaknesses, not fixing them. Blocked on the Owner provisioning
  an `OPENROUTER_KEY` (a new paid account) — not something Claude can create or fund. Open,
  unmerged, as of this doc.
- **The shared rate-limit capacity problem** (Part 2) — needs either more Groq keys or the
  OpenRouter move; no code change removes it, only reduces how often it's hit.
- **Model reading accuracy itself.** Even with the Part 5 correction, if qwen misreads a digit,
  the bot now faithfully saves that (real, imperfect) read rather than inventing a "fix" — which
  is the correct behavior per the Owner's rules, but it means an occasional wrong date or amount
  can still reach the dashboard exactly as misread. The only way to reduce *that* is a more
  accurate model (PR #286) or better prompting (Part 5's tightened `CLARITY_KEY`/instruction) —
  not more code-side rejection.

## Quick reference — PR numbers, oldest to newest

`#269` (OCR_MAX_TOKENS docs) · `#273` (Falc think-leak) · `#274-#279` (rate-limit wording +
pacing) · `#280` (menu bar fix, unrelated) · `#281/#283/#285` (batch cap hardening) · `#282/#284`
(docs/comment cleanup) · `#286` (**open** — OpenRouter model switch) · `#287/#288` (dashboard
date filter, tried + reverted) · `#289` (date-plausibility reject — **superseded**) · `#290/#291`
(wording improvements to the now-superseded reject behavior) · `#292` (rate-limit wording) ·
`#293` (**current state** — never reject a readable receipt, never invent data).
