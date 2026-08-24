# P-04 — Distributed abuse and cost controls

**Issue:** #37 · **Lane:** Platform/trust (Claude-P) · **Gate:** 1 · **Risk tier:** 2
**This PR implements P-04a only** (the shared-limiter half). P-04b is described in §6 so the split is
reviewable, not so it can be assumed done.

---

## 1. The problem

`lib/ratelimit.js` is a per-process `Map`. Its own header was honest about it — *"Single-process v1 …
a multi-instance deploy would move this to a shared store"* — but that gap is now load-bearing:

- Two instances behind a load balancer hand an attacker **twice** the budget. N instances, N times.
- A restart silently resets every counter to zero.
- P-01's OTP endpoints and P-02a's revoke endpoints both lean on rate limiting to mean something, and
  both shipped with this written into their own residual-risk sections.
- `docs/FULL_APP_GAP_AUDIT_2026-08-24.md` lists single-process limiting as a **P0 launch blocker**.

## 2. The design: two layers, not a replacement

| | Layer 1 — in-process | Layer 2 — shared |
|---|---|---|
| Where | `lib/ratelimit.js`, unchanged | `rate_limits` table + `bump_rate_limit()` RPC |
| Cost | zero | one round-trip |
| Checked | **first** | only if layer 1 allows |
| Enforces | a per-instance ceiling | the real global budget |

**Layer 1 is checked first on purpose.** If a flood spent a database round-trip per request, the
limiter would become the amplification vector it exists to prevent. There is a test asserting that
refused requests cost exactly zero round-trips.

**Atomicity is the whole point of layer 2.** `bump_rate_limit` is a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING count`, so N concurrent requests across N instances produce
N distinct counts with no lost updates. An application-side read-then-write could not provide that —
which is precisely the weakness of the limiter it backs up.

**Postgres, not Redis.** The no-new-dependency rule is real, and every request already reaches Supabase.

## 3. Failure posture — a decision, stated

If the shared store is unreachable, this **fails OPEN** — and layer 1 still applies.

An outage therefore degrades protection to *exactly today's behaviour*, never to none. The alternative
(fail closed) means a Supabase blip locks every user out of logging in, converting an availability
problem into a total outage. For a limiter that trade is right.

**This reasoning does not generalise.** For an authorization check, fail-closed is correct. The
distinction is deliberate and should not be copied across by analogy.

There is an explicit test for each half: fail-open on outage, *and* layer 1 still refusing during one.

## 4. Coverage

13 endpoints, each with a unique bucket name (a shared name means one endpoint can starve another's
budget — the constructor throws if a name is missing, and there is a test for it):

| Bucket | Endpoint | Why |
|---|---|---|
| `auth.login`, `auth.signup`, `auth.forgot`, `auth.reset`, `auth.delete` | credential surfaces | brute force, account-creation abuse |
| `auth.feedback` | in-app feedback | outbound email cost |
| `google.start`, `google.callback` | OAuth | credential surface |
| `guest.start` | guest accounts | free-resource abuse |
| `upload` | receipt upload | OCR spend |
| `agent` | dashboard agent | AI spend |
| `export.statement` | statement export | CPU/memory cost |
| `bot.webhook` | Telegram webhook | bot-binding abuse |

**Deliberately NOT applied** to the ordinary dashboard read path (`dashAuthLimiter`, expenses, reports,
settings, branches…). Those are high-frequency authenticated reads where an extra round-trip per request
would be a real latency regression for no security gain — `dashAuthLimiter` already only counts *failed*
auth, which is the actual brute-force surface.

## 5. Verification

- `npm test` → **2231/2231 pass, 0 fail** (14 new). Branch baseline measured at **2217/2217** before any
  edit. Every pre-existing test for the 13 rewired endpoints still passes — that is the compatibility
  evidence, since it shows the swap is behaviour-preserving when the shared store is absent.
- **Mutation-tested.** Each of these turns the suite red: failing closed instead of open; conflating
  "unknown" with zero; dropping the endpoint name from the bucket key; storing a raw client id instead
  of a hash; never enforcing the global budget; removing the name-uniqueness guard.

### A real bug, found by testing rather than by reading

`bumpShared` originally did `Number(count)`. In JavaScript **`Number(null) === 0`** — so a `null`
response body (which PostgREST can legitimately return) was read as a genuine count of **zero**: a full
budget advertised on every malformed answer, and a value indistinguishable from "first request in the
window" to anyone debugging it. Enforcement still failed open either way, so this was not an exploitable
hole — but "unknown" and "zero" must not be conflated in a limiter's own bookkeeping.

It surfaced because mutation testing exposed the malformed-response path as uncovered; the test written
to close that gap **failed at baseline**. Fixed with a type check before coercion.

### Process note worth recording

The first mutation run reported all six mutations "caught". The shell had mangled the mutator and **not
one of them had actually applied**. The harness now exits non-zero when a mutation does not apply, so a
skipped mutation can never again be mistaken for a caught one. This is the second time this class of
mistake appeared in this lane (the first was in P-02a); it is written down so the third time does not
happen.

**Not performed:** no live database was migrated; no load testing; no penetration testing. The claim
here is "the mechanism is correct and covered", not "the thresholds are right under real traffic" —
tuning belongs with C-07's load tests.

## 6. What P-04b still owes

The ticket also names **idempotency keys, duplicate/replay control, and file/page/concurrency/spend
limits** on upload, OCR and export. None of that is in this PR. It is a separate concern from rate
limiting — bounding *the cost of one accepted request* rather than *how many requests are accepted* —
and mixing them would produce exactly the unreviewable diff governance rule 8 warns about.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARED_RATE_LIMIT` | `true` | Set false to restore the previous single-process behaviour exactly. Opt-**out**, never opt-in. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length (shared with the existing limiter). |
| `SESSION_IP_SALT` | derived | Salt for the bucket key. Never a shared constant. |
| the existing `*_RATE_MAX` vars | unchanged | Per-endpoint budgets keep their current names and defaults. |

Not yet in `.env.example` — that file is integration-owned under governance rule 6, so it was left alone
rather than edited without a note. Someone should append these.

## 8. Migration and rollback

Apply the dated block at the tail of `schema.sql`: the `rate_limits` table, `bump_rate_limit()` and
`sweep_rate_limits()`. All idempotent.

**Rollback:** set `SHARED_RATE_LIMIT=false` for an instant, code-free revert to previous behaviour; then
`drop function bump_rate_limit; drop function sweep_rate_limits; drop table rate_limits;` at leisure. The
route wiring is safe to leave in place — with the flag off it never consults the shared layer.

`sweep_rate_limits()` is provided but **not scheduled**; expired buckets accumulate until **P-07** owns
retention. They are inert (a hash, a window, a count) and carry no personal data.
