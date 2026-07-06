# Security audit + hardening — M2 / Premala launch gate

> **Owner:** Jeevan (CTO hat). **Date:** 2026-07-07. **Status:** Accepted posture + open hardening list.
> Trigger: Owner "make sure everything is secure, no hackers, no raw data can infiltrate/inject our DB,
> make sure RLS are all there" + the *Vibe Coder Security Checklist* + a video on file storage.
> Feeds **ADR-025**. Applies to the M2 business layer (ADR-021/022/023) and every client deployment.
> **Rule:** this is a **launch gate** — no paying-client instance goes live until the ⚠️ items below are closed.

## 0. Posture in one paragraph
The system is already **security-forward**: server-side-only DB access with the service-role key (browser
never touches Supabase), a fail-closed auth gate, per-IP rate limiting, a strict no-inline CSP, generic
error responses, no raw SQL, no secrets in the frontend, and RLS enabled on every table. The M2 business
layer adds **auth roles + cross-branch isolation + file storage + more untrusted input**, which is where
the new risk concentrates. Defense is layered: **(1) physical per-deployment isolation** (managed silos,
ADR-020 — a different company literally cannot reach another's DB), **(2)** the single **`scopeForUser`
bouncer** for within-company branch scoping, **(3)** RLS + service-role mediation at the DB, **(4)**
validation/rate-limiting/CSP at the edges. JWT-scoped RLS is the roadmap belt-and-suspenders (§3).

## 1. Vibe Coder Security Checklist — mapping to our system (evidence-based)
Legend: ✅ in place · ⚠️ gap to close (→ SEC-n in §7) · N/A.

### Frontend
| Item | State | Evidence / action |
|---|---|---|
| Exposed API keys | ✅ | `grep public/` for keys = clean; Supabase service key is server-only; browser calls `/api/*` only. |
| No input validation | ✅/⚠️ | Server-side today (`sanitizeExpensePatch`, `lib/expenseValidation`, template label sanitisation). Add validation for the **new M2 forms** (login/branch/float/period) → **SEC-5**. |
| Unsafe forms | ⚠️ | New M2 forms need strict field allowlists (float=numeric≥0, period=`YYYY-MM`, names length-capped) → **SEC-5**. |
| Weak password rules | ⚠️ | Auto-generated clerk creds are strong random (good). Enforce a **min policy** when an admin sets/reset a password → **SEC-1**. |
| Missing error handling | ✅ | Global handler returns generic `{error:'invalid request'}`, no stack traces / internals (`server.js`). |
| Exposed admin pages | ⚠️ | M2 admin vs clerk views must be gated **server-side** (`scopeForUser`/role), never UI-hide only → **SEC-2**. |
| Unsafe redirects | ✅ | No open redirects; the only deep-link is our own Telegram `/start <token>`. |
| Missing CSP | ✅ | `lib/security-headers.js` — strict no-inline CSP + hardening headers on every response. |
| Sensitive data in localStorage | ⚠️ | Auth **token is in `sessionStorage`** (good). But `overview.js` keeps an **offline expenses cache in `localStorage`** (financial data at rest in the browser) → **SEC-4** (gate off under `multiUser`, clear on logout). |
| No rate limit on public forms | ✅/⚠️ | `login`/`webhook`/`templates`/`upload` limited. Extend to **all** new M2 routes → **SEC-7**. |

### Backend
| Item | State | Evidence / action |
|---|---|---|
| Broken access control | ⚠️ | **The #1 M2 risk.** `scopeForUser` bouncer is the wall (app-side now). Every business/branch query funnels through it; **isolation tests mandatory** → **SEC-2**. Physical silo isolation bounds any bug to *within* one company. |
| No authentication check | ✅ | `checkDash` on every `/api`; session-aware in business mode (ADR-021 Phase 1). |
| SQL injection | ✅ | **No raw SQL in app code** (`grep` clean). All DB access via PostgREST with `encodeURIComponent` on values; RPC args parameterised. Raw SQL exists only in `schema.sql` (migrations). |
| Insecure API routes | ✅ | All `/api` gated + rate-limited; CORS tightened to `DASHBOARD_ORIGIN` in prod. |
| Exposed env vars | ✅ | `.env` git-ignored, never client-sent; `assertConfig` surfaces missing secrets at boot; secrets never logged (ADR-002). |
| Weak session handling | ✅ | Opaque 32-byte tokens, only the **sha-256 stored**, 12h TTL, expiry checked, revoke-on-logout (Phase 1 `lib/auth.js`). |
| No server-side validation | ✅/⚠️ | Present; extend to M2 writes — `payment_status` **admin-only**, float numeric, period format → **SEC-5**. |
| Unsafe file uploads | ⚠️ | Have byte/pixel caps (PDF bomb defense), `MASS_MAX_IMAGES`, xlsx 2 MB cap. Add **magic-byte/content-type validation** + store to the **bucket, not a DB blob** (ADR-018) → **SEC-3**. |
| Missing rate limits | ✅/⚠️ | `lib/ratelimit.js` present; **generous-but-on** for the first client (env-tunable defaults) → **SEC-7**. |
| Poor error messages | ✅ | Generic client errors; details only in server logs. |
| No logging for suspicious activity | ⚠️ | Failed auth is warn-logged, but no structured **security event log** (failed login, scope-deny, rate-limit hit) → **SEC-6** (no PII). Ties to 16-layer #12/#13. |
| Unprotected payment/checkout | N/A | No billing/checkout (ADR-020). `payment_status` is **internal reimbursement** tracking — admin-only write, guarded → **SEC-5**. |

### Practical habits
Env vars ✅ · never paste keys into AI chats ✅ (policy) · **review AI-written auth** = Tier-2 cross-review
(SOP) · **dependency checks** → add `npm audit` to CI (**SEC-9**, 16-layer #8) · test login/logout = Phase 1
tests ✅ · strong admin passwords → **SEC-1** · HTTPS in prod = hosting gate (16-layer #7) · keep packages
updated (**SEC-9**).

## 2. File storage — the video's advice = our ADR-018 (already correct by design)
The video ("move files OUT of the DB → object storage → CDN → store a URL string, not a blob") is **exactly
ADR-018**, and we already follow the standard:
- **We never store file blobs in Postgres.** Schema columns are `receipt_file_id text` + `receipt_url text`
  (strings); `ai_raw`/`line_items` are small JSON, not files. No `bytea`/blob column exists.
- **Files → Supabase Storage** (S3-style **object storage**), private `receipts` bucket, service-role only
  (ADR-018). The DB row holds the **`receipt_url` string**, per the video's step 3.
- **CDN:** Supabase Storage serves via its built-in CDN — satisfies the video's step 2. (Confirm CDN/cache
  headers at deploy.)
- **Hardening this adds (→ SEC-3):** validate the uploaded bytes are a real image/PDF (magic bytes, not just
  the claimed content-type) before storing; keep the bucket **private** (signed URLs / proxy via
  `routes/receipt.js`), never public-read.
**Status:** ADR-018 is a **required prerequisite** for business accounts (statement exports embed receipts).

## 3. RLS everywhere (+ the honest caveat)
- **Every table has RLS enabled and NO permissive anon/public policy** → anon is denied by default; only the
  **service-role key (server-side) reaches data.** Verified on `schema.sql` (5/5 tables) and enforced for the
  new M2 tables (`branches`/`users`/`sessions`/`bot_bindings` already; **`companies`/`petty_cash_floats`/
  `cash_in` must too** — **SEC-8**, hard rule: *no new table without `enable row level security`*).
- **Honest caveat (ADR-021):** the service-role key **bypasses RLS**, so RLS today is a wall against *direct
  anon/DB access*, **not** the within-company branch isolation — that is the app-side `scopeForUser` bouncer
  (**SEC-2**). Cross-**company** leakage is impossible regardless (separate DB per deployment, ADR-020).
- **Roadmap (SEC-10):** JWT-scoped RLS keyed on `account_id`/`branch_id` as belt-and-suspenders over the
  app-side scope — templates already commented in `schema.sql`.

## 4. Injection & untrusted-input defense (DB can't be "infiltrated/injected")
- **SQL injection:** structurally prevented — no string-built SQL; PostgREST treats query values as data,
  values `encodeURIComponent`-escaped (`lib/supabase.js` `qEq`). RPC args are named parameters.
- **Stored-data poisoning:** template import (CSV + xlsx) maps headers to a **canonical FieldSpec** (unknown
  → safe `text`), bounded by `MAX_COLS`, labels sanitised (issue #17). OCR/model text is treated as
  **untrusted DATA, never instructions** (the "caged data" framing in `lib/categorize.js`/`lib/agent.js`).
- **XSS:** strict CSP (no inline) + the frontend escapes rendered values (`tests/frontend/escape.test.js`).
- **File uploads:** → SEC-3 (magic-byte validation + private bucket).

## 5. Rate limiting — "generous for the first client, but present"
- `lib/ratelimit.js` (fixed-window per-IP, env-tunable) is the shared limiter. Posture for Premala: **on
  everywhere but generous** — raise the per-window caps via env (`DASH_AUTH_RATE_MAX`, `LOGIN_RATE_MAX`,
  `TEMPLATES_RATE_MAX`, `WEBHOOK_RATE_MAX`, new `BRANCHES_RATE_MAX`/`STATEMENT_RATE_MAX`) so a real team is
  never throttled, while brute-force/cost-drain is still blunted. **Failed** auth is what gets limited, not
  valid traffic (Review A#1). → **SEC-7** ensures no M2 route ships without a limiter.

## 6. Logging & monitoring (16-layer gaps #12/#13)
Add a minimal **security event log** (structured, **no PII / no images / masked card last-4**): failed
logins, `scopeForUser` denials, rate-limit trips, admin privileged actions (float edits, bulk mark-paid,
branch revoke). → **SEC-6**. Full log-aggregation + alerting is the operationalisation phase (16-layer
#12/#13, `docs/SYSTEM_COMPLETENESS.md`).

## 7. Hardening backlog (the launch-gate checklist — folded into the plan as a Security Gate)
| ID | Item | Owner | Blocks live? |
|---|---|---|---|
| SEC-1 | Password min-policy on admin-set/reset (`lib/auth.js`) | Jeevan | yes |
| SEC-2 | Server-side role gating + `scopeForUser` on every business route + **isolation tests** | Jeevan (+Barat scope hook) | **yes** |
| SEC-3 | File-upload magic-byte/content-type validation + store to private bucket (ADR-018), signed/proxied reads | Jeevan/Barat | yes |
| SEC-4 | Business offline-cache: gate `localStorage` expense cache off under `multiUser`, clear on logout | Jeevan | yes |
| SEC-5 | Server-side validation for all M2 writes (float numeric, period `YYYY-MM`, name caps, `payment_status` admin-only) | Jeevan | yes |
| SEC-6 | Security event logging (no PII) | Jeevan | recommended |
| SEC-7 | Rate limiter on every M2 route (generous env defaults) | Jeevan/Barat | yes |
| SEC-8 | `enable row level security` on **every** new M2 table (companies/floats/cash_in/…) | Jeevan | **yes** |
| SEC-9 | `npm audit` (dependency scan) in CI + package updates | Jeevan (CI) | recommended |
| SEC-10 | JWT-scoped RLS (belt-and-suspenders over app-side scope) | Jeevan/Barat | roadmap |

## 8. 16-layer status (delivered-system completeness)
12/16 solid (`docs/SYSTEM_COMPLETENESS.md`); this doc reinforces **auth/security/rate-limiting/testing**.
The real remaining gaps are the operationalisation layers — **hosting/HTTPS (#7), monitoring/alerts (#13),
error-tracking/logs (#12, partly SEC-6), CI incl. dependency scan (#8, SEC-9)** — to close before a paying
client goes live.
