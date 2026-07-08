# Staging Security-Scan Runbook — the pre-handover "can an outsider get in?" pass

> Copy-paste steps to run **once** against a freshly-deployed **staging** instance, before you hand a client
> the keys. Closes launch-gate item **SEC-9 (external scan)** from the security-hardening audit
> (`docs/specs/2026-07-07-security-hardening-audit.md`). Everything else in that audit is verified in code +
> tests; this is the one check that needs a **live URL an attacker could reach**, so it can only run
> post-deploy.
>
> **Author:** Claude-J (Opus, fable-mode, for Jeevan) · **Date:** 2026-07-08 · verified against `main`.
> Companion to the **deploy runbook** (`docs/ops/2026-07-08-deploy-runbook.md`) and the
> **security-hardening audit** (`docs/specs/2026-07-07-security-hardening-audit.md`).

## 0. When to run this (and against what)

Run this the moment a **staging** instance is live over HTTPS and before the client starts using it for real.

- **Staging, not production-with-real-data.** Point it at a throwaway Supabase project (or a clean instance),
  because step 4 deliberately sends bad logins and cross-branch reads — you don't want that traffic (or a
  stray automated write) touching a client's real ledger. If you must run against the real instance, do it
  **before** any real receipts exist and **read-only** (skip the write probes in §4.5).
- **You need two clerk logins in two different branches** to prove branch isolation (§4.4). Provision them
  with the migration runbook's `setup-admin` + two `POST /api/branches` (admin) before you start.
- Budget ~30 minutes. Automated scan is unattended; the manual auth probes are the part that actually matters
  for this system.

Three layers, cheapest first:

| Layer | Tool | Catches | Time |
|---|---|---|---|
| §2 Dependencies | `npm audit` | Known-CVE packages | 30s |
| §3 Web surface | OWASP ZAP baseline | Missing headers, XSS/CSRF surface, info leaks | ~5 min |
| §4 **Auth + isolation** | manual probe checklist | **The thing that matters here** — broken access control, cross-branch leak | ~15 min |

ZAP does **not** understand our branch/role semantics, so it **cannot** find a cross-branch leak — that is
what §4 is for. Do not skip §4 because §2/§3 came back green.

## 1. Pre-flight

```bash
# from the repo root, on the deployed commit
export STAGING=https://<your-staging-host>            # e.g. https://premala-staging.onrender.com
curl -s $STAGING/health | jq .                        # must return {ok:true,...}
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/ready # 200 = DB+Storage reachable; 503 = degraded
```

