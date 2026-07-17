# Lessons Learned — 2026-07-17: Review Queue Staleness, Staff Lock Mode, Duplicate Detection

> **Read this before touching:** `lib/bot.js` (Telegram bot), `public/js/components/activity.js`
> (Review Queue / Activity dashboard), `lib/anomaly.js` (duplicate/anomaly detection).
>
> This file exists so a **future Claude Code session** working on this repo can skip re-deriving
> these root causes from scratch. Each problem below follows the same shape: **Symptom → Root
> Cause → Fix → Lesson**. The lessons at the bottom are the reusable, codebase-wide takeaways —
> read those even if none of the specific bugs recur.

---

## Problem 1 — Review Queue showed already-decided cards forever, with a dead error

**Symptom:** Approving a bill from the Review Queue correctly flipped its status in the database,
but the card sometimes stayed visible in the queue, showing "expense is not pending review
(status=approved)" every time it was tapped again — with no way to make it disappear short of a
hard browser reload.

**Root cause:** `public/js/components/activity.js`'s `load(force)` function (around line 1966 at
the time) had an early-return guard: `if ((state.loading || state.loaded) && !force) return;`.
Once the Activity page loaded successfully ONE time, `state.loaded` stayed `true` forever, and
`loadReview()` — called only after that guard — silently stopped being invoked on every later
visit to the tab. `app.js`'s nav `select(id)` calls `inst.load()` on *every* tab click, but the
guard made those calls no-ops for the Review Queue specifically. Anything decided through another
path (another admin, another device, a bulk action) stayed permanently stale in this browser tab.

