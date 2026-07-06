# System Completeness Audit — the 16 layers

> **Purpose:** the Owner's "16-layer" reference (the *"Vibe Coding in a Real Tech SaaS"* stack — the layers
> that separate "a website got built" from a **proper working system**). This audits our system against each
> layer, honestly, so we know exactly what's done and what's left. Read alongside **ADR-020** (delivered
> per-client system, not a SaaS) — some layers are reduced/N-A under that model and are marked so.
>
> **Legend:** ✅ done · 🟡 partial / adequate-for-model · ❌ real gap · 🏷️ reduced/N-A for the delivered-system model.
> **Audited:** 2026-07-05, against `main`. 1059 tests green.

| # | Layer | Status | Where it lives / what's missing |
|---|---|---|---|
| 1 | **System design** | ✅ | `docs/PROJECT_BRIEF.md`, `docs/DECISIONS.md` (20 ADRs), `docs/specs/*`, `docs/plans/*`. Every non-trivial choice has a written rationale. |
| 2 | **System architecture** | ✅ | `docs/ARCHITECTURE.md` (frozen interfaces §3). `server.js` = wiring only; `lib/*` one concern per file; `routes/*` thin HTTP adapters. Modularised (ADR-001). |
| 3 | **Frontend** | ✅ | `public/` — modular vanilla JS, no build, CSP-clean. All views (Overview/Activity/Upload/Manage/Reports/Settings), detail drawer, review + category-picker queues, floating **Falc** assistant, light/dark "Treehouse" theme. |
| 4 | **APIs & backend logic** | ✅ | `routes/{expenses,reports,agent,upload,templates,webhook,receipt,excel,review,misc}` + the `/api/agent/confirm` write path; domain logic in `lib/*` (ocr, categorize, anomaly, currency, reports, excel, massupload, agent, agentProposals…). |
| 5 | **Databases & storage** | ✅ | Supabase Postgres (`schema.sql`, REST, **service-role server-side only**, RLS anon-denied) **+ Supabase Storage** for durable receipt images (ADR-018). Two DB migrations documented in `db/`. |
| 6 | **Auth & permissions** | ✅ single-user · 🟡 roles | `checkDash` bearer-token gate on every `/api/*` + `/receipt`, `AUTH_REQUIRED` fail-closed, RLS. **Multi-user roles** (HQ/branch/clerk) = a **per-client option** (M2, reframed by ADR-020), not built into the base yet. |
| 7 | **Hosting & cloud** | ❌ **GAP** | **Not deployed anywhere** — runs locally (`npm start`, :3001). Needs a real host (long-running Node + HTTPS for the Telegram webhook). Under ADR-020 this is a **per-client deploy** (their infra or ours), not one public multi-tenant deploy — but it still must happen for a client to actually use it. **The #1 thing left to be "a working system."** |
| 8 | **CI/CD & version control** | 🟡 | **Version control ✅** — git + `.githooks/pre-push` (blocks direct-to-main), strict branch→PR→review→merge flow, WORKLOG ledger. **CI ❌** — no GitHub Actions; the 1059-test suite runs **manually** (`npm test`). A one-file CI workflow (run tests on PR) is a small, high-value add. |
| 9 | **Security** | ✅ strong | Strict CSP + `lib/security-headers.js` (HSTS on HTTPS, CORP, nosniff, frame-deny, no-store on data paths), server-side input validation, untrusted-output escaping (stored-XSS defense), prompt-injection hardening, secret hygiene (never logged/client-sent), card-last-4 masking, `/security-review` clean. Agentic writes gated propose→confirm (ADR-019). |
| 10 | **Rate limiting** | ✅ | `lib/ratelimit.js` on upload/agent/webhook/templates (Owner-lenient ceilings = runaway backstops), `RateLimit-*` headers surfaced. |
| 11 | **Caching & CDN** | 🏷️ mostly N/A | FX-rate cache (ADR-005); `no-store` on sensitive responses; static assets are cacheable. **CDN = N/A** for a single per-client instance. Revisit only if a client's asset load ever warrants it. |
| 12 | **Error tracking & logs** | 🟡 **partial** | Server-side `console.error` at every failure site; client-facing errors sanitized (never leak internals, SOP §7.2). **Missing:** a structured error-tracking service (Sentry-style) + log aggregation/retention. For a delivered instance we should at least ship logs to a file/service the operator can search. **Gap for production ops.** |
| 13 | **Monitoring & alerts** | ❌ **GAP** | Only a basic `GET /health`. **No uptime monitoring, no alerting** (P7 observability was deferred). A client instance going down silently is the risk. Even a simple external uptime ping + a "webhook/AI failing" alert would close most of this. |
| 14 | **Testing** | ✅ **strength** | **1059 tests**, TDD throughout, hermetic (deps injected), plus adversarial / QA-report / security-QA suites and repeated **live browser** verification. This layer is well ahead of typical. |
| 15 | **Scaling** | 🟡 adequate-for-model · 🏷️ | Single Node process per client; money-safe row caps + truncation signals; Groq **key-pool** (ADR-016) multiplies AI quota. **"Scale to many tenants" = N/A** (each client = its own instance). If one client's data grows huge, move report aggregation into SQL (already noted as post-MVP). |
| 16 | **…and more** | mixed | **Backup** (ADR-015 — independent `pg_dump`, per instance) 🟡; **AI eval gate** (P8) ❌ deferred; **observability** (P7) ❌ deferred (overlaps #12/#13); **audit log for Falc writes** — currently in-memory, should be DB-backed (see `docs/FALC_AGENTIC_ROADMAP.md` #14). |

## Bottom line
**Solidly present (12/16):** design, architecture, frontend, APIs/backend, DB+storage, auth (single-user), security, rate limiting, testing — plus caching and scaling are *adequate or N-A* for the delivered-per-client model.

**The real gaps to be a proper working system — in priority order:**
1. **Hosting & deploy (#7)** — get an instance actually running on a real host with HTTPS. Nothing is "live" until this is done. *(Biggest.)*
2. **Monitoring & alerts (#13)** — at minimum an uptime ping + failure alert so a down instance is noticed.
3. **Error tracking & logs (#12)** — ship logs somewhere searchable per instance; consider a lightweight error tracker.
4. **CI automation (#8)** — a GitHub Actions workflow that runs `npm test` on every PR (cheap, high value).

**Reduced / flagged N-A under ADR-020 (delivered system, not SaaS):** CDN (#11), multi-tenant scale (#15), and the pure SaaS-distribution layers (public signup, billing, app-store/installer) — none of which block a client delivery.

**Per-client-option layers:** multi-user roles/branches (#6/M2) — build for a client who wants it.

> **Recommendation:** the next build phase is **operationalisation** — #7 hosting → #13 monitoring → #12 logs → #8 CI. That turns "feature-complete on a laptop" into "a client's system that stays up and is debuggable." Everything else on the 16-layer list is either done or intentionally scoped down for the delivered-system model.
