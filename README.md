# SnapReceipt AI

A standalone, self-contained version of SnapReceipt AI: a **Telegram bot** that reads receipt/invoice photos with AI vision OCR and logs them as expenses, plus a **web dashboard** to view, filter, and export them.

Extracted as a clean foundation from the FrictionAI project — no leftover code, ready to extend into a multi-vertical SaaS.

```
Telegram receipt photo
      ↓  webhook
  server.js (Express)
      ↓  Groq vision OCR (llama-4-scout)
  Supabase  →  expenses table
      ↑
  Dashboard (public/index.html)  ← reads via /api/expenses
```

## What's included

| File | Purpose |
|------|---------|
| `server.js` | The whole backend: Telegram bot, OCR, expenses API, receipt image proxy, dashboard hosting, auto webhook registration. |
| `public/index.html` | Expenses dashboard — stat cards, time/category filters, Cards/Table views, CSV export, receipt thumbnails. |
| `schema.sql` | Supabase table + indexes + RLS. Run once. |
| `.env.example` | All config. Copy to `.env`. |
| `CLAUDE.md` | Guide for Claude Code (architecture, how to extend, going multi-tenant). |

## Setup (≈10 minutes)

### 1. Create the Telegram bot
- Message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**.

### 2. Set up the database
- In your Supabase project: **SQL Editor** → paste `schema.sql` → **Run**.
- Grab from **Settings → API**: the **Project URL** (`SB_URL`) and the **service-role key** (`SB_KEY`).

### 3. Configure
```bash
cp .env.example .env
```
Fill in `BOT_TOKEN`, `GROQ_KEY`, `SB_URL`, `SB_KEY`. (Get a Groq key at https://console.groq.com/keys.)

### 4. Install & run
```bash
npm install
npm start
```
The dashboard is now at **http://localhost:3001**.

### 5. Connect the bot (make it reachable over HTTPS)
Telegram only delivers to public HTTPS URLs. Two options:

**A. Local testing — ngrok**
```bash
npx ngrok http 3001
```
Put the `https://…ngrok…` URL in `.env` as `PUBLIC_URL`, restart `npm start`. The webhook auto-registers on startup.

**B. Production — your own domain/VPS**
Point a domain at the server with a valid TLS cert (Caddy or nginx + Let's Encrypt), set `PUBLIC_URL=https://yourdomain`, restart.

> Prefer to register manually? Run `npm run setup-webhook` (registers, then exits), or call
> `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/webhook`.

### 6. Test
Send a receipt photo to your bot in Telegram → it replies with the parsed expense → it appears on the dashboard. Type **"show expenses"** for an in-chat summary.

## Security notes
- The **service-role key stays on the server** — the browser never sees it. The dashboard reads through `/api/expenses`.
- Set **`WEBHOOK_SECRET`** so only Telegram can post to `/webhook`.
- Set **`DASHBOARD_TOKEN`** to gate the dashboard + API with a shared key (basic v1 protection).
- **Production MUST set `DASHBOARD_TOKEN`.** When `NODE_ENV=production` (or `AUTH_REQUIRED=true`)
  and no `DASHBOARD_TOKEN` is configured, every dashboard/API request — including
  `GET /receipt/:fileId`, which serves sensitive receipt images — is now **refused** (fail-closed)
  instead of silently letting every request through. In dev (no `NODE_ENV=production`), an
  unset token still falls back to the old permissive behavior for convenience, but every
  unauthenticated request logs a loud `console.warn` so it's never silently forgotten.
- Set **`DASHBOARD_ORIGIN`** (e.g. `https://receipts.yourdomain.com`) in production to lock
  `Access-Control-Allow-Origin` on the token-gated `/api/*` and `/receipt/*` routes down to the
  real dashboard origin. Left unset it falls back to `*`, which is fine for local dev but means
  any origin can call the bearer-token API from a browser.
- All write/AI/upload endpoints (`/api/upload`, `/api/agent`, and the shared auth gate
  `checkDash` itself) are rate-limited per IP via `lib/ratelimit.js` — tune with
  `UPLOAD_RATE_MAX`, `AGENT_RATE_MAX`, `DASH_AUTH_RATE_MAX` (see `.env.example`).
- For real multi-customer SaaS auth, see **CLAUDE.md → "Going multi-tenant"**.

## Categories
Auto-classified into **Food · Petrol · Software · Inventory · Others** (`normaliseExpenseCategory` in `server.js`). Edit that function to add your own.