**Fix (PR #255):** Moved `loadReview()` to run unconditionally at the top of `load()`, before the
early-return guard. It already had its own in-flight guard (`if (reviewState.loading ...) return`),
so calling it on every tab re-entry is safe and cheap.

**Separately, PR #213 (Jeevan, merged same day)** fixed the *symptom* half of this — what happens
when you click a stale card (409 → resync + button re-entrancy guard). Both fixes were needed;
neither alone was sufficient. If you see similar staleness in a different pending-state Map
(`pendingBatchWizard`, `pendingBillDelete`, etc.), check whether its *loader* has the same kind of
one-shot guard.

**Lesson:** In this SPA, a `state.loaded` guard on a shared `load()` function can silently disable
sub-fetches (like a secondary queue) that have no loading indicator of their own. If a feature adds
a new fetch inside `load()`, make sure it's not accidentally gated behind a flag meant for a
*different* fetch.

---

## Problem 2 — Staff Lock Mode button vanished after using other menu buttons

**Symptom:** After shipping Staff Lock Mode (a new persistent-keyboard row in business mode), the
button appeared initially but disappeared again after tapping "Today Expenses," "Weekly Record," or
re-sending `/start`.

**Root cause:** The persistent Telegram reply keyboard (`ReplyKeyboardMarkup`) is attached
per-message, not globally — Telegram only redraws it when a *new* message arrives carrying a new
one. `lib/bot.js` has **5 separate call sites** that send this keyboard (Bot Guide, the fallback
"I didn't catch that" reply, `/start`, `handleTodayExpenses`, `handleWeeklyRecord`). The first pass
(PR #263) updated only 3 of the 5 to use the new `businessMenuKeyboard(lock)` — the other 2 still
hardcoded the old `MAIN_MENU_KEYBOARD`, so tapping those specific buttons silently reverted the
visible keyboard.

**Fix (PR #264):** Grepped for every literal usage of `MAIN_MENU_KEYBOARD` in `lib/bot.js` and
updated the 2 remaining spots to conditionally use `businessMenuKeyboard(...)` when
`businessBinding`/`binding` is truthy.

**Lesson — the big one:** When a constant (a keyboard, a header, a status string, anything sent to
an external client) is referenced from **multiple call sites**, changing its logic in *some* of
them and shipping is a guaranteed intermittent bug. Before considering a change like this done,
**grep the whole file for every literal reference to the old constant/pattern**, not just the ones
encountered while implementing the main feature path. `grep -n "MAIN_MENU_KEYBOARD" lib/bot.js`
would have caught this in one command, before shipping, instead of after a live bug report.

---

## Problem 3 — False diagnosis from querying the wrong database

**What happened:** While investigating Problem 2, a query against `bot_bindings`/`branches`/
`expenses` using the *local* `.env`'s Supabase credentials came back completely empty. This was
wrongly reported to the user as "0 branches exist — business mode was never set up" — stated as
verified fact. It was wrong: the local `.env`'s `SB_URL`/`SB_KEY` point at a different (empty,
likely stale/dev) Supabase project, not the one the live Premala VPS actually uses. The live system
clearly had real data (branches, staff, submitted receipts — visible in earlier dashboard
screenshots in the same conversation).

**How this was caught:** the user pushed back ("existing clerk already uses the bot") — a
direct contradiction of the "0 branches" claim. Re-verification found `SB_KEY` locally is an
`sb_publish_...`-prefixed key (Supabase's newer publishable/anon-tier key format), and the local DB
returned genuinely empty results for `expenses` too (which is impossible against real production
data) — proving the local `.env` targets a different project entirely.

**Lesson — do not trust local `.env` as a proxy for production state.** This repo's local dev
`.env` and the VPS's actual (gitignored, never-committed) `.env` can silently diverge — same
variable names, different values. Things that **are** safe to check directly against the live
system (no SSH needed):
- `curl -sk https://<VPS_HOST>/api/config` — public, no auth, shows `multi_user`, `bot_username`,
  capability flags as the LIVE server actually has them configured (routes/expenses.js:457).
- `curl -sk https://<VPS_HOST>/health` and `/ready` — confirms the process is up and its
  dependencies (db, storage) are reachable.
- `getWebhookInfo` via the real `BOT_TOKEN` (Telegram's API, not this repo's DB) — confirms which
  server Telegram is actually delivering updates to, and whether there's a delivery error.

Things that are **NOT** safe to assume match production: any direct Supabase REST query using
local `.env` credentials. If a database-level check is genuinely needed and the local credentials
are suspect, say so explicitly and ask before asserting anything as verified fact — a wrong "I
checked, it's empty" is worse than an honest "I can't verify this from here."

---

## Problem 4 — Duplicate receipts not caught because OCR read the merchant name differently each time

**Symptom:** The same physical receipt ("99 Speed Mart") got saved 3 separate times instead of
being rejected as a duplicate.

**Root cause:** `lib/anomaly.js`'s `findDuplicate()` matched merchant names via `norm()` — trim,
lowercase, collapse whitespace — an **exact string match** after that normalization. OCR read the
same real-world shop as `"99 SPEED MART SDN. BHD."` on some captures and `"99 Speed Mart"` on
others. Different strings → treated as two unrelated shops → duplicate check never fired, even
though amount and date matched exactly on 2 of the 3 rows.

**Fix (PR #265):** Added `coreMerchant()` (strips a narrow whitelist of pure legal-entity suffixes
— Sdn Bhd, Bhd, Ltd, Inc, LLC, LLP, PLT, Corp, Pte Ltd — deliberately *never* strips a descriptive
business word like "Trading"/"Enterprise"/"Store", since that would risk collapsing two genuinely
different shops into a false match) plus a bigram Dice-similarity fallback (0.82 threshold, only
applied after amount+date already matched exactly) for OCR typos. Every fuzzy (non-exact) match now
logs a line with both merchant strings and the similarity score, so a repeat of this has real
evidence instead of a screenshot + guesswork.

**Verified no regression:** different merchants with the same amount/date (e.g. KFC vs 99 Speed
Mart) and different branches of the same chain (Tesco Extra vs Tesco Express) correctly do **not**
match — see `tests/anomaly.test.js`.

**Scope note:** this only prevents *future* duplicates. It does not retroactively clean up rows
already saved from a past incident — that's a separate, explicit action requiring confirmation
before touching real financial rows.

**Lesson:** any exact-string comparison over a field populated by an LLM/OCR extraction (merchant
names, category labels, addresses — anything read from an image rather than typed by a human) is a
latent false-negative bug. The model will not read the same real-world text identically every
time. When adding or reviewing matching logic over such a field, ask "what if the model reads this
slightly differently next time?" — and prefer a normalize-then-compare or fuzzy-fallback approach
over bare equality.

---

## General patterns worth remembering for this repo

1. **Grep before you ship a change to a shared constant.** If N call sites reference the same
   constant/keyboard/template, changing the logic requires touching all N, not just the ones your
   main test path exercises. `grep -n '<CONSTANT_NAME>'` across the touched file is cheap insurance.

2. **Local `.env` ≠ production `.env`.** Never assert something about the live system's data based
   on a local Supabase query. Use the public HTTP surface (`/health`, `/ready`, `/api/config`,
   Telegram's own `getWebhookInfo`) to verify live state instead — those hit the real server
   directly, no credential mismatch possible.

3. **This repo blocks direct pushes to `main`** (a local git hook per the Friction SOP — "no one,
   Owner included, pushes to main directly"). The only way to land a change is:
   `git checkout -b <branch>` → commit → `git push -u origin <branch>` → `gh pr create` → (review
   or explicit user override) → `gh pr merge <n> --merge --delete-branch`.

4. **The only way to restart the live bot is a merge to `main`.** `.github/workflows/deploy.yml`
   triggers only on `push: branches: [main]` — there is no `workflow_dispatch` restart-only path,
   and no local SSH access exists to the VPS (the deploy key lives only in GitHub Actions secrets).
   A "just restart it" request always means "merge something to main."

5. **Any exact-match logic over OCR/LLM-extracted text is suspect.** See Problem 4. Default to
   asking "could the model phrase this differently next time?" before shipping a strict-equality
   check on such a field.

6. **Telegram's persistent `ReplyKeyboardMarkup` only updates when a NEW message carries a new
   one.** It does not retroactively refresh just because server code changed. When debugging "the
   button doesn't appear," always check which specific message/handler the user's last interaction
   went through — some handlers (e.g. `handleTodayBills`) never attach the persistent keyboard at
   all, by design, and testing via those will never show a keyboard change either way.

7. **After any live production fix, verify — don't just assert.** This session's working pattern:
   run the full test suite, merge, then confirm via `gh run watch` that CI *and* the deploy job's
   own health/readiness check both went green, then independently hit `/health`/`/ready` or the
   relevant public endpoint one more time before telling the user it's done. A claim of "it's live
   and working" without this chain of proof is not acceptable on this system (real business data,
   real Telegram users).