Have ready:
- `ADMIN_USER` / `ADMIN_PASS` — the provisioned admin.
- `CLERK_A_USER`/`CLERK_A_PASS` in **branch A**, `CLERK_B_USER`/`CLERK_B_PASS` in **branch B**.
- One expense **id** that belongs to **branch B** (create it as clerk B; you'll try to read it as clerk A).
- A second terminal tailing the host logs (Render/Fly dashboard, or `flyctl logs`) — you'll watch the
  **SEC-6 security events** fire live in §5.

## 2. Dependency scan (`npm audit`)

CI already runs this on every push, but re-run against the exact deployed lockfile:

```bash
npm ci --omit=dev          # install exactly what ships
npm audit --omit=dev       # runtime deps only (dev-only CVEs don't reach production)
```

**Gate:** zero `high`/`critical` in runtime deps. A `moderate` is a judgement call — record it in §7 with a
reason if you accept it. Remember runtime deps here are tiny (`express`, `dotenv`, `pdfkit`, `exceljs`), so a
finding is rare and usually a one-line bump.

## 3. Web-surface scan (OWASP ZAP baseline)

The ZAP **baseline** scan is passive + a few safe active checks — it will **not** hammer or mutate data, so
it's safe against staging. Dockerized, no local install:

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t $STAGING \
  -m 5 \
  -r zap-report.html
# -m 5 = max 5 min passive spider; add `-I` to not fail the shell on warn-level findings
```

Then point it at the API root too (the SPA and the API have different surfaces):

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t $STAGING/api/expenses -r zap-api.html
```

**Expected — these should already be GREEN** (we set them in `lib/security-headers.js`, verified in the audit):
- Content-Security-Policy present, no `unsafe-inline` (our frontend is external-file only).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options`/frame-ancestors, HSTS on HTTPS.
- `Cache-Control: no-store` on `/api/*` and `/receipt` (no sensitive data cached by proxies).
- No stack traces / server paths in any error body (the global handler in `server.js` returns
  `{error:'invalid request'}` only).

**Known-acceptable ZAP noise** (don't chase these): "Cookie without SameSite" — we don't use cookies (bearer
tokens in the `Authorization` header); "CSRF token missing" — same reason, no cookie-auth means no CSRF
surface. Note them as N/A in §7 rather than treating them as findings.

## 4. Auth + isolation probes — **the core of this pass**

This is where the system's real security posture is proven. Every probe below has an **expected status**; a
different status is a finding. Watch §5's log tail while you run these — each 401/403/429 should appear as a
`level=security` line.

### 4.1 No token → locked out (SEC-1 / broken access control)
```bash
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/api/expenses          # want 401
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/api/reports           # want 401
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/api/statement?period=2026-07&format=pdf  # want 401
```
All must be **401**. A `200` here is a launch-blocker (an endpoint forgot `checkDash`).

### 4.2 Bad login → 401, and rate-limited (brute-force resistance)
```bash
# wrong password, ten times fast — expect 401s, then 429 once the login limiter trips
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST $STAGING/api/login \
    -H 'content-type: application/json' -d '{"username":"admin","password":"wrong"}'
done; echo
```
Expect a run of **401** turning into **429**. If it never 429s, the login limiter isn't wired on this host
(check `LOGIN_RATE_MAX`). Every one of these is a SEC-6 security event — confirm they show in the log tail.

### 4.3 Good login → token works
```bash
CLERK_A_TOKEN=$(curl -s -X POST $STAGING/api/login -H 'content-type: application/json' \
  -d "{\"username\":\"$CLERK_A_USER\",\"password\":\"$CLERK_A_PASS\"}" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/api/expenses -H "authorization: Bearer $CLERK_A_TOKEN"  # want 200
```

### 4.4 Cross-branch read → **403 / empty** (SEC-2, the leak guarantee)
This is **the** test. Clerk A must never see branch B's data.
```bash
# (a) clerk A lists expenses — must contain ZERO rows with branch_id = B
curl -s $STAGING/api/expenses -H "authorization: Bearer $CLERK_A_TOKEN" | jq '[.[] | .branch_id] | unique'
#   -> should show only branch A's id, never branch B's

# (b) clerk A fetches a receipt that belongs to branch B by id — must NOT return the image
curl -s -o /dev/null -w '%{http_code}\n' $STAGING/receipt/by-id/<BRANCH_B_EXPENSE_ID> \
  -H "authorization: Bearer $CLERK_A_TOKEN"       # want 403 or 404, never 200+image

# (c) clerk A asks for branch B's statement — the clerk's branch is forced from the session,
#     so the ?branch= param must be ignored (they get their OWN branch or a 400/403, never B's data)
curl -s -o /dev/null -w '%{http_code}\n' \
  "$STAGING/api/statement?period=2026-07&format=pdf&branch=<BRANCH_B_ID>" \
  -H "authorization: Bearer $CLERK_A_TOKEN"
```
**Any** branch-B data reaching clerk A is a **launch-blocker** — stop the handover and reopen the isolation
work (`lib/supabase.js scopeEq`, `lib/auth.js scopeForUser`, and the route's `scope:req.scope` wiring).

### 4.5 Privilege escalation → 403 (role gate)  *(skip if read-only against real data)*
```bash
# clerk tries an admin-only write (mark-as-paid). Must be refused.
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $STAGING/api/expenses/<ANY_ID> \
  -H "authorization: Bearer $CLERK_A_TOKEN" -H 'content-type: application/json' \
  -d '{"payment_status":"paid"}'                   # want 403

# clerk tries to submit for a branch that isn't theirs — branch comes from the session, not the body
curl -s -o /dev/null -w '%{http_code}\n' -X POST $STAGING/api/submissions \
  -H "authorization: Bearer $CLERK_A_TOKEN" -H 'content-type: application/json' \
  -d '{"period":"2026-07","branch_id":"<BRANCH_B_ID>"}'   # want 201 for A's OWN branch, never B's
```

### 4.6 Input validation → 400, not 500 (no crash surface)
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $STAGING/api/login \
  -H 'content-type: application/json' -d 'not-json'                 # want 400 (global handler), never 500/HTML
curl -s -o /dev/null -w '%{http_code}\n' \
  "$STAGING/api/statement?period=NOPE&format=exe" -H "authorization: Bearer $CLERK_A_TOKEN"  # want 400
```

## 5. Watch the SEC-6 security log fire

While §4 runs, the host log tail should show one structured line per auth failure / denial / rate-trip:
```
level=security event=auth_fail   status=401 method=POST path=/api/login  ip=...
level=security event=forbidden   status=403 method=GET  path=/receipt/by-id/...
level=security event=rate_limited status=429 method=POST path=/api/login  ip=...
```
Two things to confirm here:
1. **Every** 401/403/429 from §4 produced a line (nothing silently unlogged) — this is how a real intrusion
   attempt becomes visible once live.
2. **No PII / receipt bytes / passwords** in any line — only method, path, status, source IP. If you see a
   password or a receipt payload, that's an ADR-002 finding — fix before handover.

*(If these lines are absent, SEC-6 (`lib/security-events.js`) isn't deployed on this build — confirm the
commit includes PR #143.)*

## 6. Pass / fail gate

**Ship the handover only if ALL of:**
- [ ] §2 no high/critical runtime CVE.
- [ ] §3 CSP + hardening headers present; no stack-trace/path leak in errors.
- [ ] §4.1 all unauthenticated calls 401.
- [ ] §4.2 bad logins 401→429.
- [ ] §4.4 **clerk A saw zero branch-B data across (a)(b)(c)** — the non-negotiable one.
- [ ] §4.5 clerk refused the admin write and the foreign-branch submit (if run).
- [ ] §4.6 malformed input → 400, never 500/HTML.
- [ ] §5 every denial logged, no PII in logs.

Any unchecked box = **stop**. A §4.4 failure is a launch-blocker, full stop; the rest are fix-then-rerun.

## 7. Sign-off record (fill in and commit alongside the deploy record)

```
Instance:        <client / staging URL>
Commit:          <git sha deployed>
Date / operator: 2026-__-__ / <name>
npm audit:       PASS / findings: ____
ZAP baseline:    PASS / N-A noise: SameSite,CSRF (no-cookie auth) / real findings: ____
Auth probes:     4.1 __ 4.2 __ 4.4(a) __ (b) __ (c) __ 4.5 __ 4.6 __
SEC-6 logging:   all denials logged? __   PII-clean? __
Verdict:         GO / NO-GO   (NO-GO reason: ____)
```

Keep the filled record with the deploy runbook's sign-off so there's an auditable "we checked an attacker
can't get in" trail per client, per deploy.
