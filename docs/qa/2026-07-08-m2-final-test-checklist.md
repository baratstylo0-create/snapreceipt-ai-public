# M2 Final-Test Checklist — Premala (business) end-to-end + M1 regression
> 2026-07-08 (Claude, for Barat). Run this to validate the product before customer handoff.
> Two things a "final test" needs that we don't have yet: **(A)** the latest code on `main`, and **(B)**
> the business instance actually reachable by Telegram (a public HTTPS webhook). Both are in §0 below.

## 0. Pre-test setup — MUST be true before any step below works
- [ ] **Merge PR #139** (business Today's Bills: staff-name lines + delete-by-number) so the test runs the
      final code. (#140/#141 are docs — optional for the test.) Then `git pull` on the host.
- [ ] **Business instance running & reachable by Telegram.** The bot needs a **public HTTPS URL** for its
      webhook — either deploy Premala per `docs/ops/2026-07-08-deploy-runbook.md` (Render), or run locally
      behind a tunnel. `.env` must be the **Premala profile**:
      `ACCOUNT_TYPE=business`, `CAP_MULTI_USER=CAP_COMPANY_DIMENSION=CAP_PETTY_CASH=CAP_BRANCH_SUBMISSION=true`,
      `CAP_LIVE_MASTER_MERGE=CAP_EXCEL_LITE_GRID=false`, Premala Supabase creds (`xurnpvesgcybrnilxszf`),
      a Telegram `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ALLOWED_CHAT_IDS` (the test chat ids).
- [ ] **Webhook registered** (`getWebhookInfo` shows the URL + `secret_token` set, no last-error).
- [ ] **Admin data seeded IN the product** (admin logs in, changes the provisioned password, then creates):
      at least **1 company**, **≥2 branches**, a few **staff** per branch, a **petty-cash float** per branch
      for this month, and an imported **category template** (chart of accounts) per company.

## 1. Business bot — clerk flow (the core deliverable)
- [ ] Clerk taps `/start <token>` → "bound to <branch> as clerk". Re-tapping = harmless.
- [ ] Clerk sends a **receipt photo** → bot reads it (merchant/amount/date) → **"which staff?"** picker → tag a staff → confirmed.
- [ ] Send **several photos at once** (album) → all logged, one summary.
- [ ] Send a **PDF** → read the same way.
- [ ] **📋 Today Bills** → each line shows the **staff name** (not category); total correct.
- [ ] **🗑️ Delete a bill** → bot asks for a number → type it → "Bill deleted". Confirm: a **wrong/other-chat number** is refused, and after any number the button must be **re-tapped** to delete again (single-use).
- [ ] **💰 Today Expenses** / **📅 Weekly Record** → branch-scoped totals (Sun-start week for business).

## 2. Business bot — isolation (SECURITY — must pass)
- [ ] Clerk A cannot see or delete Clerk B's (other branch) bills via the bot.
- [ ] Admin bot sees **all branches'** bills; admin captures tag to Head Office.

## 3. Dashboard — clerk vs admin
- [ ] Clerk logs in → sees **only their branch's** expenses / reports / Excel export / receipt images. Trying another branch's receipt-by-id → not found/forbidden.
- [ ] Clerk **"Send to Admin"** (branch submission) → lands in the admin's dashboard with who/branch/period.
- [ ] Admin login → **reports/analysis across branches**; **review queue** approve/reject works; rejected rows never appear in exports/totals.

## 4. Petty-cash Monthly Statement (Premala's headline deliverable)
- [ ] Admin sets a float, adds cash-in, has some expenses for a branch×month.
- [ ] Export the **Monthly Statement** in **Excel AND PDF**: opening float + cash-in + expenditure + balance all correct; **receipt snapshots embedded/appended**; category banners from the company's chart of accounts.
- [ ] **No `#REF!` / no sign errors** (a negative balance = claim owed; our maths, not the sample's).
- [ ] Visual diff vs Premala's sample format (`docs/specs/2026-07-06-petty-cash-statement-format.md`).
- [ ] A **company-clerk** with legacy (pre-company) rows still sees their opening float (null-tolerant filter, #134) — no silently-empty statement.

## 5. Excel export (general)
- [ ] Branch/Staff columns present; receipt images embedded; Total row width correct (no `####`, #129); currency right.

## 6. M1 personal regression (quick — must stay byte-for-byte)
- [ ] On a **personal** instance (`CAP_MULTI_USER` off): photo → OCR → save; **Today Bills shows category + per-bill ❌ buttons** (NOT staff names / not the single Delete button); dashboard upload → list → edit → Excel/PDF/reports/agent chat all work.

## 7. Pre-LAUNCH gates (do AFTER the test passes, before a real customer — NOT test blockers)
- [ ] Rotate secrets: `DASHBOARD_TOKEN`, `GROQ_KEYS`, Supabase keys (ADR-015 launch gate).
- [ ] Enable **Groq Zero-Data-Retention** on Premala's Groq account (remaining #107 slice).
- [ ] Independent Supabase **backup** held outside Barat's account.
- [ ] Reset rate limits from demo-high back to sane backstops (`UPLOAD_RATE_MAX` etc.).
- [ ] Confirm production `BOT_TOKEN`/`WEBHOOK_SECRET`/`ALLOWED_CHAT_IDS` are the customer's, not dev.

## Known non-blocking follow-ups (won't fail the test)
- #17 template label sanitize-at-render (render already escapes), #31 per-image Telegram links (Jeevan),
  M2 session-token expiry/rotation, "edit the Today-Bills message in place on delete" polish.
