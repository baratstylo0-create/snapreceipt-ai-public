# Operationalisation Plan — turning "feature-complete on a laptop" into a live, debuggable client instance

> **Scope:** the four "operationalisation" layers that `docs/SYSTEM_COMPLETENESS.md` names as the real
> gap between a built system and a *proper working system* — **#7 hosting, #13 monitoring, #12 logs, #8 CI**.
> Framed under **ADR-020** (delivered per-client system, not a public SaaS): each client gets **their own
> instance**, so "hosting" means *one small always-on deploy per client*, not one multi-tenant fleet.
>
> **Author:** Claude-J (Opus, fable-mode, for Jeevan) · **Date:** 2026-07-08 · audited against `main`.
> This **supersedes the ops rows of `SYSTEM_COMPLETENESS.md`** (2026-07-05), which are stale on #8.

## 0. Current state (verified 2026-07-08, not from the 07-05 audit)

| Gap | Audit (07-05) | **Actual now** | Note |
|---|---|---|---|
| **#8 CI** | ❌ none | ✅ **DONE** | `.github/workflows/ci.yml` (added 07-06): `npm ci` + `npm test` on every PR + push-to-main, Node 20, + informational `npm audit`. The audit predates it. |
| **#7 Hosting** | ❌ gap | ❌ **gap** | No deploy config anywhere. Still `npm start` on `:3001` locally. **The #1 blocker to "live".** |
| **#13 Monitoring** | ❌ gap | ❌ **gap** | Only `GET /health` (`routes/misc.js`). No external uptime check, no alerting. |
| **#12 Logs/errors** | 🟡 partial | 🟡 **partial** | `console.error` at every failure site + sanitized client errors (SOP §7.2) + a global error handler (`server.js`). No retention/search, no error tracker. |

**So the live work is #7 → #13 → #12. #8 is already closed.**

## 1. The fact that shapes everything: the app is stateless

All durable state lives in **Supabase** — Postgres (`schema.sql`, service-role, RLS) **and** Storage for receipt
images (ADR-018). The Node process keeps **nothing** on local disk (dashboard auth is a bearer token; business
sessions are Supabase rows). Consequences for hosting:

- **Any stateless container/PaaS works** — no volumes, no sticky sessions, horizontal-restart-safe.
- **HTTPS is mandatory** — Telegram only delivers webhooks to an HTTPS URL. The app auto-registers
  `setWebhook → PUBLIC_URL/webhook` on boot (`lib/telegram.js:61`) when `PUBLIC_URL` is set.
- **Avoid scale-to-zero serverless** (Vercel/Lambda): a long-running Telegram bot + webhook + no build step +
  the WASM `@hyzyla/pdfium` rasteriser fit a **small always-on process**, not cold-start functions. A sleeping
  instance silently misses webhook deliveries.
- **Runtime:** Node ≥20 (`engines`), single process, `node server.js`, `PORT` from env (default 3001).

## 2. #7 Hosting & deploy — the blocker *(priority 1)*

**Minimum viable:** one always-on Node ≥20 process per client, public HTTPS, secrets injected as env vars,
`PUBLIC_URL` set to the deployed URL, `/health` wired to the platform's health check.

