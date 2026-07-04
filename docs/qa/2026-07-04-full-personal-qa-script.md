# Full Personal-Account QA Script (M1) — 2026-07-04

> **Purpose:** every feature, both surfaces (dashboard + Telegram bot), happy path + edge cases +
> security, in one script. Owner and Barat both run this independently against the **same live
> account** (shared Supabase `xurnpvesgcybrnilxszf`). Supersedes the older per-surface plans in
> `docs/qa/` for day-to-day testing — those remain as historical reference for the P5/P6 build.
>
> **State as of this script:** both pending DB migrations (voucher reference numbers, category-
> corrections upsert) have been run live. `main` has: line-item categorization, the dashboard +
> bot category-picker ("ask when uncertain"), durable receipt-image storage (dashboard uploads
> now show an image), the persistent bot menu (Today Bills/Today Expenses/Weekly Record/Bot
> Guide), voucher numbers (`RC-YYYY-NNNN`), in-chat delete, and all P4 backend features.

## 0. Before you start

- [ ] `git pull` on `main`, `npm install`.
- [ ] Server running (`npm start`) against the **real** `.env` (real Supabase + Groq + `BOT_TOKEN`).
- [ ] Dashboard: open the URL, enter the real `DASHBOARD_TOKEN` at the gate.
- [ ] Telegram: have the bot chat open on your phone (message it if you've never `/start`ed it).
- [ ] Have 3–5 **real or realistic** receipt photos ready, at least one with **multiple line items**
      (e.g. a grocery/hardware receipt with food + a non-food item), one in a **non-MYR currency**
      if you have one, and one **deliberately blurry/unrelated photo** (e.g. a selfie) for the
      rejection tests. A **multi-page PDF** receipt if you have one.
- [ ] **Two testers, if possible** (Owner + Barat, different Telegram accounts) — several rows below
      need a second identity to prove per-user scoping (delete ownership, chat-id scoping).

Log every result inline (✅ / ❌ + one-line note). Anything ❌ → tell me the exact steps + what you
saw, screenshot if it's visual.

---

## 1. Dashboard — Upload → OCR → Save

| # | Test | Expected |
|---|---|---|
| 1.1 | Upload a single clear receipt photo | 200 response, appears in Activity within seconds; merchant/date/amount look right |
| 1.2 | Upload **3+ photos at once** (multi-select) | One summary; all save (or a clear per-photo reason for any that don't) |
| 1.3 | Upload a **PDF** receipt | Renders/reads like a photo; saves correctly |
| 1.4 | Upload a **blurry/unreadable** photo | Rejected with an honest "blurry, resend" message — **not saved as junk** |
| 1.5 | Upload a **clearly unrelated photo** (selfie, screenshot) | Rejected with a "doesn't look like a receipt" message — **not saved** |
| 1.6 | Upload **11+ images at once** (over the cap) | 413 — clear "too many images" error, nothing partially processed |

## 2. Dashboard — Activity list, filter, sort

| # | Test | Expected |
|---|---|---|
| 2.1 | Open Activity — all your expenses list | Table view by default; correct merchant/date/amount/category/status columns |
| 2.2 | Switch to **Cards** view | Same rows, card layout, receipt thumbnails load where present |
| 2.3 | Search by merchant name | Only matching rows show |
| 2.4 | Search by remark text | Matches remarks too |
| 2.5 | Filter by status (saved/needs_review/approved/rejected) | Only that status shows |
| 2.6 | Filter by category | Only that category shows |
| 2.7 | Date range filter (From/To) | Only rows in range |
| 2.8 | Sort by date asc/desc, amount asc/desc | Order changes correctly |
| 2.9 | Pagination (if >20 rows) | Prev/Next work, page count correct |

## 3. Dashboard — Edit / Delete

| # | Test | Expected |
|---|---|---|
| 3.1 | Open a row's edit drawer | All fields populated |
| 3.2 | Edit amount to include **cents** (e.g. `21.20`) and Save | **Saves successfully** (this was a real bug — silently failed before the fix) |
| 3.3 | Edit merchant/date/category/remark, Save | Updates persist, table reflects instantly |
| 3.4 | Delete a row (soft-delete) | Disappears from Activity immediately |
| 3.5 | Refresh the page after edit/delete | Changes persisted server-side, not just local state |

## 4. Categories — receipt-level + per-line-item

The real 18: `Meals & Entertainment, Groceries, Fuel & Auto, Travel, Lodging, Software & Subscriptions, Office Supplies, Utilities, Rent & Lease, Professional Services, Marketing & Advertising, Inventory & COGS, Equipment & Hardware, Shipping & Postage, Bank & Fees, Healthcare, Education & Training, Others`

| # | Test | Expected |
|---|---|---|
| 4.1 | Upload a normal single-purpose receipt (e.g. a restaurant bill) | Auto-categorized sensibly (e.g. Meals & Entertainment) |
| 4.2 | Upload a **mixed receipt** (e.g. groceries + a hardware item on one bill) | Open the drawer's "Line items" section — **each line shows its own category pill**, not all forced into one bucket |
| 4.3 | Edit a row's category manually to something clearly wrong on purpose, then fix it back | Confirms the category dropdown covers the full 18-list, not a stale 5-name set |
| 4.4 | Filter Activity by each of a few different categories | Filter actually narrows to that category |

## 5. Category picker — "ask when uncertain" (dashboard AND bot)

This only triggers when the categorizer is genuinely unsure — may not happen on every receipt.
If you don't hit it naturally after a few uploads, that's fine (report N/A), but try an odd/unusual
merchant name or line-item description to increase the odds.

| # | Test | Expected |
|---|---|---|
| 5.1 | (Dashboard) Upload something the categorizer can't confidently place | A **"Needs a category"** section appears (amber), separate from the review queue |
| 5.2 | Pick a category from the dropdown, click **Save category** | Resolves, section disappears, row shows the picked category + status `saved` |
| 5.3 | (Bot) Send a photo the categorizer can't confidently place | Bot replies "🤔 I'm not sure what category this is" with category buttons |
| 5.4 | Tap a category button | Bot confirms "✅ Saved as \<category\>" |
| 5.5 | (Bot) Trigger it again, this time tap **"📝 Others (type a note)"** | Bot asks you to type a short note; typing anything resolves it as Others + your remark |

## 6. Currency (MYR account)

| # | Test | Expected |
|---|---|---|
| 6.1 | Every new receipt shows amounts in **MYR** | No stray `$`/USD anywhere on new rows |
| 6.2 | Upload a receipt in a **different printed currency** (if you have one) | Row shows converted MYR amount; drawer/badges show the original currency + FX rate |
| 6.3 | Ask the AI agent (§9) a spend question | Answers in **MYR**, never `$` |

## 7. Voucher / reference numbers (RC-YYYY-NNNN)

| # | Test | Expected |
|---|---|---|
| 7.1 | Upload a new receipt | Dashboard shows a `RC-2026-NNNN`-style reference somewhere on the row/drawer |
| 7.2 | Check a few **old** rows (from before this feature) | They now also have a `voucher_no` (backfilled) |
| 7.3 | Upload **3 receipts in one batch** | All 3 get **distinct, sequential** reference numbers — no duplicates, no gaps-that-shouldn't-be-there |
| 7.4 | (Bot) Send a single photo | Telegram reply includes a `🔖 Ref: RC-2026-NNNN` line |

## 8. Receipt images — click-to-view

| # | Test | Expected |
|---|---|---|
| 8.1 | Open the drawer for a **dashboard-uploaded** receipt | The actual receipt image renders (this was broken before today — confirm it now works) |
| 8.2 | Open the drawer for a **Telegram-uploaded** receipt | Image renders (via Storage if uploaded after today's fix, or the Telegram fallback for older ones) |
| 8.3 | Open the drawer for a very old row with no image at all | Shows "No receipt image on file" — no crash, no broken image icon |
| 8.4 | Open browser dev tools console while viewing an image | **Zero CSP errors** in the console |

## 9. Excel export

| # | Test | Expected |
|---|---|---|
| 9.1 | Click Export / download Excel from Reports (or wherever it lives) | Downloads a real `.xlsx` |
| 9.2 | Open the file | Rows match what's in Activity — merchant, date, amount, currency, category, voucher_no |

## 10. AI agent chat

| # | Test | Expected |
|---|---|---|
| 10.1 | Ask "what's my total spend this month?" | Answers with a real number, in MYR |
| 10.2 | Ask "who are my top merchants?" | Lists real merchants from your data |
| 10.3 | Ask something with no relevant data (e.g. a category you've never used) | Says so plainly — never invents numbers |
| 10.4 | Ask a nonsense/off-topic question | Politely declines or redirects, doesn't crash |

## 11. Reports tab

| # | Test | Expected |
|---|---|---|
| 11.1 | Open Reports | Totals + per-category breakdown, numbers match what you'd hand-calculate from Activity |
| 11.2 | Change any period filter (if present) | Numbers update correctly |

## 12. Review queue (anomalies)

| # | Test | Expected |
|---|---|---|
| 12.1 | Upload the **exact same receipt photo twice** | Second one gets flagged as a likely duplicate, appears in the Review queue |
| 12.2 | Click **Approve** on a flagged row | Moves to `approved`, disappears from the queue |
| 12.3 | Upload another duplicate, click **Reject** | Moves to `rejected` |

## 13. Auth / security (dashboard)

| # | Test | Expected |
|---|---|---|
| 13.1 | Open the dashboard in an incognito/private window (no stored token) | Blocked at the token gate, no data leaks before entering it |
| 13.2 | Enter a **wrong** token | Rejected, stays on the gate |
| 13.3 | Enter the **correct** token | Full access |
| 13.4 | Try to fetch `yourserver/receipt/by-id/<any-id>` directly in a new tab with no token | 401, not the image |

## 14. Telegram bot — core flow

| # | Test | Expected |
|---|---|---|
| 14.1 | Send `/start` (fresh chat, or re-send) | Welcome message + a **persistent menu bar** appears at the bottom: 📋 Today Bills · 💰 Today Expenses · 📅 Weekly Record · 🧭 Bot Guide |
| 14.2 | Tap **🧭 Bot Guide** | Explains every feature in plain language |
| 14.3 | Send a single receipt photo | "✅ Expense Captured" with merchant/date/total/category + voucher ref |
| 14.4 | Send **an album of 3+ photos at once** | One combined summary, per-receipt breakdown |
| 14.5 | Send a PDF | Reads it like a photo, gives a matching summary |
| 14.6 | Send a blurry photo | Honest "resend a clearer shot" — not saved |
| 14.7 | Send a clearly-not-a-receipt photo | Honest "doesn't look like a receipt" — not saved |
| 14.8 | Type "show expenses" (or "spent"/"total"/"summary") | Gets your expense summary |

## 15. Telegram bot — menu bar features

| # | Test | Expected |
|---|---|---|
| 15.1 | Tap **📋 Today Bills** | Lists every bill captured **today** (by upload time, not the date printed on the receipt), with a ❌ delete button per line |
| 15.2 | Upload a receipt with an **old printed date** (e.g. a March receipt photographed today) | It **still appears** in Today Bills (this was a real bug — confirm the fix) |
| 15.3 | Tap **💰 Today Expenses** | Just today's total, correct count + amount |
| 15.4 | Tap **📅 Weekly Record** | This week's (Monday→today) total |
| 15.5 | Tap ❌ on a bill **you submitted** in Today Bills | Confirm prompt appears |
| 15.6 | Confirm the delete | Bill is removed; message edits in place (not a new message stacked below) |
| 15.7 | (If a 2nd tester is available) Tap ❌ on a bill **someone else submitted** | "Only the person who submitted that bill can delete it" — refused |

## 16. Telegram bot — delete flow (typed)

| # | Test | Expected |
|---|---|---|
| 16.1 | Type "delete" | Bot shows your most recent receipt with Yes/Cancel buttons |
| 16.2 | Tap **Cancel** | Prompt edits to a cancelled state, nothing deleted |
| 16.3 | Type "delete" again, tap **Yes, delete it** | Confirms deletion, edits in place |
| 16.4 | Type "delete" with nothing to delete (or after deleting your only recent one) | Handles gracefully, no crash |

## 17. Multi-tester / scoping (skip if solo)

| # | Test | Expected |
|---|---|---|
| 17.1 | Both testers send receipts from their own Telegram accounts | Both show up in the same shared dashboard (single-account v1 — expected) |
| 17.2 | Tester A tries to delete Tester B's bill via ❌ | Refused (see 15.7) |
| 17.3 | Tester A types "delete" | Only affects Tester A's own most recent receipt, never Tester B's |

## 18. Sign-off

| Tester | Date | Sections run | Pass/Fail summary | Notes |
|---|---|---|---|---|
| Jeevan (Owner) | | | | |
| Barat | | | | |

**If everything above is ✅:** personal-account M1 is solid — ready for the Owner's sign-off to move
toward M2 (Mugi's production frontend + business features).
**If anything is ❌:** report exact steps + what you saw (screenshot if visual) so it can be fixed
before sign-off.
