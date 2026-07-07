# Deploy Runbook — standing up a client instance (SYSTEM_COMPLETENESS #7 hosting)

> Copy-paste steps to take an instance from repo → live, always-on, HTTPS. Per **ADR-020**: one small
> deploy **per client**. Companion to the **operationalisation plan** (`docs/ops/2026-07-08-operationalisation-plan.md`)
> and the **Supabase migration runbook** (`docs/ops/2026-07-07-supabase-migration-runbook.md`).
>
> **Author:** Claude-J (Opus, fable-mode, for Jeevan) · **Date:** 2026-07-08 · verified against `main`.

## 0. What you're deploying
A single stateless Node ≥20 process (`node server.js`). **All state is in Supabase** (Postgres + Storage) —
the host keeps nothing on disk, so any always-on container/PaaS works. Two host options:
- **§A Render (native Node)** — the **default**. Lowest friction, no Docker.
- **§B Fly.io (Docker)** — the portable/BYO-infra path. Uses the repo `Dockerfile` + `fly.toml`.

**Two hard requirements** (both handled below): **HTTPS** (Telegram only delivers webhooks over HTTPS) and
**always-on** (a sleeping instance silently drops webhook deliveries — so **never** the Render `free` plan or
Fly scale-to-zero).

## 1. Pre-flight (do first, both paths)
1. **Supabase provisioned** for this client — schema applied + admin created per the migration runbook. The
   instance is useless without its data plane.
2. **Secrets in hand** (you'll paste these into the host, never into git — `.env` is git-ignored and excluded
   from the image by `.dockerignore`):

   | Var | What | Notes |
   |---|---|---|
   | `BOT_TOKEN` | Telegram bot token | from @BotFather |
   | `GROQ_KEY` *(or `GROQ_KEYS`)* | Groq API key(s) | `GROQ_KEYS` = comma list for the ADR-016 pool |
   | `SB_URL` | Supabase project URL | `https://<ref>.supabase.co` |
   | `SB_KEY` | Supabase **service-role** key | server-side only, never client-exposed |
   | `WEBHOOK_SECRET` | random 32+ char string | **mandatory in prod** — `routes/webhook.js` refuses inbound calls without a matching `X-Telegram-Bot-Api-Secret-Token` |
   | `DASHBOARD_TOKEN` | random 32+ char string | dashboard bearer login |
   | `AUTH_REQUIRED` | `true` | fail-closed auth |
   | `PUBLIC_URL` | the deployed HTTPS URL | **set AFTER first deploy** (step A4/B4) — chicken-and-egg |
   | `ACCOUNT_ID` | per-client id | |
   | `ACCOUNT_TYPE` + `CAP_*` | capability profile | e.g. Premala: `business` + the flags in `docs/clients/premala.md §3` |

   Generate a secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

## §A — Render (default, native Node)
1. **New Blueprint** → point Render at this repo. It reads `render.yaml` (web service, `npm ci` / `npm start`,
   `healthCheckPath: /health`, `plan: starter`, `region: singapore`). Rename the service per client.
2. **Set the `sync: false` env vars** (BOT_TOKEN, GROQ_KEY, SB_URL, SB_KEY, WEBHOOK_SECRET, DASHBOARD_TOKEN,
   ACCOUNT_ID, ACCOUNT_TYPE, CAP_*) in the dashboard. Leave `PUBLIC_URL` blank for now.
3. **Deploy.** First boot logs `PUBLIC_URL not set — skipping auto-registration` — expected. Wait for health
   check green.
4. **Grab the URL** (`https://<service>.onrender.com`, or attach a custom domain), set **`PUBLIC_URL`** to it,
   and **redeploy**. On this boot the app auto-registers the Telegram webhook (`setWebhook → PUBLIC_URL/webhook`
   with your `WEBHOOK_SECRET`). → go to **§3 Verify**.

## §B — Fly.io (portable, Docker)
1. `fly launch --no-deploy --copy-config` (or edit `fly.toml`): set `app` (unique per client) + `primary_region`.
   Config already pins always-on (`min_machines_running = 1`, `auto_stop_machines = false`), `force_https`, and a
   `/health` check.
2. **Set secrets** (never in `fly.toml`):
   ```
   fly secrets set BOT_TOKEN=… GROQ_KEY=… SB_URL=… SB_KEY=… \
     WEBHOOK_SECRET=… DASHBOARD_TOKEN=… AUTH_REQUIRED=true \
     ACCOUNT_ID=… ACCOUNT_TYPE=business
   ```
3. `fly deploy`. First boot skips webhook registration (no `PUBLIC_URL`) — expected.
4. Your URL is `https://<app>.fly.dev`. `fly secrets set PUBLIC_URL=https://<app>.fly.dev` (this triggers a
   restart); the app auto-registers the webhook on that boot. → **§3 Verify**.

## 3. Verify (both paths — don't declare "live" until all four pass)
1. **Health:** `curl https://<url>/health` → `{"ok":true,"service":"receipt-saas",...}` (200).
2. **Webhook registered:** `curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"` → `url` is
   `https://<url>/webhook`, `pending_update_count` low, no `last_error_message`. (If not: redeploy with
   `PUBLIC_URL` set, or run `npm run setup-webhook` against the host env.)
3. **End-to-end:** send the bot a receipt photo (a bound business chat, or a personal chat if not multi-user) →
   it replies "Captured" with parsed fields. Confirms Telegram → webhook → Groq OCR → Supabase insert.
4. **Dashboard:** open `https://<url>/` and log in with `DASHBOARD_TOKEN` → the expense you just sent is listed.

## 4. Notes / gotchas
- **Rotating `BOT_TOKEN`** breaks live receipt thumbnails (served from Telegram by token — CLAUDE.md). Re-run
  webhook registration after any token change.
- **`WEBHOOK_SECRET` is not optional in prod** — without it the app refuses updates (`AUTH_REQUIRED=true`).
- **CI ≠ CD:** `.github/workflows/ci.yml` only runs tests; there is no auto-deploy. Deploys are deliberate,
  per-client, on-demand (`autoDeploy: false`). Wire CD later only if a client wants it.
- **Next ops layers** (operationalisation plan): once this is live, add the uptime ping on `/health` (#13) and
  Phase-1 structured error logs (#12).
- **Rollback:** Render → "Rollback" to the previous deploy; Fly → `fly releases` + `fly deploy --image <prev>`.
  Both are safe (stateless app; data plane in Supabase is untouched by a rollback).
