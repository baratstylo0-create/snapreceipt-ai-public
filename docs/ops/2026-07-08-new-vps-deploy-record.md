# Deploy Record — receipt-analyser on the new VPS (Premala instance, self-hosted)

> First live self-hosted deployment of the receipt-analyser (Premala instance) onto a VPS, as an
> alternative to the Render/Fly path in `docs/ops/2026-07-08-deploy-runbook.md`. This box will also become
> the home of the migrated FrictionAI CRM stack (n8n + frictionai bot + quote-server + falcon), tracked
> separately — that migration is **deferred**; only receipt-analyser is live here so far.
>
> **Author:** Claude-J (Opus, fable-mode, for Jeevan) · **Date:** 2026-07-08 · verified live on the box.

## Target box

| | |
|---|---|
| Public IP | `31.97.70.50` (hostname `srv1813710`) |
| OS | Ubuntu 24.04.4 LTS (Noble) — newer than the current CRM box's 22.04; no functional difference |
| Specs | 2 vCPU · ~8 GB RAM · ample disk |
| Provider | same as the current CRM box `187.77.139.87` (both run the provider `monarx-agent`) |
| Access from Windows | key-based SSH via `C:\n8n_scripts\vps2.ps1` (run) + `vpsput2.ps1` (upload); private key `C:\Users\Asus\.ssh\newvps_ed25519` (public key installed in the box's `/root/.ssh/authorized_keys`) |

## What's installed (base stack — mirrors the current CRM box, minus tradeflow)

Node 20 (v20.20.2) · PM2 (7.0.3, `pm2-root` systemd unit **enabled** → survives reboot) · nginx 1.24 ·
Python 3.12 (+venv; note PEP 668 → Python services use a venv, not global pip) · n8n (global, for the later
CRM migration) · **ufw firewall: only 22/80/443 open** (app ports internal, proxied by nginx — same as the
current box).

## receipt-analyser deployment

- **Code:** `/opt/receipt-analyser` (transferred from the local repo working tree; `npm install --omit=dev`).
- **Process:** `pm2 start server.js --name receipt-analyser` on **PORT=3005** (chosen to avoid the CRM ports
  3001/5001/5678/3002 when that stack migrates here). `pm2 save` done.
- **Config:** `/opt/receipt-analyser/.env` = the Premala profile — Supabase `xurnpvesgcybrnilxszf`, Groq key
  pool, `ACCOUNT_TYPE=business`, `CAP_*` = Premala (`multiUser/companyDimension/pettyCash/branchSubmission`
  ON; `liveMasterMerge/excelLiteGrid` OFF), `DEFAULT_CURRENCY=MYR`. `BOT_TOKEN` **empty** (see Pending).
- **nginx:** `/etc/nginx/sites-available/receipt-analyser` is the default_server on **:80 and :443**, proxying
  to `127.0.0.1:3005`. **:443 uses a self-signed cert** (`/etc/nginx/ssl/receipt.{pem,key}`, CN=IP) — fine for
  the dashboard and (with the cert uploaded to Telegram) for the bot webhook; swap for a real cert once a
  domain exists.
- **Admin login:** `premala-admin` password was **reset in-place** (not via `setup-admin --force`, which would
  mint a *duplicate* admin + branch — see `setup/provision.js`); reset by hashing a fresh password with the
  app's own `lib/auth.hashPassword` and PATCHing the row. Credentials handed to the Owner out-of-band (shown
  once, not stored here). **Change before go-live.**

## QA — verified live on the box (2026-07-08)

All via the app's own endpoints (admin session minted through `lib/auth.mintSession`, no password on any
command line). Every test row was cleaned up.

| System | Result |
|---|---|
| `/health`, `/ready` (Supabase deep probe) | ✅ `db: up` |
| Dashboard served, public over HTTP **and** HTTPS | ✅ |
| Auth: login 200+token · no-token 401 · bad-creds 401 · empty 400 | ✅ |
| SEC-6 security event logging | ✅ live (auth-fails logged) |
| Expenses · Reports · Companies · Branches · Staff · Submissions · Review · Settings | ✅ all 200 |
| Petty-cash engine (float/balance) | ✅ |
| Statement export — xlsx **and** pdf | ✅ both render |
| Excel export | ✅ |
| **OCR pipeline** (synthetic receipt → Groq vision → insert) | ✅ **accurate**: merchant, total (not subtotal), MYR, category, DD/MM→ISO date, branch stamp all correct in ~2.6 s |
| Write flows: company create/delete · cash-in create/delete | ✅ |
| Dashboard AI agent (`/api/agent`) | ✅ correctly answered "13 expenses, MYR 1171.28" |

## Pending

1. **Telegram bot** — `BOT_TOKEN` empty (Barat's lane: `routes/webhook.js`, `lib/bot.js`). Once provided:
   set it in the box `.env`, set `PUBLIC_URL=https://31.97.70.50`, restart, and register the webhook
   (self-signed cert must be uploaded to Telegram via the `certificate` param). Then QA the
   photo→OCR→Supabase capture path.
2. **Real TLS cert** — currently self-signed. Move to Let's Encrypt once a domain is pointed at the box.
3. **Rotate** the reset admin password + the dev-context `.env` secrets before real customer use (per ADR-015).
4. **CRM migration** (deferred) — inventory captured; the one non-reproducible piece is n8n's data at
   `/opt/frictionai/n8n-data/.n8n/database.sqlite` on the old box. When resumed: build-verify-then-cutover,
   keep `187.77.139.87` alive until its expiry (≈3 days from 2026-07-08), repoint every hardcoded
   `187.77.139.87` reference + the Telegram webhooks at cutover.

## Handy commands

```powershell
# run a command on the new box
powershell -File C:\n8n_scripts\vps2.ps1 "pm2 list"
# upload a file to the new box
powershell -File C:\n8n_scripts\vpsput2.ps1 -Local <local> -Remote <remote>
```
```bash
pm2 restart receipt-analyser        # after an .env / code change
pm2 logs receipt-analyser --lines 50
curl -sk https://31.97.70.50/health
```
