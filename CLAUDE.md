# Receipt Analyser System — Guide for Claude Code
> **⚠️ POSITIONING (ADR-020, 2026-07-05): this is a DELIVERED, PER-CLIENT AUTOMATION SYSTEM — not a multi-tenant SaaS product.**
> We build one complete system and deploy/customise an instance per client (their template, categories, branding, which
> features/roles are on). **No** self-serve signup, subscription/billing, app-store listing, or Windows/Mac installer package.
> **All features stay — nothing is removed;** only packaging/distribution changed. "SaaS phases" (public onboarding, billing,
> store/installer, marketplace multi-tenancy) are **flagged N/A**. Multi-tenant/roles (M2) is reframed as a **per-client option**,
> not a universal requirement. The Owner's "16-layer" completeness checklist (an image) is **not yet in the repo** — pending. The
> word "SaaS" survives in file/dir names for now (cosmetic, not worth a rename). See `docs/DECISIONS.md` ADR-020.

> ## ⚠️ START HERE — Friction governance (read before touching anything)
> This repo is built under the **Friction SOP**. On every session start, read IN ORDER:
> 1. `docs/FRICTION_PROJECT_SOP.md` — the constitution (git rules, phase gates, security)
> 2. **this file** (`CLAUDE.md`) — technical guide (below)
> 3. `docs/PROJECT_BRIEF.md` — frozen scope (the 12 features, ownership map) — **no feature code until it's signed GO**
> 4. `docs/ARCHITECTURE.md` — module map + **frozen interfaces** (build against §3)
> 5. `docs/WORKLOG.md` + `docs/STATUS.md` — what others did, current phase/blockers
> 6. **your role file**: `docs/roles/JEEVAN.md` · `docs/roles/BARAT.md` · `docs/roles/MUGI.md`
>
> Then follow the pre-work ritual (SOP §4.2). **Edit only the files your role owns** (collision rule §4.6).
> Precedence: Repo Owner (Jeevan) → SOP → this file → defaults. If a request conflicts with the SOP, STOP and ask.
>
> Backup/handoff Claude (Jeevan's J2): read `docs/HANDOFF.md` first.

---

This is a **standalone** project (extracted from FrictionAI). It has no build step, no
external services beyond Telegram + Groq + Supabase, and only two runtime deps
(`express`, `dotenv`). Keep it that way unless there's a strong reason.

## Architecture

```
Telegram bot ──webhook──▶ server.js (Express, one file)
                              │  POST /webhook        → handleUpdate()
                              │  photo  → expenseFromPhoto() → Groq vision OCR → Supabase insert
                              │  GET /api/expenses     → reads Supabase (service key)
                              │  GET /receipt/:fileId  → proxies the Telegram image
                              │  GET /                 → serves public/index.html
Dashboard (public/index.html) ──fetch──▶ /api/expenses   (never touches Supabase directly)
```

- **Single account v1.** Everything is scoped by `account_id` (from `.env`, default `'default'`).
- **DB access is server-side only** with the Supabase service-role key. The browser uses our own API, so no Supabase key is exposed and RLS stays simple (anon denied by default).

## Key files

| File | What to edit it for |
|------|---------------------|
| `server.js` | Bot behaviour, OCR prompt/parsing, API, webhook. All backend logic lives here. |
| `public/index.html` | Dashboard UI (vanilla JS, no framework, no build). |
| `schema.sql` | Database shape. Apply changes via Supabase SQL editor or MCP `apply_migration`. |
| `.env` | All secrets/config (never commit). |

## Conventions / gotchas (carried over, still true)
- **`expense_date` is TEXT**, not `date` — OCR returns messy dates; we normalise to ISO in JS. Never make it a strict `date` column or bad OCR will 400 the insert.
- **Node 20 native `fetch`/`Buffer`** only — no axios/node-fetch/multer. Use the `hreq()` helper.
- **Groq is rate-limited (429) on free tier** — `groqChat()` already has exponential backoff. Don't hammer it.
- **Receipt images** aren't stored in a bucket; they're served live from Telegram via `/receipt/:fileId` using the bot token. If you ever rotate the bot token, old receipt thumbnails stop resolving — migrate to Supabase Storage if you need permanence.
- **Webhook**: auto-registers on startup when `PUBLIC_URL` is set; otherwise register manually (`npm run setup-webhook`).
- **Category set** = Food | Petrol | Software | Inventory | Others (`normaliseExpenseCategory`). Dashboard pill colours map to these names — keep them in sync.

## Common tasks

**Add a field to the expense** (e.g. `payment_method`): add the column in `schema.sql`, extract it in the OCR prompt + `expense` object in `expenseFromPhoto()`, and show it in `public/index.html` render.

**Change OCR behaviour**: edit the prompt string inside `expenseFromPhoto()`.

**Add a new bot command**: extend `handleUpdate()` (text routing at the bottom).

## Going multi-tenant (when this becomes a real SaaS)
The single-account design is intentionally forward-compatible:
1. Add a `users`/`accounts` table; map each Telegram `chat_id` → `account_id` (a `rep_settings`-style binding table).
2. In `handleUpdate`, look up the sender's `account_id` instead of using the env constant.
3. For the dashboard, add real auth (e.g. mint a short-lived Supabase JWT with an `account_id` claim) and turn on RLS policies scoped to that claim (template is in `schema.sql`). Then the browser can talk to Supabase directly if you prefer, or keep using `/api` with a per-user token.
4. Onboard via deep link: `https://t.me/<bot>?start=<signup_code>`.

(That whole pattern — signed grants + JWT-scoped RLS — was already proven in the parent FrictionAI project; replicate it here only when you actually need multi-customer isolation.)

## Run / verify
```bash
npm install
npm start            # http://localhost:3001
npm run setup-webhook # register Telegram webhook then exit
curl localhost:3001/health
```
