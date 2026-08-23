# Backend Issues Log

Backend/bot-logic issues reported but NOT fixed by Claude (frontend-only scope on this project — see project memory "Receipt SaaS: Frontend Only"). Records only — no general docs here.

**Workflow rule (2026-08-23, from Barat):** whoever fixes an item below — push the fix to GitHub, open a PR to `main` (direct pushes are hook-blocked anyway), and update that item's entry here with what was actually changed and how, before considering it done. Don't fix silently. See `docs/WORKLOG.md`'s 2026-08-23 entry for the full handoff note, including a file-ownership flag on items #1/#2/#3/#6.

---

## 2026-08-23 — QA report from Barat

### 1. "Ask your admin" message shown to personal (non-business) accounts
- File: `lib/bot.js` — `bindWithToken()` (~line 164), `BUSINESS_UNBOUND_MESSAGE` (~line 240)
- Issue: link-binding error messages ("not valid" / "expired" / "already used") all say "ask your admin" — written for the multi-staff business bot. Personal accounts have no admin; every user owns their own account.
- Root cause found (2026-08-22): NOT actually a wrong-message-per-account-type bug. `bindWithToken()`'s own `bind_token` lookup (`sbSelect`) was scoped to `account_id=cfg.ACCOUNT_ID` (the old shared bucket). Every personal signup since 2026-08-14 gets its own unique `account_id`, so this lookup could never find a real, valid connect link for any of them — it fell through to the generic "link isn't valid" message regardless of account type. The message text itself was never the bug.
- Fix applied: `bindWithToken()`'s lookup (and its `chat_id`-set write) now use `sbSelectGlobal`/scoped-write (`lib/supabase.js`), matching every other identity-lookup fix from the same investigation (see `lib/supabase.js`'s `sbSelectGlobal` doc comment). Verified live against a real production account (baratstylo0, chat_id 1376793145) — was resolving to zero rows before, resolves correctly after.
- Status: FIXED (commit on `fix/stale-test-expectations-2026-08-12`, merged into this branch's history; deployed to snapreceiptai.friction.com.my and live-verified)

### 2. Guest Mode auto-logout after first receipt + no per-device cap
- Files: `lib/bot.js`, `lib/account.js`, `routes/guest.js`
- Issue: guest session drops back to the login screen right after upload #1, so a guest can keep starting new guest sessions forever, burning OCR/API credits each time.
- Auto-logout sub-issue (2026-08-22 investigation): live-reproduced a full guest signup + manual-entry save + file upload against production — no logout occurred either way. Code-audited every reload trigger in `public/js/app.js`: only two exist (`logout()`, explicit; `handleAuthExpired()`, only on a genuine 401 with no server-side code anywhere that kills a guest's session on upload). The header refresh button's own hard-reload (`reloadPage()` → full app reload → guest logout) was ALREADY fixed and live before this investigation started (`onRefresh: refreshCurrentView`, see `public/js/app.js` — no separate action needed here). Could not rule out a Telegram-in-app-browser-specific edge case (no real device available to test), but no remaining code path reproduces the reported symptom.
- Per-device cap: **built, tested, NOT yet deployed** — blocked on a one-time schema migration (new `guest_ip_log` table, additive/insert-only, deliberately never touched by the 24h guest-data sweep so the block can't silently reset). SQL is at the bottom of `schema.sql`. `routes/guest.js` (IP check via `lib/ratelimit.js`'s `clientKey`) and `public/js/app.js` (a clear "you already tried Guest Mode" message instead of the previous silent bounce-to-Landing) are both written and unit-tested (`tests/guest.route.test.js`), but withheld from the live deploy until the migration runs — deploying code against a table that doesn't exist yet would break Guest Mode entirely.
- Status: PARTIALLY FIXED — auto-logout: no reproducible bug found, nothing further to fix without new repro info. Per-device cap: code complete, awaiting DB migration (Barat) before deploy.

### 3. Bot should restrict replies after guest trial ends
- File: `lib/bot.js`
- Issue: after a guest is capped, the bot still replies normally to anything sent.
- Fix applied: `handleUpdate()` now checks `countGuestExpenses()` against `GUEST_RECEIPT_CAP` immediately after the binding resolves, for role `'guest'` only — before any text/photo/callback routing. At or over cap, every input shape (text, photo, PDF, button tap) gets ONLY `GUEST_CAP_REACHED_MESSAGE`, nothing else. Bonus: this also stops a capped guest's photo from burning a real OCR API call (previously only the photo-capture path checked the cap; text/buttons fell through to the normal menu). 4 new tests in `tests/bot.business.binding.test.js` (text, callback-query, under-cap passthrough, owner-role exemption).
- Status: FIXED (deployed to snapreceiptai.friction.com.my and live-verified)

### 4. Duplicate-receipt detection not triggering on re-upload
- File: `lib/ocr.js` — `assembleExpense()` (~line 391), duplicate check (~495-505, ~614-620)
- Issue: re-uploading an already-saved receipt should hit the existing exact-match duplicate check (merchant+amount+date) and get rejected — a live test saved it as a new entry instead.
- Root cause found (2026-08-22): `findDuplicate()` (`lib/anomaly.js`) hard-requires a parseable `expense_date` on BOTH the new read and the history row it's comparing against (`parseDate(...) == null` short-circuits the whole check with no match). This is almost certainly the SAME root cause as #5 below — when OCR can't read the date, the match never runs, so a receipt that fails date-OCR twice in a row silently looks like two unrelated expenses instead of triggering the duplicate check. Not yet fixed — tied to the #5 investigation below; Barat asked to park both for now rather than ship a partial fix.
- Status: OPEN (investigated, root cause identified, intentionally parked — see #5)

### 5. OCR misreads dates even on clear photos
- File: `lib/ocr.js` (same extraction pipeline as #4), `lib/money.js`, `lib/confidence.js`
- Issue: date extraction sometimes fails on well-lit, clear receipts, forcing a manual date prompt.
- Findings (2026-08-22):
  - `normaliseDate()` (`lib/money.js`) silently substitutes TODAY's actual date whenever it can't parse what the model read — no flag, no signal. This directly conflicts with Barat's own 2026-07-21 directive in `lib/ocr.js` ("NEVER invent/substitute data... only refuse when the bot genuinely could not read it at all") — that directive was written to stop over-eager REJECTION of readable receipts, but the current fallback still silently INVENTS a date, which is the exact behavior the directive also says never to do.
  - `isDatePlausible()` (`lib/money.js`) already exists specifically to range-sanity-check a date that parses but is likely wrong (e.g. a misread year/digit) — it is never actually called anywhere in the codebase. Dead code.
  - Model: this app uses `meta-llama/llama-4-scout` (`lib/config.js` `MODEL_ROUTES.visionDefault`) — a lightweight/free-tier vision model, chosen for cost. A stronger competing OCR tool reading the same receipt correctly is very likely a genuine model-capability gap, not a code bug. `visionEscalate` (meant for exactly this — retry with a stronger model on low confidence) is currently pointed at the SAME cheap model, i.e. no real escalation path exists today.
  - Presented 3 options to Barat (flag-only / add paid escalation model / switch default model entirely) — he asked to park the whole date/duplicate-detection item for now rather than decide today.
- Status: OPEN (investigated in depth, root cause + dead-code gap identified, decision deferred at Barat's request — see the 3 options above when he's ready to revisit)

### 6. Redesign the "Expense Captured" edit-flow messaging
- File: `lib/bot.js` (post-capture message flow)
- Issue: editing a field after capture sends a growing chain of separate messages instead of updating in place.
- Findings (2026-08-22): the EXISTING category-edit flow (`catedit:`/`catpick:` callbacks) already correctly uses Telegram's `editMessageText` in place (`messageId` is always available on a callback-query tap) — that specific path is not the bug. The report's larger ask — editing merchant/date/amount directly from the bot chat — does not exist as a feature at all yet; it's a net-new UI/UX build, not a fix to existing behavior, and the report references a screenshot mockup that didn't come through as readable data (image only, no OCR'd text). Held off building this blind to avoid guessing the wrong interaction design and risking a regression in the currently-working category-edit flow.
- Fix needed: needs the actual reference screenshot/mockup, or a written description of the exact intended flow, before this can be built safely.
- Status: OPEN (investigated; category-edit-in-place already works correctly; merchant/date/amount editing is unbuilt net-new scope — blocked on reference material from Barat)
