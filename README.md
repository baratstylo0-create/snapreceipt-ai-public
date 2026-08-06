# SnapReceipt AI

Send a photo of a receipt to a Telegram bot. It reads the receipt with AI vision OCR, extracts the merchant/amount/date/category, and logs it as an expense — instantly visible on a web dashboard for filtering, charting, and exporting.

```
Telegram receipt photo
      ↓  webhook
  server.js (Express)
      ↓  Groq vision OCR
  Supabase  →  expenses table
      ↑
  Web dashboard  ← reads via /api/expenses
```

## Features

- **Telegram-first capture** — send a photo, get a parsed expense back in chat; type "show expenses" for a quick summary.
- **Web dashboard** — Overview (stats + category chart), Activity feed, drag-and-drop Upload, Manage (edit/delete/bulk actions), Settings.
- **Real accounts** — email/password signup, Google Sign-In, password reset.
- **Guest mode** — try the whole product with zero signup, capped at a handful of receipts.
- **Free / Pro tiers** — a monthly free-tier receipt cap; Pro removes the cap. Billing via [HitPay](https://hitpayapp.com).
- **Exports** — CSV/Excel and PDF, from either the filtered dashboard view or the Telegram bot.
- **Multi-currency** — receipts in a foreign currency are converted to your account currency using real daily FX rates.
- **Falc** — a lightweight in-app AI assistant for asking questions about your spending.

## Stack

Node.js + Express, vanilla JS on the frontend (no build step, no framework), Supabase (Postgres) for storage, Groq for vision OCR, Telegram Bot API for capture, HitPay for subscription billing.

## Setup (≈10 minutes)

### 1. Create the Telegram bot
Message **@BotFather** → `/newbot` → follow the prompts → copy the **bot token**.

### 2. Set up the database
Create a [Supabase](https://supabase.com) project, then in **SQL Editor** paste the contents of `schema.sql` and run it.

Grab from **Settings → API**: the **Project URL** (`SB_URL`) and the **service-role key** (`SB_KEY`).

### 3. Configure
```bash
cp .env.example .env
```
Fill in `BOT_TOKEN`, `GROQ_KEY`, `SB_URL`, `SB_KEY` at minimum. Every other variable in `.env.example` is documented inline and optional for local development.

### 4. Install & run
```bash
npm install
npm start
```
The dashboard is now at **http://localhost:3001**.

### 5. Connect the bot (make it reachable over HTTPS)
Telegram only delivers to public HTTPS URLs.

**Local testing — ngrok**
```bash
npx ngrok http 3001
```
Put the `https://…ngrok…` URL in `.env` as `PUBLIC_URL`, restart `npm start`. The webhook auto-registers on startup.

**Production — your own domain/VPS**
Point a domain at the server with a valid TLS cert (Caddy or nginx + Let's Encrypt), set `PUBLIC_URL=https://yourdomain`, restart.

> Prefer to register manually? Run `npm run setup-webhook` (registers, then exits).

### 6. Test
Send a receipt photo to your bot in Telegram → it replies with the parsed expense → it appears on the dashboard.

## Security notes

- The **Supabase service-role key stays on the server** — the browser never sees it.
- Set **`WEBHOOK_SECRET`** so only Telegram can post to `/webhook`.
- Set **`DASHBOARD_TOKEN`** (or use real account signup, see `CAP_PERSONAL_AUTH` in `.env.example`) to gate access.
- In production (`NODE_ENV=production` / `AUTH_REQUIRED=true`), unauthenticated requests are refused (fail-closed) rather than silently allowed.
- Set **`DASHBOARD_ORIGIN`** in production to lock CORS down to your real dashboard origin.
- Write/AI/upload endpoints are rate-limited per IP (`lib/ratelimit.js`).

## Project structure

```
server.js              Express app entrypoint
lib/                    Core logic — OCR pipeline, auth, billing, currency, bot, etc.
routes/                 HTTP route handlers, one file per feature area
public/js/components/   Frontend screens (vanilla JS, no framework)
public/css/             Stylesheets
schema.sql              Full Supabase schema (tables, indexes, migrations)
```

## License

MIT — see [LICENSE](LICENSE).
