## 2026-08-24 · Claude-P (platform/trust) · feature/claude-p-P-04-distributed-abuse-controls · P-04a shared rate limiting

- **Issue:** #37 [P-04] · Gate 1 · **Risk tier 2** · **first slice of two**.
- **Files:** added `lib/sharedLimit.js`, `tests/sharedLimit.test.js`,
  `docs/security/P-04-abuse-controls.md`; modified `schema.sql` and 7 route files
  (`auth`, `googleAuth`, `guest`, `upload`, `agent`, `statement`, `webhook`), this worklog.
- **Why this next:** P-01 and P-02a both shipped with the same open risk written into their own
  docs — "the limiter under this is still single-process in-memory, P-04 owns the distributed
  replacement." Adding more auth surface while leaving that open makes the earlier work weaker
  than it reads. The gap audit lists single-process limiting as a P0 launch blocker.
- **What changed:** a **two-layer** limiter, not a replacement. Layer 1 is the existing
  in-memory limiter, unchanged and checked FIRST (a flood is refused at zero database cost —
  otherwise the limiter becomes the amplification vector). Layer 2 is an atomic Postgres
  counter (`bump_rate_limit`, one `INSERT .. ON CONFLICT DO UPDATE`) shared by every instance.
  13 abuse-critical endpoints rewired, each with a unique bucket name.
- **Failure posture (a deliberate security decision, not an accident):** if the shared store is
  unreachable this **fails OPEN**, but layer 1 still applies — so an outage degrades protection
  to exactly today's behaviour, never to none. Fail-closed would turn a Supabase blip into a
  total login lockout. That trade is right for a limiter and would be wrong for an
  authorization check; the reasoning does not generalise.
- **No new dependency.** Postgres rather than Redis, per the standing rule.
- **Privacy (PDPA / C-02):** the bucket key is a salted hash — a rate limiter is not a reason
  to start retaining IP addresses.
- **A REAL BUG found by testing, not by review:** `bumpShared` used `Number(count)`, and
  `Number(null) === 0` in JavaScript — so a null response body (which PostgREST can legitimately
  return) read as a genuine count of zero: a full budget advertised on every malformed answer.
  Found because mutation testing exposed the malformed-response path as uncovered; the test I
  then wrote **failed at baseline**. Fixed with a type-check before coercion.
- **Verification run:** `npm test` → **2231/2231 pass, 0 fail** (14 new; branch baseline 2217
  confirmed before any edit). Every pre-existing test for the 13 rewired endpoints still passes,
  which is the compatibility evidence: the swap is behaviour-preserving when the shared store is
  absent. **Mutation-tested**: fail-closed instead of open, conflating unknown with zero,
  dropping the endpoint name from the bucket key, storing a raw client id, never enforcing the
  global budget, and removing the name-uniqueness guard each turn the suite red.
  **Process note:** my first mutation run reported all six "caught" — but the shell had mangled
  the mutator and **not one mutation actually applied**. Re-run with a mutator that exits
  non-zero when a mutation does not apply. Same class of mistake as the one caught in P-02a;
  the harness now makes it impossible to miss.
- **Deferred to P-04b:** idempotency keys, duplicate/replay control, and file/page/concurrency/
  spend limits on upload/OCR/export. The ticket names them; this slice is the shared-limiter
  half only.
- **Open risks:** each limited request now costs one extra round-trip on those 13 endpoints
  (deliberately not applied to the ordinary dashboard read path); `SHARED_RATE_LIMIT=false`
  restores previous behaviour exactly; `rate_limits` rows need sweeping (`sweep_rate_limits()`
  is provided, **P-07** owns scheduling it); no live database has been migrated.
- **Conflict note:** this is my third open branch touching `routes/auth.js` (after #46 and #48).
  All three are additive one-liners in limiter declarations. Resolution order: #46, then #48,
  then this.