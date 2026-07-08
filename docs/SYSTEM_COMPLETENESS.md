# System Completeness Audit — the 16 layers

> **Purpose:** the Owner's "16-layer" reference (the *"Vibe Coding in a Real Tech SaaS"* stack — the layers
> that separate "a website got built" from a **proper working system**). This audits our system against each
> layer, honestly, so we know exactly what's done and what's left. Read alongside **ADR-020** (delivered
> per-client system, not a SaaS) — some layers are reduced/N-A under that model and are marked so.
>
> **Legend:** ✅ done · 🟡 partial / adequate-for-model · ❌ real gap · 🏷️ reduced/N-A for the delivered-system model.
> **Audited:** 2026-07-05; **refreshed 2026-07-08** (operationalisation pass — #7/#8/#12/#13 moved). Against `main`, **1515 tests green**.

| # | Layer | Status | Where it lives / what's missing |
|---|---|---|---|
| 1 | **System design** | ✅ | `docs/PROJECT_BRIEF.md`, `docs/DECISIONS.md` (20 ADRs), `docs/specs/*`, `docs/plans/*`. Every non-trivial choice has a written rationale. |
| 2 | **System architecture** | ✅ | `docs/ARCHITECTURE.md` (frozen interfaces §3). `server.js` = wiring only; `lib/*` one concern per file; `routes/*` thin HTTP adapters. Modularised (ADR-001). |
| 3 | **Frontend** | ✅ | `public/` — modular vanilla JS, no build, CSP-clean. All views (Overview/Activity/Upload/Manage/Reports/Settings), detail drawer, review + category-picker queues, floating **Falc** assistant, light/dark "Treehouse" theme. |
| 4 | **APIs & backend logic** | ✅ | `routes/{expenses,reports,agent,upload,templates,webhook,receipt,excel,review,misc}` + the `/api/agent/confirm` write path; domain logic in `lib/*` (ocr, categorize, anomaly, currency, reports, excel, massupload, agent, agentProposals…). |
| 5 | **Databases & storage** | ✅ | Supabase Postgres (`schema.sql`, REST, **service-role server-side only**, RLS anon-denied) **+ Supabase Storage** for durable receipt images (ADR-018). Two DB migrations documented in `db/`. |
| 6 | **Auth & permissions** | ✅ single-user · 🟡 roles | `checkDash` bearer-token gate on every `/api/*` + `/receipt`, `AUTH_REQUIRED` fail-closed, RLS. **Multi-user roles** (HQ/branch/clerk) = a **per-client option** (M2, reframed by ADR-020), not built into the base yet. |
| 7 | **Hosting & cloud** | 🟡 **deployable** | **Deploy artifacts shipped** (PR #137): `render.yaml` (default, native Node), `Dockerfile`+`fly.toml` (portable), `.dockerignore`, and a **deploy runbook** (`docs/ops/2026-07-08-deploy-runbook.md`) — always-on + HTTPS pinned, secrets injected, `/health` wired. **Still ❌ until a first *validated* deploy runs** (per-client, ADR-020 — likely Premala on Render): nothing is truly "live" until an instance is up and the webhook registers end-to-end. Config is done; the one real deploy is the remaining step. |
| 8 | **CI/CD & version control** | ✅ | **Version control ✅** — git + `.githooks/pre-push` (blocks direct-to-main), strict branch→PR→review→merge flow, WORKLOG ledger. **CI ✅** — `.github/workflows/ci.yml` runs `npm ci` + `npm test` on every PR + push-to-main (Node 20) + an informational `npm audit`. (CD is intentionally NOT wired — deploys are deliberate/per-client, `autoDeploy:false`.) |
| 9 | **Security** | ✅ strong | Strict CSP + `lib/security-headers.js` (HSTS on HTTPS, CORP, nosniff, frame-deny, no-store on data paths), server-side input validation, untrusted-output escaping (stored-XSS defense), prompt-injection hardening, secret hygiene (never logged/client-sent), card-last-4 masking, `/security-review` clean. Agentic writes gated propose→confirm (ADR-019). |
| 10 | **Rate limiting** | ✅ | `lib/ratelimit.js` on upload/agent/webhook/templates (Owner-lenient ceilings = runaway backstops), `RateLimit-*` headers surfaced. |
| 11 | **Caching & CDN** | 🏷️ mostly N/A | FX-rate cache (ADR-005); `no-store` on sensitive responses; static assets are cacheable. **CDN = N/A** for a single per-client instance. Revisit only if a client's asset load ever warrants it. |
| 12 | **Error tracking & logs** | 🟡 **improved** | **Phase 1 shipped** (PR #138): `lib/log.js` emits one structured JSON line per error (ADR-002-safe — msg + scalar route context, nested-object extras dropped), wired into the global handler; client-facing errors still sanitized (SOP §7.2). **Aggregation/alerting = platform log-drain** once hosted (the JSON lines are parseable), **decided in ADR-026**; Sentry is opt-in/DSN-gated/PII-scrubbed, deferred until a client needs it. Remaining: wire the log-drain on the first live instance. |
| 13 | **Monitoring & alerts** | 🟡 **partial** | `GET /health` (liveness) **+ `GET /ready`** (deep probe — confirms Supabase reachable, PII-free, rate-limited; PR #138). **Remaining = one ops step, not code:** an external uptime monitor (UptimeRobot → Telegram/email) pointed at `/health` (+ optional `/ready`), documented in the deploy runbook. Closes silently-down risk once the first instance is live. |
| 14 | **Testing** | ✅ **strength** | **1515 tests**, TDD throughout, hermetic (deps injected), plus adversarial / QA-report / security-QA suites and repeated **live browser** verification. This layer is well ahead of typical. |
| 15 | **Scaling** | 🟡 adequate-for-model · 🏷️ | Single Node process per client; money-safe row caps + truncation signals; Groq **key-pool** (ADR-016) multiplies AI quota. **"Scale to many tenants" = N/A** (each client = its own instance). If one client's data grows huge, move report aggregation into SQL (already noted as post-MVP). |
| 16 | **…and more** | mixed | **Backup** (ADR-015 — independent `pg_dump`, per instance) 🟡; **AI eval gate** (P8) ❌ deferred; **observability** (P7) ❌ deferred (overlaps #12/#13); **audit log for Falc writes** — currently in-memory, should be DB-backed (see `docs/FALC_AGENTIC_ROADMAP.md` #14). |

## Bottom line
**Solidly present (12/16):** design, architecture, frontend, APIs/backend, DB+storage, auth (single-user), security, rate limiting, testing, **CI (#8, now ✅)** — plus caching and scaling are *adequate or N-A* for the delivered-per-client model.

**Operationalisation (07-08 pass): the code/config is now done; what's left is one live deploy + ops config, not building.**
1. **Hosting & deploy (#7)** — artifacts + runbook shipped; the remaining step is a **first validated deploy** of a client instance (Premala on Render). *Still the #1 milestone — nothing is "live" until this runs.*
2. **Monitoring (#13)** — `/health` + `/ready` in the code; remaining = point an **external uptime monitor** at them (an ops action, minutes once there's a URL).
3. **Error tracking & logs (#12)** — structured JSON error logs shipped; remaining = enable the host's **log-drain** to a searchable service (ADR-026); Sentry stays opt-in.
4. **CI (#8)** — ✅ done (`ci.yml`).

**Reduced / flagged N-A under ADR-020 (delivered system, not SaaS):** CDN (#11), multi-tenant scale (#15), and the pure SaaS-distribution layers (public signup, billing, app-store/installer) — none of which block a client delivery.

**Per-client-option layers:** multi-user roles/branches (#6/M2) — **now built** (M2 epic #106/#107: auth, branch/company isolation, petty cash, statements); enable per client via `CAP_*` flags.

> **Recommendation:** operationalisation is no longer a *build* phase — it's an **ops/deploy** phase. The one gating action is a first validated per-client deploy (#7); the uptime monitor (#13) and log-drain (#12) are minutes-long config steps that follow it. Everything else on the 16-layer list is done or intentionally scoped down for the delivered-system model.
