# Backend Issues Log

Backend/bot-logic issues reported but NOT fixed by Claude (frontend-only scope on this project — see project memory "Receipt SaaS: Frontend Only"). Records only — no general docs here.

**Workflow rule (2026-08-23, from Barat):** whoever fixes an item below — push the fix to GitHub, open a PR to `main` (direct pushes are hook-blocked anyway), and update that item's entry here with what was actually changed and how, before considering it done. Don't fix silently. See `docs/WORKLOG.md`'s 2026-08-23 entry for the full handoff note, including a file-ownership flag on items #1/#2/#3/#6.

---

## 2026-08-23 — QA report from Barat

### 1. "Ask your admin" message shown to personal (non-business) accounts
- File: `lib/bot.js` — `bindWithToken()` (~line 164), `BUSINESS_UNBOUND_MESSAGE` (~line 240)
- Issue: link-binding error messages ("not valid" / "expired" / "already used") all say "ask your admin" — written for the multi-staff business bot. Personal accounts have no admin; every user owns their own account.
- Fix needed: branch the message text by account type; personal accounts should never mention an admin.
- Status: OPEN

### 2. Guest Mode auto-logout after first receipt + no per-device cap
- Files: `lib/bot.js`, `lib/account.js`, `routes/guest.js`
- Issue: guest session drops back to the login screen right after upload #1, so a guest can keep starting new guest sessions forever, burning OCR/API credits each time.
- Fix needed:
  - Trace and fix the guest-session logic causing the early logout.
  - Make `GUEST_RECEIPT_CAP` (currently 4, `lib/ocr.js:379`) persist per device/IP across sessions, not just within one session.
  - After the cap is hit, show a "sign up to continue" message instead of allowing another guest session.
- Status: OPEN

### 3. Bot should restrict replies after guest trial ends
- File: `lib/bot.js`
- Issue: after a guest is capped, the bot still replies normally to anything sent.
- Fix needed: once capped, reply with ONLY "access the app now and connect again with the app link" — ignore everything else from that chat.
- Status: OPEN

### 4. Duplicate-receipt detection not triggering on re-upload
- File: `lib/ocr.js` — `assembleExpense()` (~line 391), duplicate check (~495-505, ~614-620)
- Issue: re-uploading an already-saved receipt should hit the existing exact-match duplicate check (merchant+amount+date) and get rejected — a live test saved it as a new entry instead.
- Fix needed: debug why the match isn't firing on this path — check field-matching tolerance (OCR variance) and whether `rejectDuplicates` is actually passed `true` on this code path.
- Status: OPEN

### 5. OCR misreads dates even on clear photos
- File: `lib/ocr.js` (same extraction pipeline as #4)
- Issue: date extraction sometimes fails on well-lit, clear receipts, forcing a manual date prompt.
- Fix needed: review the date-parsing prompt/logic for the actual date formats/positions seen on real (Malaysian) receipts.
- Status: OPEN

### 6. Redesign the "Expense Captured" edit-flow messaging
- File: `lib/bot.js` (post-capture message flow)
- Issue: editing a field after capture sends a growing chain of separate messages instead of updating in place.
- Fix needed: use Telegram's `editMessageText`/`editMessageCaption` to replace the original "Expense Captured" message with the updated one, instead of sending new messages.
- Status: OPEN
