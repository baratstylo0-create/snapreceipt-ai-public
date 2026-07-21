# HANDOFF — pick up exactly where we left off
> For Jeevan's other/backup Claude Code (Claude-J2) when this session hits its limit.
> Read this, then the startup chain in `/CLAUDE.md`. Everything below is current as of 2026-07-01.

---
## ⚡ SESSION END — Claude (for Barat). READ THIS FIRST. (2026-07-21, LATEST-6 — live-QA'd a real production bug, shipped a fix, then had to revert my own overcorrection; full story documented)

**main = `107d8d7`** (Merge #294), **2148 tests green** (`npm test`, Windows — no `--test-concurrency=1` issue hit this session). No open PRs of mine; **one pre-existing open PR, #286** (moves OCR to OpenRouter — not mine, not reviewed/actioned, still needs the Owner to provision an `OPENROUTER_KEY`). `npm install` first.

### Read this first: `docs/QWEN_MODEL_ERA_CHANGES.md` (new this session)
Everything below is a compressed version of that doc. It's the full, honest timeline of every change this project made because Groq discontinued the good vision model (`llama-4-scout`) on 2026-07-17 and force-migrated everyone to `qwen/qwen3.6-27b`, which is meaningfully less reliable. Read it before touching `lib/ocr.js` again.

### What happened this session, in order
1. **Live Telegram QA** (via the Owner's real Chrome/Telegram Web session) found a real bug: a receipt's YEAR got misread (2026→2024). That value parses fine, so nothing caught it, and the wrong year (a) hid the receipt from the dashboard's date-filtered view, (b) corrupted its `RC-<year>-####` ref number, (c) caused false "duplicate" rejections between unrelated misread receipts.
2. **First fix (PR #289) was too aggressive.** Made the bot REFUSE to save any receipt with an implausible/unreadable date or a photo that self-reported `image_unclear`. **In production this rejected real, readable receipts** — a live receipt the Owner sent during this exact QA session got bounced with "not clear, please resend." Two follow-ups (#290, #291) improved that rejection's wording, but wording wasn't the actual problem.
3. **The Owner (rightly) called this out hard** and gave explicit standing rules, now the permanent contract:
   - **Never invent or substitute receipt data.** Save exactly what's on the bill — no silent "corrected" dates.
   - **Only refuse when genuinely unreadable** (no merchant AND no amount at all). A readable receipt is ALWAYS saved.
   - **"Blurry/unclear" must mean the amount digits are genuinely illegible** after a careful read — not a lazy blanket flag on any minor tilt/glare.
4. **PR #293 implements that correction** (the current, standing behavior): `assembleExpense`'s reject gate is `isEmptyReceipt` only; an implausible date or unclear-photo signal is now a **soft, non-blocking review flag**, never a rejection; `CLARITY_KEY` (the prompt) narrowed to only fire on genuinely illegible amounts; the extraction prompt now explicitly tells the model to look carefully and transcribe exactly what's printed, never guess.
5. Two smaller wording fixes shipped in between: **#292** — the single-photo rate-limit message wrongly said "too many receipts sent at once" for a LONE photo (misleading — it's shared-key cumulative load, not something the sender did); reworded to "the receipt reader is briefly busy."
6. **Live-verified #293 on real production traffic** — mid-session, a real user (the Owner) sent live receipts through the deployed bot; confirmed the new wording and behavior firing correctly on actual photos, not just synthetic tests.
7. Wrote up the whole thread as `docs/QWEN_MODEL_ERA_CHANGES.md` (PR #294) so the next person doesn't have to reconstruct this from 6 PR diffs.

### What's still genuinely open (not fixable by more code)
- **PR #286 (open, not mine)** — moves OCR from Groq/qwen to OpenRouter, restoring the original accurate model (`llama-4-scout`, which Groq no longer offers at any price). This is the only real fix for qwen's occasional misreads. **Blocked on the Owner provisioning an `OPENROUTER_KEY`** (new paid account) — needs his decision, not something Claude can create or fund.
- **The shared single-Groq-key rate limit.** One key's per-minute budget is shared across every receipt this bot reads, for every user, and any load testing. Surfaces as "please wait about a minute" under load. No wording fix removes this — needs either more Groq keys (a round-robin design across the existing `lib/groqkeys.js` pool has been discussed, not yet built) or the OpenRouter move above.
- **Model reading accuracy itself.** Even after #293's correction, if qwen misreads a digit, the bot now faithfully saves that (real, imperfect) read rather than inventing a fix — correct per the Owner's rules, but it means an occasional wrong value can still reach the dashboard exactly as misread. Only a better model (#286) or better prompting reduces this further.

### The lesson, if you're the one touching this code next
A guardrail against a rare bad case must not have a bigger blast radius than the bug it protects against. Rejecting a real receipt to catch an occasional misread is a worse trade than the misread itself. If you're tempted to add a new reject condition to `assembleExpense`, don't — make it a soft review flag instead, and prove on real (not synthetic) receipts that it doesn't over-fire before shipping.

### Merge authority
No change from prior sessions — worker Claudes don't self-merge without the Owner directing it; this session's 6 PRs (#289-#294) were all Owner-directed live during active QA, not self-authorized.

---
## ⚡ SESSION END — Claude-J2 (handoff to J1). READ THIS FIRST. (2026-07-10/11, LATEST-5 — Premala bot LIVE, QA round closed out, auto-deploy shipped, VPS security items deferred by Owner choice)

**main = `3ede83a`** (Merge #180), **1770 tests green** (`node --test --test-concurrency=1` — the `--test-concurrency=1` matters, see GOTCHA below). No open PRs, 8 open issues (routine backlog, nothing blocking). `npm install` first.
**GOTCHA: repo-root `.env` has LIVE creds — `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail.**
**GOTCHA (new): Windows `node --test` hangs under full parallel concurrency** — not a code bug, confirmed via serial run + CI passing identically on Linux. Always run the full suite with `--test-concurrency=1` locally; don't chase it as a regression if you hit it.

### The Premala VPS is LIVE — bot is ON, dashboard is reachable, real QA has happened
- **VPS:** `31.97.70.50`, root SSH key at `~/.ssh/newvps_ed25519` (already set up in this environment, not something you need from the Owner). `/opt/README.md` on the box itself is a shared-tenancy guardrail — **read it before running anything** — this box also hosts Barat's `frictionai`/`quote-server`/`health-monitor`, never touch those without his sign-off.
- **`receipt_file_unique_id` migration applied** to the correct Supabase project (Premala, `xurnpvesgcybrnilxszf` — NOT the FrictionAI parent `fziaxuhonvrhqjulhcyu`) and verified via `information_schema.columns` + a live API probe before the bot was turned on.
- **Telegram bot is registered and working** (`PUBLIC_URL`/`WEBHOOK_CERT_PATH` set, self-signed cert uploaded to Telegram via the multipart cert path). Owner + a QA colleague have both bound test chat IDs and exercised real flows (duplicate-receipt handling, staff picker, edit-staff).
- **TLS is still self-signed** (every check needs `-k`) — deferred, tracked in `docs/STATUS.md` Blockers, blocked on the Owner picking a subdomain on a domain he already owns (any name, doesn't need to be Premala-branded). Don't start this without him giving you the subdomain first.

### 🚀 NEW THIS SESSION — auto-deploy to the VPS is live (`.github/workflows/deploy.yml`)
**Merging to `main` now deploys itself.** No more manual SSH/tar/pm2-restart for routine ships:
- Runs the full test suite as a gate → packages via `git archive` (git-tracked files only, `.env`/`node_modules` structurally cannot leak in) → uploads via a dedicated deploy SSH key (`VPS_DEPLOY_SSH_KEY` + `VPS_HOST` in GitHub Actions secrets) → restarts → verifies `/health` + `/ready`.
- The live app was **migrated off root's pm2 onto a new unprivileged `deploy` Linux user's own pm2 daemon** (zero sudo, `chown`'d only to `/opt/receipt-analyser`) specifically so this account can't touch Barat's processes even by mistake. Verified end-to-end (PR #180's own merge was the first real deploy — went green first try).
- **If you need to deploy something NOT yet on `main`** (a hotfix test, etc.), the old manual method still works as documented fallback — see `docs/roles/BARAT.md` §6 point 6, or just merge to `main` and let it deploy itself.
- Two things the Owner explicitly declined for now, don't re-propose without him asking: (a) blue-green/zero-downtime deploys — a plain few-second pm2 restart is fine at this scale, he called it overkill; (b) a full staging environment — agreed it's a good idea **once Premala has actually shipped**, not before. If he brings up "testing without touching the live system" again, the answer is already designed: a `develop` branch → separate deploy target → own test Supabase data, not yet built.

### Closed out this session (all merged to `main`, PRs #174–#180)
- **#174:** bot `dupstaff:` on an empty staff directory now sends an explanation instead of silently doing nothing (live QA finding, Owner-reported via Telegram screenshot).
- **#175 + #177:** expense edit-drawer's Status field was a free-text `<input>` — now a `<select>` (`saved`/`needs_review`/`approved`/`rejected`), same pattern as Category. #177 is the regression test an independent Opus review flagged as missing (locks in that an unmodified sentinel status like `awaiting_category` is never silently rewritten).
- **#176:** Docker isolation plan for the shared VPS — **proposed only, not executed.** `docs/ops/2026-07-10-docker-isolation-plan.md`. Needs Owner's explicit go before touching production with it.
- **#178:** tracked the deferred TLS + security-hardening items in `docs/STATUS.md` Blockers (see below).
- **#179:** wrote out Barat's Deputy review/merge playbook in `docs/roles/BARAT.md` §6 — he already had merge authority per `docs/PROJECT_BRIEF.md`/SOP, this just wrote down the concrete mechanical checklist (read real diff, run full suite locally, confirm CI green on correct base branch, Tier-2 gate honestly, update WORKLOG, now: auto-deploy is the normal path).
- **All originally-scoped QA-round items** (`docs/qa/2026-07-09-qa-round.md` + `-round2.md`, PR-A through PR-K) were already merged before this session started (confirmed via WORKLOG during this session) — the items closed this session (#174/#175) were **new** live-QA findings from the Owner and a colleague actually using the deployed system, not leftover round-1/2 items.

### Deferred by explicit Owner choice — tracked in `docs/STATUS.md` Blockers, don't just do these unprompted
- **Real TLS cert (Let's Encrypt)** — blocked on Owner picking a subdomain.
- **VPS security hardening batch** (from a 2026-07-10 Opus-reviewed checklist): `PermitRootLogin yes` + no fail2ban on the shared VPS; UFW port 22 open to any IP, no allowlist; `npm audit` in CI is informational-only; no Dependabot; Supabase backup/PITR tier unconfirmed. All flagged "deferred, not urgent" — Owner knows about them, hasn't asked to act.

### Access / people state
- **Barat** = already a GitHub collaborator (write access) + already formally named **Deputy** (can merge to `main` when Owner's away, same review bar) — this was true before this session, nothing new needed there except the playbook doc (#179).
- **Mugi** = already a GitHub collaborator (write access).
- **A QA colleague** (separate person, not Barat) has been testing the live dashboard + Telegram bot — he does NOT have GitHub or VPS access; that conversation was still open (Owner was deciding scope) when this session ended. If Owner asks to onboard him: get his GitHub username for a collaborator invite, and/or an SSH public key if he also wants VPS access — do NOT paste/ask for passwords in chat.
- **Auto-mode classifier note:** creating new privileged accounts / SSH keys / stopping-restarting the live production process each individually required the Owner to name the *specific* action in plain words, not just a general "go ahead" earlier in the conversation — expect this same friction on similarly sensitive VPS actions and don't retry a blocked call silently; explain and ask.

### Merge authority
Same as always: worker Claudes never self-merge; Owner or named Deputy (Barat) merges. The auto-mode classifier blocks self-authored merges without explicit Owner direction.

---
## ⚡ SESSION END — Claude-J2. READ THIS FIRST. (2026-07-04, LATEST-4 — voucher LIVE, dashboard fully driven, security reviewed, receipt-image storage foundation shipped)

**main ≈ `3a07e9d`** (Merge #87), **856 tests**. `npm install` first. **GOTCHA: repo `.env` has LIVE creds — `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail.** Preview server may be running on :3001.

### ⚠️ BEFORE DEMO/HANDOFF: see `docs/PRE-DEMO-CHECKLIST.md` (new)
Deferred-but-required: **rotate `DASHBOARD_TOKEN` + Groq keys** (pasted into chat this session — fine while internal-only, rotate before demo), return demo rate-limits to prod values. Full security review recorded there (verdict: **no critical breach**).

### Landed this session (main)
- **Voucher migration APPLIED to live DB** (Owner ran the SQL in Supabase editor) + **verified**: all rows numbered `RC-YYYY-NNNN`, and the trigger auto-numbers new inserts (tested a row → `RC-2026-0015` → soft-deleted). Feature is LIVE.
- **Merged:** #77, #78, #80 (earlier) + **#82** (uuid audit=0), **#83** (categorizer hardening #14, partial), **#84** (runBatch per-image meta #31), **#85** (human-readable field labels — Manage shows friendly names, not machine keys), **#86** (voucher `RC-` column in dashboard), **#87** (receipt-image storage foundation `lib/storage.js` + private `receipts` bucket, live round-trip proven).
- **Dashboard driven live end-to-end** (preview): Overview, Activity (+Ref column), Reports (+Excel + category breakdown), Upload, Manage, **Agent now works** (added backup Groq key to `GROQ_KEYS` pool + raised limits in local `.env` + restarted → answered via live tool-calling). All MYR.
- **Fixed my own mistake:** during agent UI testing a stray form-submit clobbered the `field_templates` default with junk fields — **restored** to Merchant/Date/Amount/Currency/Category.

### 🎯 NEXT FOCUSED TASK — finish receipt-image storage (ADR-018, spec #81; foundation = #87 merged)
Wire the proven `lib/storage.js` into the pipeline so images actually display (dashboard-upload path is 100% broken today — primary win). Small, precisely scoped:
1. `routes/upload.js` (Jeevan) — upload each decoded image via `uploadReceiptImage`, pass the returned path as `receipt_url` per-image via `runBatch`'s `metas[]`/`metaForImage` seam (already built in #84).
2. **`lib/ocr.js` `assembleExpense` (BARAT's lane) — the ONE thing Barat does here:** a 1-line additive passthrough so the built `expense` includes `receipt_url` from its args (defaults undefined → unchanged for every existing caller). Loop him in (or he does it); flag in WORKLOG like #79.
3. `routes/receipt.js` — serve from Storage by expense id (look up `receipt_url`, `fetchReceiptObject`, stream, `checkDash`-gated, `private,no-store`); fall back to today's Telegram proxy for old rows.
4. `public/js/components/activity.js` — render the image when `receipt_url` is present (currently only `if (r.receipt_file_id)`).
Then live-verify: dashboard-upload a receipt → image displays.

### Other open / pending
- **PR #88 (Barat)** — persistent bot menu bar. Not reviewed by me; review + merge when Owner directs.
- Barat: **restart his live pipeline** (currency MYR — still his action) + the #81 step-2 line above + #14 upsert (his migration) + #31 Telegram adapter wiring.
- Mugi still BLOCKED; M2 deferred until Owner signs off personal is top-tier.

### Merge authority
Delegated to J1/J2 but the classifier blocks self-authored merges without explicit Owner direction — Owner names each, or do a full read-diff+test review of a teammate's PR first.

---
## ⚡ SESSION END — Claude-J2 (handoff to J1). READ THIS FIRST. (2026-07-03, LATEST-3 — Owner wants full personal-account E2E testing; images broken; voucher signed off)

**main = e183181, 764 tests green.** `npm install` first. **GOTCHA: repo-root `.env` has LIVE creds — `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail.** A local server may still be running on `:3001`.

> **Attribution correction:** this whole 2026-07-03 session (the LATEST-2 & LATEST-3 blocks below, PR #69/#70/#71, and the matching `WORKLOG.md` entries) was run by **Claude-J2**, not J1 — those already-merged labels say "Claude-J1" but that's a mislabel, left as frozen append-only history. **J1 handles all merges** (PRs #70 voucher-spec, #71 this handoff, + Barat's incoming voucher build).

### OWNER'S #1 GOAL — personal-account, end-to-end, everything connected + working TOP-TIER
He wants to **TEST EVERY FEATURE** before M2 (B2B). **Mugi stays BLOCKED, M2 deferred** until Owner signs off personal is solid. Your job = make the full personal flow work + verify it: dashboard upload → OCR → save → list/filter → edit → category (18) → currency (MYR) → Excel export → AI agent chat → reports → review queue. Run the server, exercise each, fix what's broken.

### TOP OPEN ITEM — receipt images don't display (Owner explicitly wants click-to-view working)
- **Root cause:** `/receipt/:fileId` live-proxies Telegram using `BOT_TOKEN` (**empty** in `.env`); and **dashboard uploads store NO image at all** (`receipt_file_id` null — frontend only renders `if (r.receipt_file_id)`). `receipt_url` column exists but is **unused**.
- **Owner chose the PROPER fix:** Supabase Storage — upload image at ingestion → store real URL in `receipt_url` → serve from Storage (fall back to Telegram proxy for old rows). **Click-to-view UI is ALREADY built** (`public/js/components/activity.js` `loadReceiptImage`, auth'd-blob fetch).
- ⚠️ **COLLISION — DO NOT RACE BARAT:** the storage upload must hook the insert path (`lib/ocr.js` `assembleExpense` / `lib/supabase.js`) = **Barat's lane, and he's editing those RIGHT NOW for vouchers.** Write it as a **spec** (like voucher), sequence AFTER his voucher PR lands. Pure-Jeevan parts can be prepped: new `lib/storage.js`, `routes/upload.js` wiring, frontend. **No `receipts` bucket created yet** (plan it in the spec). Storage API confirmed reachable via service key.

### Landed this session (main): PR #65, #64, #69
- **#69 (me):** config boot banner (`configSummary()` → `account · currency · tax · auth` at startup). Honest fix for the currency incident (NOT a live-getter — that reads the same stale `process.env`).

### Currency incident — DONE on our side; Barat must restart his pipeline
Root cause: stale process (dotenv loads `.env` once at start; mid-session `.env`→MYR edit never reached the running process). **Data repaired** (3 real rows recomputed to MYR from `ai_raw`; 3 junk soft-deleted). ⚠️ **Barat's live pipeline still emits USD** (fresh `99 Speed Mart` row appeared mid-session) — **he must RESTART it** to pick up MYR.

### Open PRs
- **#70** — voucher/reference-number spec, **SIGNED OFF by Barat** (A/B/C as recommended; **prefix `RC-`** → `RC-2026-0041`). Barat is **BUILDING the code now** (schema.sql + insert path, Tier-2, he'll PR separately). Spec doc already updated to RC-. #70 itself can merge (Owner-authorize or independent review).

### CORRECT Supabase project = `xurnpvesgcybrnilxszf` (Barat's, shared)
MCP can't reach it — query via `.env` `SB_URL`/`SB_KEY` over PostgREST directly. The FrictionAI parent `fziaxuhonvrhqjulhcyu` is the WRONG db — don't confuse.

### Other pending (non-blocking)
- **Rotate `DASHBOARD_TOKEN`** (leaked into a chat log; it's the bearer gating every `/api/*` + `/receipt` route via `checkDash`).
- **Barat's onboarding/chat-id-linking** (deep-link invites + DB table replacing `ALLOWED_CHAT_IDS`) — that's M2; let him **spec** it, but **build gated behind personal-first**.
- Minor app cleanup: `visionEscalate` model tier is **dead config** (unwired + points at the same model as default) — delete or wire later, low priority. (Owner's "model switch" question was about Claude Code SOP §4.9 sessions, NOT the app — clarified, non-issue for the app.)

### Merge authority
Delegated to J1/J2 but the classifier **blocks self-authored merges** — Owner must name each PR, or do a full read-diff+test review of a teammate's PR first.

---
## ⚡ SESSION END — Claude-J1. (2026-07-03, LATEST-2 — #65 & #64 MERGED; MYR/USD currency incident root-caused + live data repaired)

**main HEAD** = PR #64 merge (`8c0a96b`), **761 tests passing** on main. `npm install` first. **Gotcha unchanged: `.env` in repo root has LIVE creds — `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail.**

### ⚠️ CORRECT Supabase project for THIS app = `xurnpvesgcybrnilxszf` (Barat's, shared to Owner as co-owner)
My own authed Supabase MCP only sees the **FrictionAI parent** (`fziaxuhonvrhqjulhcyu`) — DO NOT confuse them (that parent has a different `expenses` schema: `tenant_id`/`date`, no `account_id`). To query the real app DB, read `SB_URL`/`SB_KEY` from `.env` and hit PostgREST directly (the MCP token can't reach Barat's project). Repo `.env` has **no `BOT_TOKEN`** → can't drive the live bot from here.

### Landed this session (main, done)
- **PR #65 (Barat) MERGED** — batch uploads now actually persist + skip non-receipts (blurry vs not-a-receipt messages). Reviewed clean, 704/704 → merged.
- **PR #64 (Barat) MERGED** — in-chat Telegram delete (Yes/Cancel `callback_query`, confirm-time ownership re-check, allowlist covers callbacks). Was behind main; I merged origin/main into it (trivial WORKLOG conflict), 761/761, merged.

### MYR/USD currency incident — ROOT-CAUSED (not a code bug) + DATA REPAIRED
- **Symptom:** every live expense stored USD despite `DEFAULT_CURRENCY=MYR`. **Root cause:** the running process's `cfg.DEFAULT_CURRENCY` was still USD — `dotenv` loads `.env` into `process.env` ONCE at startup, so the mid-session `.env`→MYR edit never reached the running process (a row ingested AFTER the edit was still USD = proof). OCR read currencies correctly (`ai_raw`); pipeline converted good MYR *into* USD against the stale target. A fresh process on the current `.env` = MYR (verified by booting the server).
- **Data repaired (Owner-approved, live):** 3 real rows recomputed to MYR from `ai_raw` (Bonda 183.65, L.C. Vegetarian 68.9, 99 Speed Mart 21.1; fx fields cleared); 3 junk rows soft-deleted (M/S Cash + 2× Unknown $0). Live `expenses` = 3 clean MYR rows.
- **PR #69 (mine, OPEN)** — boot banner via new `configSummary()` prints `account · currency · tax · auth` on every start so a stale/wrong currency is visible at boot. **NOT a "live getter"** — a getter reads the same stale `process.env`, wouldn't have prevented it. `lib/config.js` + `server.js`, 764/764 (+3). Self-authored → needs independent/Owner merge.
- ⚠️ **Barat owns the operational fix:** a live pipeline on HIS side is still ingesting USD (fresh `99 Speed Mart` at 13:30 UTC) — he must **restart** it to pick up MYR. Message relayed via Owner.

### NEXT ACTIONS for J2 (in order)
1. **Merge PR #69** (config boot banner) once reviewed.
2. **Voucher/reference-number feature** — Owner wants `V-2026-0041`-style IDs; schema change (Barat's lane: `schema.sql` + `lib/ocr.js`/`lib/supabase.js`). NOT yet spec'd — write a short spec, get Barat's sign-off, then he builds.
3. **Rotate** the dashboard token that leaked into the chat log (Barat flagged; Owner agreed).
4. **Mugi still hasn't started** — needs his GitHub username to add as collaborator.
5. Non-blocking: issues #31, #20, #14.

---
## ⚡ SESSION END — Claude-J1. (2026-07-03 — category fix MERGED; Barat found a CRITICAL data-loss bug, PR #65 needs urgent review)

**main HEAD** = PR #66 merge (`8422e48`), **721 tests passing**. `npm install` first. **Gotcha: `.env` in repo root has LIVE credentials — `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests falsely fail.**

### ⚠️ TOP PRIORITY — PR #65 (Barat): batch uploads have been silently NOT SAVING to the database
While fixing a "junk data got saved" bug report, Barat found something worse: **`assembleExpense`'s documented contract says it inserts the row — it never did.** Only the single-photo path (`expenseFromPhoto`) had its own explicit insert. **Every batch/multi-photo upload (Telegram albums, Telegram PDFs, dashboard multi-upload) has told users "N saved" while writing NOTHING to Supabase since #7 shipped.** He's fixed it (`isEmptyReceipt` now runs inside `assembleExpense` + a real insert now happens there; `runBatch` counts `skipped` separately from `saved`) — 690/690 tests, 9 new. **Review + merge this first**, and consider whether any of today's live-test batch uploads (if any were multi-photo) need re-sending.

### Also open: PR #64 (Barat) — in-chat Telegram delete ("delete" → Yes/Cancel button → soft-deletes). Tier-2 (deletes financial data + new webhook update type `callback_query`), 690/690, lower urgency than #65.

### Landed this session (main, done)
- PR #66 (me): category taxonomy bug fixed (dashboard now reads the REAL 18-category list from `lib/categorize.js` via `/api/config`, deterministic color palette, never drifts again) + dashboard labels read the customer's FieldSpec + new visual "build a field" template builder (zero CSV knowledge, honest about type/required not round-tripping through the CSV endpoint).
- Live end-to-end test with the Owner (real Supabase + Groq). `DEFAULT_CURRENCY=MYR` set. **2 old test rows are still USD — Owner hasn't confirmed whether to re-convert, don't touch without asking.**
- PRs #60, #61, #62, #63 all merged earlier this session (Groq key-rotation ADR-016 complete both sides, non-receipt short flag, CORS preflight fix, bot allowlist + acks + batch breakdown).

### NEXT ACTIONS for J2 (in order)
1. **Review + merge PR #65 first** (critical data-loss fix), then #64.
2. **Voucher/reference number feature** — Owner wants it (e.g. `V-2026-0041` per expense), needs a schema change (Barat's lane: `schema.sql` + `lib/ocr.js`/`lib/supabase.js`). Not yet spec'd — write a short spec, get Barat's sign-off, then he builds it.
3. **Ask Owner:** re-convert the 2 old USD rows to MYR, or leave as historical?
4. **Mugi still hasn't started** — needs his GitHub username to be added as a collaborator.
5. Non-blocking: issues #31, #20, #14.

**main HEAD** = PR #63 merge (`67163ff`). **Open branch (NOT merged):** `feature/jeevan-dynamic-categories-fieldspec`, pushed, **721 tests passing** (baseline 703 before this branch's 2 commits). `npm install` first.

### What happened this session (in order)
1. **Live end-to-end test with the Owner** using his real Supabase + a fresh Groq key (local `.env`, gitignored — NOT committed, still on disk in the repo root for continuity). Confirmed the WHOLE pipeline works for real: Telegram→OCR→dashboard→Agent chat (native tool-calling)→Excel export→currency conversion, all live. Set `DEFAULT_CURRENCY=MYR` (Owner is Malaysia-based) — **2 old test rows are still USD, Owner hasn't said whether to re-convert them, don't touch without asking.**
2. **Reviewed + merged 3 of Barat's PRs this session:** #60 (Groq key-rotation call-site, ADR-016 now fully shipped both sides), #61 (short non-receipt flag), #63 (bot access allowlist — `ALLOWED_CHAT_IDS`, Owner's chat id `1979799104` is live — + restored "Reading…" acks per Owner's explicit re-approval, + batch receipt breakdown in Telegram replies). Also merged my own #62 (CORS preflight fix, issue #53 closed).
3. **Found + reported a REAL bug via live data**, now FIXED on the open branch: the dashboard's category list/filter/pill-colors were a stale hardcoded 5-name stub (Food/Petrol/Software/Inventory/Others) that didn't match the REAL 18-category chart of accounts the AI categorizer (#6) actually uses (Meals & Entertainment, Groceries, Fuel & Auto, etc.) — confirmed live when a real receipt got categorized "Meals & Entertainment" and broke the UI. Fixed: `GET /api/config` now returns the real `categories` list (sourced from `lib/categorize.js`'s `CATEGORIES`, single source of truth); dashboard uses a deterministic hash→color palette instead of a hardcoded name map (scales to any category count, never drifts again).
4. **Also on the open branch:** dashboard labels (table headers, edit-drawer fields) now read the customer's own FieldSpec (`GET /api/templates`) instead of hardcoded English strings — a renamed/custom field shows the customer's own label. **And** a brand-new **visual "build a field" template builder** in Manage (add-field rows: name/type/required/remove — zero CSV knowledge needed) that reuses the existing CSV-import endpoint under the hood. **Honest, tested finding:** the CSV endpoint only carries field NAMES — type/required do NOT round-trip through it (Barat's `parseTemplate` only recognizes a few canonical header names for type inference). The builder's UI says so plainly (`.tp-fb-note`) rather than pretending otherwise.

### NEXT ACTIONS for J2 (in order)
1. **Review + merge `feature/jeevan-dynamic-categories-fieldspec`** (721 tests, 2 commits: `602c369` category/label fix, `4d5d27c` template builder). Self-authored by me → do independent review or ask Owner to merge (classifier blocks self-merge). **Gotcha: `.env` is present in the repo root with LIVE credentials — always `mv .env .env.local.bak` before `npm test`, restore after, or ~90 tests will falsely fail** (pure environment contamination, hit this twice already this session).
2. **Ask the Owner:** (a) re-convert the 2 old USD test rows to MYR, or leave as historical? (b) do a live browser check of the category-fix branch himself (the implementing subagents couldn't safely launch a live server with real creds present — verified via the automated suite only).
3. **Voucher/reference number feature** — Owner wants a short human-readable ID per expense (e.g. `V-2026-0041`), separate from the DB UUID. This needs a schema change — **Barat's lane** (`schema.sql` + `lib/ocr.js`'s `assembleExpense` or `lib/supabase.js` insert path). **Not yet spec'd or requested from Barat — write a short spec first** (mirror the Groq-key-rotation ADR/spec pattern), get his sign-off, then he builds it.
4. **Mugi still hasn't started** — needs his GitHub username to be added as a collaborator. Reference frontend + all Task M/N fixes are his scope reference once the open branch merges.
5. Non-blocking issues still open: #31 (per-image Telegram links), #20 (exceljs uuid), #14 (categorizer hardening).

**Gotcha (new):** the local `.env` in the repo root holds LIVE Supabase/Groq secrets from this session's live test — treat as dev-exposed (ADR-015: rotate before any real customer), and always move it aside before running tests.

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #58 merge (`ecf734d`). `npm install` + `npm test` first — **663 passing, 0 open PRs.**

### State: reference frontend + P6 hardening + ADR-016 key pool ALL SHIPPED
- **PR #52** — the whole P5/P6 plan (frontend Tasks 0-K, security hardening, QA checklist, security-QA, runbook) merged after a real pre-merge `/code-review` (3 finder angles) that caught + fixed 1 material bug (auth-limiter throttling legit card-view traffic) + 2 minor. `docs/qa/` has the manual test plan + runbook.
- **PR #54** (Barat) — non-receipt guard: a selfie no longer saves a junk $0 row.
- **PR #55** (me) — rate limits loosened (upload/agent 20→120/min, Owner directive: never throttle a legit busy user; these are runaway backstops now, not throttles).
- **PR #56** (Barat) — `RateLimit-Limit/Remaining/Reset` headers on every limited response.
- **PR #57** (me) — `lib/groqkeys.js` (ADR-016 multi-key pool: `keyPool`/`pickKey`/`nextKey`). Barat unblocked to wire `lib/groq.js`'s fall-through loop (his lane) — not yet confirmed done, check WORKLOG/ask him.
- **PR #58** (me) — frontend "% used" rate-limit meter (header chip, reads Barat's headers, warns near the edge). Verified live in preview (ok + critical states).

### NEXT ACTIONS (in order)
1. **Check if Barat has wired `lib/groq.js`'s call-site loop** against `lib/groqkeys.js` (ADR-016 — the module is merged, his side may or may not be done yet; his 3 call-site questions were all confirmed: 429-only rotation, swaps don't eat backoff budget, GROQ_KEYS supersedes GROQ_KEY). Review + merge his PR if open.
2. **Mugi is unblocked** — the reference frontend (PR #52) is his scope reference; check if he's started (#3 production UI/UX), needs his GitHub username added.
3. **Deferred/non-blocking issues** (pick up if idle): #53 (CORS preflight unhandled — only matters for a cross-origin deploy), #31 (per-image Telegram receipt links), #20 (exceljs uuid audit bump), #17 (`/api/templates` label sanitization), #14 (categorizer hardening).
4. **AI-assisted CSV template builder** — deferred feature, own spec, not started.
5. **P9 direction (when ready):** hosting/deploy, HTTPS, Supabase org migration off Barat's personal account (ADR-015 tier ladder — trigger is user #1, not 5 users), observability (P7), AI eval gate (P8).

**Gotcha carried forward:** `git add -A` can leak `graphify-out/` scan artifacts on a branch missing the frontend branch's `.gitignore` entries — prefer explicit `git add <files>`.

---

**Repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas`. **main HEAD** = PR #40 merge (`79f204b`). gh authed as Jeevan1811. `npm install` after clone; direct push to main blocked — branch + PR only. `npm test` on main = **360 passing**. **No open PRs.**

### State: BACKEND FEATURE-COMPLETE (M1). #1 PDF fully landed (both surfaces).
- **#1 PDF DONE:** `lib/pdf.js` rasterizer + Telegram path (**PR #38**), `/api/upload` PDF glue (**PR #40**), and the `/api/upload` Buffer→data-URI fix (**PR #39**) — all independently Tier-2-QA'd + merged. The render-dimension-bomb finding was fixed at source (`lib/pdf.js` pixel cap, `PDF_MAX_RENDER_PIXELS` 40 MP) and verified clean over HTTP (huge-MediaBox → 413).
- **All 12 M1 backend features are on main.** Barat's lane is empty (business Excel PARKED by Owner). Open issues #14/#17/#20/#31 are non-blocking, Jeevan/Mugi lane.

### EXACT NEXT ACTIONS for J1 — build the reference frontend + human-QA + security hardening
**Read `docs/plans/2026-07-02-reference-frontend-qa-security.md` — it is the full plan (P5 Frontend + P6 Hardening).** Owner wants: a **PC-only reference frontend** surfacing EVERY feature (for Mugi to see scope + for humans to click-test everything), a **serious fool-proof human-QA checklist**, and a **thorough cybersecurity pass** (sensitive financial data). Execute via **subagent-driven-development** (fresh implementer per task + two-stage review), Task 0 = short brainstorm with Owner on visual scope (Finexy-style draft = look-and-feel ref only, not literal).
- **Two real security findings already identified — fix them in the hardening task:** (1) **`GET /receipt/:fileId` is UNAUTHENTICATED** → sensitive receipt images leak to anyone with a fileId (gate behind `checkDash`/signed URL — treat as Critical). (2) **`checkDash` is OPTIONAL** (no-op if `DASHBOARD_TOKEN` unset) → make prod fail-closed. Also: tighten `Access-Control-Allow-Origin: *`, add CSP+security headers, add rate limiting, and (biggest new surface) **strict output-escaping of untrusted OCR/`ai_raw`/agent text in the DOM** (stored-XSS).
- **Telegram bot human-testing = PARALLEL track, Barat's** — coordinate a shared QA data set; not part of this plan.
- After this lands: run `/security-review` (SOP §7.5) + an independent security-QA subagent before the P6 gate.

### Decisions locked (2026-07-02)
- ADR-014: `@hyzyla/pdfium` (WASM, MIT, zero-dep) for PDF rasterization; PNG via `node:zlib` (no `sharp`).
- Business Excel PARKED; jszip ADR-013 stands. Reference frontend = PC-only for now (mobile parked).
- One fresh session per feature; HANDOFF contract designed for exactly this.

### GOTCHAs (carry forward)
- (a) **`npm install` before diagnosing "post-merge test failures"** — a dep added to `main` after your branch forked leaves `node_modules` stale.
- (b) Auto-mode classifier **blocks self-authored PR merges** (even Tier-1 docs, even with prior "merge the branches" authorization — it does NOT extend to PRs created after that authorization). Owner must explicitly name/authorize each PR, or you do full read-diff+test review first.
- (c) A subagent QA-ing a teammate's PR **checks out that branch in the shared working tree** — don't do local git ops while it runs.
- (d) `@hyzyla/pdfium`'s `page.render()` returns raw RGBA, not PNG — don't add `sharp`; use the `node:zlib` encoder in the plan (Task 2, code is spike-verified).

### Merge-decision authority (Owner delegated to J1/J2)
Merge when the independent QA/Tier-2 review is clean OR after fixing its findings; HOLD on Critical/Important, or when the fix is the author's (Barat's files: `lib/ocr.js`, `lib/groq.js`, `lib/supabase.js`, `lib/templates.js`, `lib/confidence.js`). Auto-mode may prompt before merging a teammate's PR — verify the precondition landed (git log), then proceed.

---

## Where things physically are
- **Active repo:** `C:\Users\Asus\Downloads\receipt-analyser-saas` ← launch Claude Code HERE, not in `Gold_Bot`.
- ⚠️ `C:\Users\Asus\Downloads\Gold_Bot` is an **unrelated forex trading bot**. The Friction SOP folder was mistakenly dropped inside it. Ignore it for this project.
- Source it was copied from: `C:\Users\Asus\Downloads\receipt-saas` (leave as-is, untouched backup).
- Canonical SOP also at `C:\Users\Asus\Downloads\Friction_SOP_Foundation\FRICTION_PROJECT_SOP.md` (copied into `docs/`).

## What's DONE (this session)
- Clean git repo created on `main` (local only — no GitHub remote yet).
- Module dirs scaffolded: `lib/ routes/ docs/ docs/roles docs/templates docs/specs templates/ .githooks/`.
- Git safety: `.githooks/pre-push` (blocks direct push to main/develop) + `setup-git-hooks.ps1`.
- Governance docs written: `FRICTION_PROJECT_SOP.md`, `PROJECT_BRIEF.md` (filled kickoff), `ARCHITECTURE.md` (module map + frozen interfaces), `STATUS.md`, `WORKLOG.md`, `DECISIONS.md`, this `HANDOFF.md`, `roles/{JEEVAN,BARAT,MUGI}.md`, root `CLAUDE.md` updated, `MEMORY_LEDGER.md`.
- **Brief signed GO; repo published to GitHub; modularization MERGED to `main`.**
  - `main` is now the modularized codebase: `server.js` 31 lines (wiring only) + `lib/{money,categorize,http,config,groq,supabase,telegram,ocr,bot}.js` + `routes/{webhook,expenses,receipt,misc}.js` + `tests/`. **`npm test` = 8/8 green.**
  - Merged: PR #1 (kickoff docs), PR #2 (modularization). Barat collaborator = `baratstylo0-create` (push).
  - ⚠️ Run `npm install` after cloning (node_modules is git-ignored).
  - ⚠️ Direct push to `main` is blocked by the pre-push hook — all changes via branch + PR.

## Decisions locked (see DECISIONS.md)
- Repo Owner = Jeevan (gh: Jeevan1811); Deputy = Barat.
- Track = Vertical AI. M1 = personal version, 12 features.
- Modularize server.js FIRST (ADR-001). Groq data = masking + retention (ADR-002). CSV field template #12 foundational (ADR-003). Coupling-based split (ADR-004): Barat=infra+#4,#1,#11,#12; Jeevan=#5,#6,#8,#9,#2,#10,#7; Mugi=#3+business. Currency = FX API not LLM (ADR-005).

## EXACT NEXT ACTIONS (in order)
> **UPDATE 2026-07-01 (Claude-J2):** P3 infra done; **PR #9 templates MERGED**. Now in P4 features.
> Open PRs: **#8 reports** (QA fixes pushed, re-review) and **#6 categorization** (built, 50/50, awaiting review).
> Next actions below supersede the P3 list.

1. **Review + merge the open feature PRs:**
   - **PR #8 (reports #8):** QA-requested fixes pushed (truncation surfaced, strict date validation, +route/data-quality tests). Awaiting QA re-review → then Owner merge.
   - **PR #6 (categorization #6):** LLM-supervised learning categorizer. Awaiting Tier-2 + QA review → Owner merge.
2. **Barat (after PR #6 merges):** apply `db/2026-07-01-category_corrections.sql` in Supabase + fold into `schema.sql`; wire `categorizeLineItems(receipt, fieldSpec)` into `lib/ocr.js` where it currently calls `normaliseExpenseCategory`. Also the currency (#10) wire-up snippet from that PR.
3. **Jeevan's remaining features:** #5 anomaly (duplicates + **personal-expense admin accept/reject queue** — reuses #6's `flagged` field), #2 Excel (reads FieldSpec, unblocked by #9), #9 agent, #7 mass upload. Each = one branch = one PR = cross-reviewed.
4. **Mugi:** deferred (#3 dashboard + business structure) — needs GitHub username; also owes the dashboard category-pill expansion to the new #6 chart of accounts.

## Pending inputs / open items
- Barat: run schema in his Supabase; invite Jeevan to that project for visibility; confirm vision routing (ADR-007).
- CTO flag (open question): production Supabase should move off Barat's personal account to a shared org/Owner account before launch.
- Mugi GitHub username (when he starts).

## STILL NEEDED FROM JEEVAN (open inputs)
- Barat's + Mugi's **GitHub usernames** (to add as collaborators).
- **AI monthly cost cap** ($) — PROJECT_BRIEF §10.
- FX API choice, hosting choice, PDF rasterisation approach (PROJECT_BRIEF §10 — can be decided later).
- Confirm whether to push to GitHub now or after GO.
