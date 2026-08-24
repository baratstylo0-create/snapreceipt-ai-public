# P-01 — Verified-email challenge: API contract and threat model

**Issue:** #34 · **Lane:** Platform/trust (Claude-P) · **Gate:** 1 (trust foundation) · **Risk tier:** 2
**Implementation:** `lib/emailChallenge.js`, `routes/auth.js`, `schema.sql`, `lib/mailer.js`, `lib/account.js`
**Consumers:** W-01 (web auth UX, Barat) and M-02 (Android session lifecycle, Jeevan)

This is the interface those two lanes build against. If something here needs to change, change it here
first and say so in the issue — two clients reading two different ideas of "verified" is exactly the
drift this document exists to prevent.

---

## 1. What shipped, and what deliberately did not

**Shipped:** the challenge *service* — issue, deliver, confirm, report.

**Not shipped: enforcement.** No endpoint refuses an unverified user. `CAP_REQUIRE_EMAIL_VERIFICATION`
defaults to `false` and currently only changes what the API *reports*, never what it *refuses*.

That is not an oversight, and it should not be quietly "finished" by whoever picks this up next.
`users.email_verified_at` is nullable with **no backfill**, so every account that already exists — the
live Premala instance, every personal signup made before this — reads as unverified. Flipping
enforcement on without a grace period or backfill locks all of them out on the next deploy. Turning it
on is a decision that belongs to Gate 1 sign-off, alongside W-01's verification UI and a stated
migration plan for existing accounts.

## 2. Endpoints

All three 404 unless `capabilities.personalAuth` is on. Business (`admin`/`clerk`) identities are
operator-provisioned via `setup/provision.js` and are **out of scope** — they have no self-serve email
flow, exactly as with password reset.

### `POST /api/verify-email/request`

Request a code. Unauthenticated. Rate limited (`VERIFY_EMAIL_REQUEST_RATE_MAX`, default 6/min/IP).

```json
{ "email": "user@example.com" }
```

**Always** responds `200` with the identical body, regardless of what is true:

```json
{ "ok": true, "message": "If that email needs confirming, a code is on its way." }
```

Same response for: no such account, a business account, an already-verified account, a request inside
the resend cooldown, a malformed address, and a genuine send. Also the same after an internal database
or mail failure. **W-01/M-02 must not try to infer anything from this response** — there is nothing in
it. Render "check your email" unconditionally.

### `POST /api/verify-email/confirm`

Confirm with **either** proof. Unauthenticated by design: the link opens in a mail client that may not
carry the session, and the challenge itself is the credential being presented.

```json
{ "email": "user@example.com", "code": "123456" }   // code path — email REQUIRED
{ "token": "<from the ?verify_token= link>" }        // link path — self-identifying
```

- `200 { "ok": true, "email_verified": true }`
- `400 { "error": "That code is invalid or has expired. Request a new one." }` — one message for
  **every** failure: unknown address, no challenge, wrong code, expired, already consumed, budget
  exhausted, malformed input. Show it verbatim; do not try to explain which case it was, because the
  server does not tell you and that is the point.

The `email` field is mandatory on the code path and is not decoration: a 6-digit code has a 10⁶ space,
so the lookup must be scoped to one account. A bare code is never searchable account-wide.

### `GET /api/verify-email/status`

Authenticated (`Authorization: Bearer <session>`). The single source both clients render their
"confirm your email" banner from.

```json
{ "email": "user@example.com", "verified": false, "verified_at": null, "verification_required": false }
```

`401` for a missing, unknown or expired session.

### Additive fields on existing endpoints

`POST /api/signup` (`201`) gains `email_verified: false` and `verification_required: <bool>`. Signup
still mints a session and still returns `bind_token` — it is **not** a blocking wall.

`POST /api/login` (`200`) gains `email_verified` and `verification_required` **for `owner` accounts
only**. They are absent for `admin`/`clerk`; treat absence as "not applicable", never as `false`.

## 3. What the clients own

