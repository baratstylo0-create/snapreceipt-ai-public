# Dashboard M1 — Live Human Test Session Runbook

> **Owner:** Jeevan (J1) · **Companion to:** `docs/qa/2026-07-02-m1-manual-test-plan.md` (the
> checklist this runbook drives). **Not a checklist itself** — no test rows are duplicated here.
> This is the step-by-step "how to actually sit down and run it, once, for real" script.

## 1. Purpose

`docs/qa/2026-07-02-m1-manual-test-plan.md` is the fool-proof per-feature checklist for the
dashboard (`public/`). It assumes a real server is already running against real credentials and
that test data already exists. This runbook is the missing piece: the exact commands to stand up
that real server on a PC, the exact steps to seed the data the checklist's happy/boundary rows
need, and the exact order to execute the checklist's 11 feature sections so nothing is tested out
of sequence — ending in a consolidated PASS/FAIL sign-off. Run this once, on a real machine, with
real Supabase/Groq/Telegram credentials, before M1 ships (merge of `feature/jeevan-p5-frontend` to
`main`).

This is a **dashboard-only** session. The Telegram bot has its own parallel runbook-equivalent
(Barat runs `docs/qa/2026-07-02-telegram-bot-manual-test-plan.md` separately, over a real Telegram
chat). The two surfaces share the fixture set in `docs/qa/fixtures/` so a bug found on one side can
be cross-checked on the other, but they are independent live sessions — you do not need Barat's
session running to complete this one (Telegram is only needed here if you want to seed data via
real bot photos instead of the dashboard Upload screen; see §4).

---

## 2. Prerequisites

### 2.1 Machine
- **Node.js ≥ 20** (`node -v`) — the codebase uses native `fetch`/`Buffer`, no polyfills.
- A **desktop browser**: Chrome, Firefox, or Edge (the dashboard is desktop-only per the checklist's
  §0.1 note — do not test this on a phone/tablet emulator).
- The repo checked out on **`feature/jeevan-p5-frontend`** (confirm with `git branch --show-current`
  before starting — do not run this session against `main`).

### 2.2 Install dependencies
```bash
cd receipt-analyser-saas
npm install
```

### 2.3 Real `.env`
```bash
cp .env.example .env
```
Then fill in **every** variable below with a real value — this is a live security test, so nothing
may be mocked or left as a dev placeholder. Variable names and defaults below are taken directly
from `.env.example` / `lib/config.js`; do not invent new ones.

