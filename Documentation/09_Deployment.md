# Deployment

## Purpose
How a client instance goes from repository to a live, always-on, secure service.

## Overview
A single **stateless Node.js (≥20) process** — all state in Supabase, so any always-on host works and rollbacks are safe. Model: **one small deployment per client**. Two supported hosts: **Render** (native Node, default) and **Fly.io** (Docker, portable). Two hard requirements: **HTTPS** (Telegram requires it) and **always-on** (no free/scale-to-zero plans).

## Key Components
| Item | Role |
|---|---|
| `render.yaml` | Render blueprint (build/start, health check, region) |
| `Dockerfile` + `fly.toml` | Fly.io container + always-on config |
| Environment variables | Secrets + capability profile (never committed) |
| Supabase project | Data plane — schema applied, first admin created |
| `npm run setup-admin` | One-time CLI to mint the first business admin |
| `npm run setup-webhook` | Registers the Telegram webhook against the host URL |

### Required environment variables
| Var | What |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `GROQ_KEY` / `GROQ_KEYS` | AI provider key(s) — comma list enables rotation |
| `SB_URL` / `SB_KEY` | Supabase URL + service-role key |
| `WEBHOOK_SECRET` | Random 32+ chars — mandatory in production |
| `DASHBOARD_TOKEN` | Random 32+ chars — dashboard login |
| `AUTH_REQUIRED` | `true` — fail-closed auth |
| `PUBLIC_URL` | Deployed HTTPS URL — set **after** first deploy |
| `ACCOUNT_ID`, `ACCOUNT_TYPE`, `CAP_*` | Per-client id + capability profile |

## How It Works
1. **Pre-flight:** Supabase provisioned (schema + first admin); secrets in hand.
2. **First deploy:** builds and boots (webhook registration skipped until `PUBLIC_URL` set — expected).
3. **Set `PUBLIC_URL`** to the live HTTPS URL, redeploy → app auto-registers the Telegram webhook.
4. **Verify (all four):** `/health` ok → `getWebhookInfo` shows the URL, no errors → send a receipt end-to-end → log in to the dashboard and see it.

## Self-hosted VPS (self-signed cert)

Render/Fly (above) cover a domain + a real, CA-trusted cert. A **self-hosted VPS with a self-signed cert** — Premala's live deployment (`docs/ops/2026-07-08-new-vps-deploy-record.md`) — is the **opposite** procedure, because Telegram will not trust a self-signed host unless the certificate itself is uploaded alongside the webhook URL.

1. **Leave `PUBLIC_URL` empty.** The app's own auto-`registerWebhook()` sends a certless JSON `setWebhook` call, which would silently overwrite (and break) the cert-bearing webhook on every restart if `PUBLIC_URL` were set.
2. **Register the webhook manually**, uploading the same `.pem` your reverse proxy (nginx) serves:
   ```bash
   curl -F "url=https://<host>/webhook" \
        -F "certificate=@/etc/nginx/ssl/receipt.pem" \
        -F "secret_token=<WEBHOOK_SECRET>" \
        https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
   ```
3. **Verify** the same way as the standard path (§4 above) — `getWebhookInfo` should show the URL with no errors.

`npm run setup-webhook` / `registerWebhook()` as originally written send a certless JSON body and do **not** work for a self-signed host — that's why step 2 above is manual today. A follow-up (`WEBHOOK_CERT_PATH` env var, self-hosted-cert-aware `registerWebhook()`) codifies this same multipart upload so it no longer needs a manual `curl` — **Requires Manual Review** for current merge status.

## Notes
- CI ≠ CD — tests run on every change; deploys are deliberate and on-demand.
- Rotating the bot token breaks live receipt thumbnails — re-register the webhook after any change.
- Rollback is safe on both hosts (stateless app; Supabase untouched).
- Uptime monitoring on `/health` and log aggregation are operational follow-ups — **Requires Manual Review**.