| Requirement | Owner | Why it cannot be solved server-side |
|---|---|---|
| Strip `?verify_token=` from the URL immediately after reading it | W-01 | The token reaches the browser in a query string and therefore lands in history. Same class as the reset-bearer finding in the gap audit. Read it, confirm it, then `history.replaceState`. |
| Never write the code or token to logs, analytics or crash reports | W-01, M-02 | They are live credentials until consumed. |
| Android must keep the session in OS-backed secure storage | M-02 | Out of this lane entirely; noted so the contract is not read as covering it. |
| Show the resend button with a ≥60s cooldown | W-01 | The server enforces it silently by returning the same generic 200. Without a client-side timer the user just sees nothing happen. |

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CAP_REQUIRE_EMAIL_VERIFICATION` | `false` | Enforcement switch. **See §1 before changing.** |
| `EMAIL_VERIFY_TTL_MS` | `900000` (15 min) | Challenge lifetime. |
| `EMAIL_VERIFY_RESEND_COOLDOWN_MS` | `60000` | Per-account resend floor. |
| `EMAIL_VERIFY_MAX_ATTEMPTS` | `5` | Guesses per challenge. |
| `VERIFY_EMAIL_REQUEST_RATE_MAX` | `6` | Per-IP/min on request. |
| `VERIFY_EMAIL_CONFIRM_RATE_MAX` | `20` | Per-IP/min on confirm. |
| `PUBLIC_URL` | — | **Required for magic links.** Unset ⇒ code-only email (still fully usable). |

> These are not yet in `.env.example`. That file is shared/integration-owned under governance rule 6,
> so it was left alone deliberately rather than edited without a note. Someone should append them.

## 5. Threat model

| Threat | Defence | Test that pins it |
|---|---|---|
| Stolen database yields usable codes | Only `sha256(code)` and `sha256(token)` are stored; the raw values exist once, in memory, at issue time | "the raw code and token are NEVER persisted" |
| Replay of a consumed challenge | Single-use claimed by an **atomic conditional UPDATE** (`consumed_at=is.null` in the WHERE). Zero rows back ⇒ someone else won ⇒ refuse. Not the read-then-write that made password reset a medium finding | "SINGLE USE", "concurrent link taps" |
| Brute-forcing a 6-digit code | Per-challenge budget of 5, booked by compare-and-swap **before** the code is compared, so a lost race costs a slot rather than granting a free guess. A rate limiter alone cannot do this — its window resets | "the per-challenge budget is final", "the attempt bump is a CONDITIONAL update" |
| Account enumeration | One response for every request outcome; one error string for every confirm failure; constant-time hash comparison | "every failure mode returns the identical message", "not an oracle" |
| Mailbombing a victim | Per-account resend cooldown (survives IP rotation) **plus** per-IP limiter; already-verified addresses are never mailed | "the resend cooldown holds, then releases", "not a mailbomb target" |
| Reset-link poisoning via `Host` | The link is built from `cfg.PUBLIC_URL` only. There is **no** `req.get('host')` fallback | "IGNORES a hostile Host header" |
| Verifying an address you do not own | Row snapshots the address at issue time; a post-change address cannot be verified by an old challenge; another user's code cannot verify you | "a challenge issued to a DIFFERENT address", "cannot verify someone else" |
| Type confusion at the credential boundary | Both confirm paths reject non-string input before coercion | "malformed input is rejected" |

### Residual risks — stated, not hidden

1. **The limiter under all of this is still single-process, in-memory.** `lib/ratelimit.js` is a `Map`.
   Multi-instance or restart defeats it; only the per-challenge budget and cooldown survive. **P-04 owns
   the distributed replacement — this ticket does not close that gap.**
2. **The magic-link token transits a URL** and lands in browser history. Mitigated by single-use + 15
   min TTL; W-01 must strip it (§3).
3. **No retention sweep yet.** Consumed and expired rows accumulate. They are inert (hashed, single-use,
   expired) but they are credential-shaped and should not live forever — **P-07**.
4. **Timing is not fully uniform** on `request`: an unknown address skips the insert and send, so it
   returns faster. The response body carries no signal, but a determined attacker with clean timing
   measurements could distinguish. The existing `/api/forgot-password` has the same shape. Closing it
   properly means deferring the send to a background job — **P-05**, where that queue already belongs.
5. **`email_verified_at` is not yet enforced anywhere** — see §1.

## 6. Verification performed

- `npm test` → **2266/2266 pass, 0 fail**; 49 of those are new. No `.env` in this clone, so the
  env-contamination gotcha did not apply.
- The suite was **mutation-tested**: removing the single-use claim, the attempts compare-and-swap, the
  expiry check, the resend cooldown, or the code hashing each turns it red. The first two initially
  survived — two isolating tests were written specifically to kill them, because a green suite that
  cannot detect a deleted security control is worse than no suite.
- The Supabase fake (`tests/fixtures/fakePostgrest.js`) genuinely evaluates PostgREST filters and
  throws on any it does not implement. Both compare-and-swap defences live in a WHERE clause, so a
  filter-ignoring stub would have made those assertions meaningless.

**Not performed:** no live database was migrated, no mail was sent to a real address, and no penetration
testing was done. Gate 1 additionally requires independent authorization/auth testing with no open
critical or high finding; that is separate from this ticket.

## 7. Migration and rollback

Additive and backward-compatible. Apply the block at the tail of `schema.sql`:

- `alter table users add column if not exists email_verified_at timestamptz;`
- `create table if not exists email_challenges (...)` + three indexes + RLS enabled (service-role
  bypasses; no anon policy ⇒ anon denied, same as every other table).

**Rollback:** `drop table email_challenges;` and drop the column. Because nothing enforces verification
and every new response field is additive, the previous behaviour returns exactly. Rehearse on a branch
database before production, per the role brief.