**Recommendation — default: [Render](https://render.com) native Node service.** Lowest friction for a
per-client instance: native Node runtime (no Dockerfile needed), automatic HTTPS on a `*.onrender.com`
subdomain (or custom domain), env-var secrets in the dashboard, built-in health-check path (`/health`),
always-on on the paid-but-cheap instance (the free tier sleeps — **not acceptable** for a webhook bot, so use
the smallest paid instance). Deliverable: a committed `render.yaml` (service type `web`, `healthCheckPath:
/health`, `startCommand: npm start`) + a deploy runbook.

**Portable alternative — [Fly.io](https://fly.io) (Docker).** For a client who wants their own infra/region or
container portability: a small `Dockerfile` (node:20-slim, `npm ci --omit=dev`, `CMD npm start`) + `fly.toml`
(always-on `min_machines_running = 1`, `[http_service]` with `/health` check, anycast HTTPS). More control,
slightly more ops.

**Cheapest-at-scale — VPS + Caddy.** Hetzner/DO small box + Caddy reverse proxy (automatic Let's Encrypt HTTPS)
+ a `systemd` unit or `pm2` for restart-on-crash. Lowest $/mo, highest hands-on overhead. Document as the
"bring-your-own-server" path.

**Secrets a deploy must set** (never committed — `.env` is gitignored): `BOT_TOKEN`, `GROQ_KEY`/`GROQ_KEYS`,
`SB_URL`, `SB_KEY` (service role), `WEBHOOK_SECRET`, `DASHBOARD_TOKEN`, `AUTH_REQUIRED=true`, `PUBLIC_URL`,
plus per-client `ACCOUNT_TYPE`/`CAP_*` profile and `ACCOUNT_ID`. (Full surface: `.env.example`.)

**Deliverables:** (a) `render.yaml` **and** `Dockerfile`+`fly.toml` (cover both default + portable);
(b) a **deploy runbook** (`docs/ops/…-deploy-runbook.md`) — set secrets → deploy → confirm `/health` 200 →
confirm webhook registered (`getWebhookInfo`) → send a test receipt end-to-end. **Effort: S–M** (config is
small; the real work is one validated real deploy).
**Owner:** Jeevan (setup/CI lane). No app-code change needed — it's config + runbook.

## 3. #13 Monitoring & alerts *(priority 2 — trivial once there's a URL)*

**Minimum viable:** an external uptime monitor pinging `/health` every 1–5 min with an alert on failure.
A client instance going down silently is the actual risk.

**Recommendation:** **UptimeRobot** (free) or **Better Stack/Cronitor** — external HTTPS ping to
`PUBLIC_URL/health`, alert to **Telegram** (we already run a bot) or email. External-by-design: it must sit
*outside* the instance so it catches a total-down.

**Worth adding — a `/ready` deep check** (distinct from `/health` liveness): a lightweight endpoint that does
one cheap Supabase `select` (and optionally a Groq reachability check) so "process up but Supabase unreachable"
is distinguishable from healthy. Keep it cheap and unauthenticated-safe (no data, no PII, just `{ok, deps:{db,
ai}}`); rate-limit it. *(Touches `routes/misc.js` — small, my lane-adjacent; propose, don't build under this
scoping task.)*

**Deliverables:** external-monitor setup steps in the deploy runbook; optional `/ready` endpoint (separate small
PR). **Effort: S.** **Owner:** Jeevan.

## 4. #12 Error tracking & logs *(priority 3)*

**Current:** `console.error` at every failure + sanitized client responses (never leak internals) + a global
error handler in `server.js`. Once hosted, the platform (Render/Fly) **captures stdout/stderr automatically** —
so basic log *access* is free the moment #7 lands. The gap is **retention, search, and error alerting**.

**Phased recommendation (respect the two-runtime-deps ethos + ADR-002 "no PII/images in logs"):**
- **Phase 1 (with #7, ~free):** turn on the platform's log retention; make the global error handler emit a
  **structured single-line JSON** for errors (timestamp, route, message — **never** body bytes/PII/card data),
  so platform log search is useful. No new dependency.
- **Phase 2 (optional, per-client, if warranted):** add **Sentry** (`@sentry/node`) for exception capture +
  alerting. **Gated on a strict `beforeSend` PII scrub** (receipts are financial PII — ADR-002) and a new ADR,
  since it ships data to a third party. Only for a client who needs it; not the default.

**Deliverables:** Phase-1 structured-error log line (small PR, `server.js`); Sentry deferred behind an ADR.
**Effort: S** (Phase 1) / **M** (Phase 2 with scrubbing). **Owner:** Jeevan.

## 5. Sequencing & summary

1. **#7 Hosting** — nothing is live without it, and #12/#13 partly ride on the platform once it exists
   (platform logs, platform health probe). *Do first; one validated deploy is the milestone.*
2. **#13 Monitoring** — an uptime ping is ~10 minutes once there's a public URL.
3. **#12 Logs** — Phase-1 structured errors + platform retention; Sentry only if a client needs it.
4. **#8 CI** — ✅ already done.

**Flagged N/A under ADR-020:** CDN (#11), multi-tenant scale (#15), public signup/billing/app-store — none block
a client delivery.

**One-line status after this plan lands:** we know *exactly* how to take a client instance from laptop to a
monitored, debuggable, always-on HTTPS deploy — the remaining work is config + one real deploy per client, not
architecture.