| Var | Required for this session | Where to get it |
|---|---|---|
| `BOT_TOKEN` | Yes (server won't start clean without it — see §7) | Telegram → message **@BotFather** → `/newbot` → follow prompts → copy the bot token. |
| `GROQ_KEY` | Yes | https://console.groq.com/keys — create a key. |
| `SB_URL` | Yes | Supabase project → **Settings → API → Project URL** (no trailing `/rest/v1`). |
| `SB_KEY` | Yes | Supabase project → **Settings → API → service_role key** (NOT the anon key — server-side only, never shipped to the browser). |
| `PUBLIC_URL` | Optional — only if you also want Telegram delivering webhooks during this session (parallel to Barat's bot session) | Your public HTTPS URL (e.g. `npx ngrok http 3001`, or a real domain). Leave blank to skip; you can still seed data entirely via the dashboard Upload screen (§4). |
| `WEBHOOK_SECRET` | Optional (only relevant if `PUBLIC_URL` is set) | Any random string you choose. |
| `DASHBOARD_TOKEN` | **Required — set a real strong random token** | Generate one yourself, e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. This is the token you'll type into the dashboard's gate screen (Feature 1). |
| `AUTH_REQUIRED` | **Set to `true`** | This is what forces the fail-closed auth path (`checkDash`) to actually gate every route the way production does. Without it, in dev, an unset/blank token silently falls back to permissive access and Feature 1 / 4.9 / 4.10 / 6.5 / 6.6 cannot be tested honestly. |
| `DASHBOARD_ORIGIN` | Recommended | `http://localhost:3001` (matches where you'll run the server) — tightens CORS per checklist row 11.3. |
| `DASH_AUTH_RATE_MAX` | Leave default (`60`) unless you want to test row 11.5 with a smaller number to save time | `.env.example` default. |
| `UPLOAD_RATE_MAX` | Leave default (`20`) | `.env.example` default — needed as-is for row 7.16. |
| `AGENT_RATE_MAX` | Leave default (`20`) | `.env.example` default — needed as-is for row 10.10. |
| `ACCOUNT_ID` | Leave default (`default`) | No reason to change for this session. |
| `DEFAULT_CURRENCY` | Leave default (`USD`) or set to your test currency | Affects formatting checks in Feature 2/9. |
| `PORT` | Leave default (`3001`) | Matches every URL in this runbook; change only if 3001 is taken locally, and adjust all URLs below accordingly. |

Leave `DEFAULT_TAX_RATE`, `ACCOUNT_TYPE`/`CAP_*`/`BUSINESS_TYPE`, model-routing vars
(`VISION_MODEL`, etc.), `FX_API_*`, `RETENTION_DAYS`, `AGENT_MODEL`/`AGENT_MAX_TOKENS`, and
`MASS_MAX_IMAGES` at their `.env.example` defaults — the checklist doesn't require overriding
them, and changing them risks invalidating the "real production posture" goal of this session.

**Database schema:** if this Supabase project has never had this app's schema applied, run
`schema.sql` once via the Supabase SQL editor before starting the server (see repo root
`README.md` §2). If you're reusing an existing seeded project, skip this.

---

## 3. Starting the server

```bash
npm start
```

This runs `node server.js`. Watch the console for:
- No `[FATAL] Missing env var: …` lines (see §7 if you see one — these come from `assertConfig()`
  in `lib/config.js`, which checks `BOT_TOKEN`, `GROQ_KEY`, `SB_URL`, `SB_KEY`).
- If `PUBLIC_URL` is set, a webhook auto-registration line. If not set, that's expected to be
  skipped — fine for a dashboard-only session.

**Confirm it's up:**
```bash
curl localhost:3001/health
```
Expected: `{"ok":true,"service":"receipt-saas","account":"default"}` (the `account` value reflects
your `ACCOUNT_ID`). This endpoint is defined in `routes/misc.js` and is intentionally unauthenticated
(it's the only route allowed to be `*`-CORS per checklist row 11.3).

**Open the dashboard:** browse to **http://localhost:3001** (or `http://localhost:<PORT>` if you
changed `PORT`). With `AUTH_REQUIRED=true` and a `DASHBOARD_TOKEN` set, you should land straight on
the token-entry gate screen — that's Feature 1, row 1.1, your very first checklist row.

---

## 4. Seeding test data — two-pass structure

Several checklist rows require an **empty account** (fresh/no-data states), and most other rows
require a **populated account**. Because seeding is one-way (there's no "unseed" button short of
truncating the table), run the checklist in **two passes**:

### Pass A — empty-state rows (run BEFORE seeding anything)
On a freshly-migrated / never-seeded Supabase project, with the server up and the gate passed,
capture these rows first while the account still has zero expenses:
- **2.3** (Overview empty state)
- **3.9** (Activity empty — no expenses yet)
- **5.4** (Review queue empty — "Nothing to review")
- **8.5** (Manage/Templates empty — default field set, no template imported yet)
- **9.5** (Reports empty — no expenses for the period)

If your Supabase project already has old expense rows from prior dev work, either point `SB_URL`/
`SB_KEY` at a clean project for this session, or manually clear the `expenses` table for
`account_id = 'default'` (via the Supabase SQL editor) before Pass A. Do this before touching
Upload or Templates.

### Seeding step (between Pass A and Pass B)
Once Pass A's empty-state rows are recorded, populate the account:

1. **Import a template CSV** (needed for Feature 8's non-empty state and to feed Feature 9's
   category-derived-from-FieldSpec row 9.10 later): in the dashboard, go to **Manage**, paste a
   small valid CSV header row into the textarea (or use **Or choose a CSV file**), give it a name,
   click **Import template**. This is `POST /api/templates` under the hood.
2. **Get real expenses into the account.** Two options — pick whichever fixtures you have ready
   (see `docs/qa/fixtures/README.md` for what's committed vs. what a human must add):
   - **Option A — via the Telegram bot** (only if you set `PUBLIC_URL`/webhook per §2.3): send
     3–5 real receipt photos to your bot in a real Telegram chat. Each becomes a row visible on
     the dashboard within seconds.
   - **Option B — via the dashboard Upload screen** (no Telegram needed): go to **Upload**, drag
     the fixture images/PDFs from `docs/qa/fixtures/` onto the drop zone (or **Choose files**),
     click **Upload**. This is `POST /api/upload`.
   - Either way, also seed the **specific badge cases** the checklist needs:
     - **one blurry/low-confidence receipt** → lands in the review queue (`status=needs_review`),
       carrying the "low conf" and/or "review" badge (feeds 5.1/5.9).
     - **one foreign-currency receipt** (e.g. EUR against a USD account) → produces the `fx` badge
       (feeds 5.9, 2.x cross-checks).
   - If binary fixtures (`receipt-clean.jpg`, `receipt-blurry.jpg`, `receipt-injection.png`,
     `invoice-1page.pdf`, `too-many.pdf`, `oversized.pdf`, `encrypted.pdf`, `corrupt.pdf`, etc.)
     are not yet present under `docs/qa/fixtures/` — check `docs/qa/fixtures/README.md`'s "Binary
     fixtures (a human must add)" list first. Add them to that folder before this step (reuse
     `tests/fixtures/pdf/*` where the README notes overlap). This runbook assumes you've done that
     add as part of today's session; if not, add them now before continuing.
3. **Bake in the adversarial text fixtures** you'll need for Features 3/4/5/8/9/10's XSS/injection
   rows — these don't need to be seeded in advance in bulk; you'll paste them live during Pass B
   (Feature 3.14–3.16, 4.11, 5.8, 8.8, 9.10, 10.8–10.9) directly from `docs/qa/fixtures/hostile-merchant.txt`,
   `hostile-headers.csv`, and `agent-injection.txt` into the relevant field/import/chat box as you
   reach that row.
4. Confirm seeding worked: reload **Activity** — you should see your 3–5+ rows, at least one with
   a "review" badge and one with an "fx" badge.

### Pass B — everything else (run AFTER seeding)
All remaining rows in Features 1–11 (happy path, boundary, error, and adversarial cases) now have
the non-empty state they need. Continue to §5 for the full execution order.

---

## 5. Execution order

Work through `docs/qa/2026-07-02-m1-manual-test-plan.md` in this order. Section numbers/names below
are exactly as they appear in that file — do not renumber or reinterpret them.

1. **Open DevTools first** (F12), Console + Network tabs, and leave them open for the entire
   session (checklist prerequisite §5 / the "never-leak" and "no-execution" rules apply to every
   row).
2. **Feature 1 — Auth gate.** Run this first, in full, including the empty-account state — it gates
   everything else and several of its rows (1.7 "server down", 1.3 "empty field") don't depend on
   seeded data.
3. **Pass A empty-state rows** (§4 above): **2.3, 3.9, 5.4, 8.5, 9.5** — capture these now, before
   seeding, while the account is genuinely empty.
4. **Seed the data** per §4's seeding step.
5. **Feature 2 — Overview**, remaining rows (2.1, 2.2, 2.4–2.7).
6. **Feature 3 — Activity: table/cards/filters/search/sort/pagination**, happy + boundary rows
   first (3.1–3.8, 3.10–3.13), **adversarial rows last within this section** (3.14–3.16 — stored
   XSS in table/cards, RTL/emoji/control chars).
7. **Feature 4 — Activity: detail drawer + PATCH + DELETE**, happy/boundary/error rows first
   (4.1–4.8), adversarial last (4.9 no account_id in PATCH body, 4.10 IDOR, 4.11 line-item XSS).
8. **Feature 5 — Review queue**, happy/empty/error/boundary rows first (5.1–5.3, 5.5–5.7, using the
   review-badge rows you seeded), then 5.8 (hostile anomaly reason) and 5.9 (badge confirmation)
   last.
9. **Feature 6 — Receipt image proxy**, happy/empty/error first (6.1–6.4), adversarial last (6.5
   unauth direct hit, 6.6 wrong token — these are Critical/High must-pass rows).
10. **Feature 7 — Upload**, happy/boundary/error rows first (7.1–7.13), adversarial last (7.14
    filename XSS, 7.15 summary XSS, 7.16 rate limit — Critical/High).
11. **Feature 8 — Manage/Templates**, happy/empty/error first (8.1–8.4, 8.6–8.7 — 8.5 already done
    in Pass A), adversarial last (8.8 hostile CSV headers — Critical/High, 8.9 rate limit).
12. **Feature 9 — Reports**, happy/boundary/error first (9.1–9.4, 9.6–9.9 — 9.5 already done in
    Pass A), adversarial last (9.10 category XSS).
13. **Feature 10 — Agent chat**, happy/empty/boundary first (10.1–10.4, 10.6–10.7), error next
    (10.5), adversarial last (10.8 prompt injection, 10.9 output XSS, 10.10 rate limit — all
    Critical/High).
14. **Feature 11 — Cross-cutting security** (headers/CSP/CORS/no-leak/gate brute-force) — run this
    section **last of all**, after every other feature has been exercised, since it's a final sweep
    over headers and behavior you've already been observing throughout (11.1–11.4), plus one
    dedicated brute-force row (11.5 — Critical/High, gate rate limit).

**Why adversarial-last within each section:** hostile inputs are designed to break rendering, leak
data, or degrade the server. Running happy-path and boundary rows first in each section establishes
a clean baseline so that if an adversarial row does cause visible breakage, you can tell it was
caused by that specific payload and not by pre-existing bad state.

---

## 6. Recording results

- Do **not** duplicate checklist rows into this runbook. Instead, fill in **Actual / Result /
  Note** directly inside `docs/qa/2026-07-02-m1-manual-test-plan.md` as you go — or, to keep the
  original clean, make a dated working copy first (e.g.
  `docs/qa/2026-07-02-m1-manual-test-plan.RESULTS-2026-07-03.md`) and fill that in instead.
- Use the checklist's own legend: ✅ pass · ❌ fail · ⚠️ pass-with-note.
- **Screenshot every failure** (❌) and every pass-with-note (⚠️) — reference the screenshot
  filename in the row's Note column. Save screenshots alongside your results file (e.g. a
  `docs/qa/2026-07-03-screenshots/` folder) so they travel with the results.
- For any leak (stack trace, file path, token, key, cross-account data) or any script execution
  on an adversarial row, stop, screenshot the DevTools console AND the network response body, and
  note it as Critical regardless of which row it happened on.
- This runbook only sequences the rows — the row-level detail (Steps/Expected) lives solely in the
  checklist file. Keep both files together when filing issues.

---

## 7. Troubleshooting

**Server won't start / exits immediately with `[FATAL] Missing env var: …`**
`assertConfig()` in `lib/config.js` checks `BOT_TOKEN`, `GROQ_KEY`, `SB_URL`, `SB_KEY` on startup
and logs (but does not hard-exit on) any that are blank. If you see this line, one of those four is
empty in `.env` — go back to §2.3, fill it in, restart `npm start`. Note this check does NOT cover
`DASHBOARD_TOKEN`/`AUTH_REQUIRED` — the server will start fine without them, but then Feature 1's
fail-closed behavior won't actually be under test (see next item).

**Every `/api/*` call returns 401, even right after entering the token**
Almost always a mismatch between the `DASHBOARD_TOKEN` value in `.env` (loaded at server start) and
what you typed into the gate screen. Things to check:
- Did you restart `npm start` after editing `.env`? (`dotenv` loads once at process start —
  edits require a restart.)
- Extra whitespace/newline pasted into the gate's token field or into `.env`.
- Confirm `GET /api/config` (unauthenticated, `routes/expenses.js`) reports
  `"auth_required": true` — if it reports `false`, `DASHBOARD_TOKEN` is empty server-side and the
  gate is being bypassed entirely (re-check §2.3, then restart).

**Overview / Activity / Reports all show "No expenses yet…" and you expected data**
This is correct and expected during **Pass A** (§4) — don't treat it as a bug before you've seeded.
If you're past the seeding step and still seeing empty states: confirm the upload/bot send actually
returned success (check the Upload screen's batch summary, or the bot's reply), confirm you're
looking at the same `ACCOUNT_ID` the server is scoped to (`.env` `ACCOUNT_ID`, default `'default'`
— all seeded rows are scoped to this), and confirm `SB_URL`/`SB_KEY` point at the same Supabase
project you seeded into (not a stale/different project from earlier dev work).

**Groq OCR calls fail with 502 during seeding (not intentionally testing 7.12)**
Groq's free tier is rate-limited (429s); the codebase already retries with exponential backoff
(`groqChat()`), but if you're seeding many images back-to-back you may still hit a transient 502.
Wait a few seconds and retry the specific file rather than re-uploading the whole batch.

---

## 8. Sign-off

After completing every row across both passes (§4–§5) and filling in Actual/Result/Note for all of
them (§6):

1. Go to the **Sign-off** block at the bottom of `docs/qa/2026-07-02-m1-manual-test-plan.md` (or
   your dated results copy) and complete it: every row has Actual+Result+Note, all 16 must-pass
   Critical/High rows pass (1.4, 1.7, 1.8, 4.9, 4.10, 6.5, 6.6, 7.7, 7.11, 7.16, 8.8, 10.8, 10.9,
   11.1, 11.2, 11.5), no leaks anywhere, zero script executions on adversarial rows, every failure
   filed as a GitHub issue, and the Tester/Date/Build/Overall-score fields filled in.

2. **This runbook's own closing summary** — fill in below once the checklist sign-off block is
   complete:

   - **Overall result:** PASS / FAIL — `______`
   - **Total rows:** `____` / **Passed:** `____` / **Failed:** `____` / **Pass-with-note:** `____`
   - **Critical/High findings that MUST be fixed before merging `feature/jeevan-p5-frontend` to
     `main`:** (list each as `<row #> — <one-line description> — GitHub issue #___`, or "none")
   - **Non-blocking findings** (nice-to-fix, doesn't block merge): (list or "none")
   - **Tester:** `______`  **Date:** `______`  **Build (branch @ commit):** `______`

3. **Notify the Owner (Jeevan) with the results** regardless of outcome — a full PASS is the
   go-signal to merge `feature/jeevan-p5-frontend` into `main`; any Critical/High FAIL blocks the
   merge until fixed and the failing rows are re-run. Include: the overall PASS/FAIL, the filled
   sign-off block from step 2, and links to any filed GitHub issues.
