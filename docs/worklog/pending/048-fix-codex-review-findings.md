## 2026-08-24 · Claude-P (platform/trust) · feature/claude-p-P-02-session-hardening · fix: Codex cross-lane review findings on #48

- **Issue:** #35 [P-02] · Gate 1 · Risk tier 2 · applied directly to the #48 (P-02a) branch, still unmerged.
- **Source:** Codex's cross-lane agent pre-review on #48 (posted per the workflow in #53), independently
  verified against the real code before any fix was written — grep-confirmed both claims true, not taken
  on the review's word alone.
- **Files:** `routes/expenses.js`, `routes/googleAuth.js`, `routes/guest.js`; added
  `tests/checkdash.touchdevice.test.js`, `tests/guest.deviceInstrumentation.test.js`; this worklog.

### Finding 1 (P2) — `touchDevice()` was dead code

`lib/deviceSessions.js` fully implemented, exported and unit-tested `touchDevice()`, but no route ever
called it. `last_seen_at` was set once at session creation and then frozen forever regardless of actual
activity — the device list could show a session as last-seen at login time while it was being used
continuously.

**Fix:** `checkDashSession` (the one place a bearer resolves to a live session, `routes/expenses.js`)
now calls `touchDevice(tokenHash(presented), deviceFromRequest(req))` immediately after resolving
`req.user`/`req.scope`. Deliberately **fire-and-forget** (not awaited) so it can never add latency to
the hot auth path every dashboard/API request goes through — `touchDevice` already throttles itself to
one write per session per `SESSION_TOUCH_INTERVAL_MS` and never throws by contract. Session
**resolution/authorization** semantics are unchanged; only a best-effort bookkeeping side-effect was
added. (This narrows the PR's original claim that `checkDashSession` is "not modified" — it is modified,
in a way that cannot change any request's outcome. The PR body/contract doc will be updated to say so.)

### Finding 2 (P2) — Google OAuth and guest sign-in bypassed the device/timeline instrumentation

Password signup/login recorded device metadata and `login_ok`/`new_device` events; `routes/googleAuth.js`
and `routes/guest.js` called `mintSession(user)` with no device argument and recorded nothing. A user
signing in with Google, or starting a guest trial, had a silently incomplete device list and security
timeline relative to a password account — the feature was mis-described as covering "the authentication
timeline" when it covered one of three session-creating surfaces.

**Fix:** both routes now build `deviceFromRequest(req)`, pass it into `mintSession`, and call
`recordAuthEvent({ userId, event: 'login_ok', device })`. `googleAuth.js` additionally runs the same
new-device check `routes/auth.js`'s password login already does, **before** the session row is written
(checking after would always match itself). `guest.js` deliberately does **not** run a new-device check —
a guest identity is single-use and ephemeral (≤24h), so "is this a new device" has no meaningful prior
session to compare against; recorded as a reasoned exclusion, not an oversight.

### Verification — stated precisely so nothing here is oversold

- `npm test` → **2256/2256 pass, 0 fail** (5 new: 2 for the `checkDashSession`→`touchDevice` wiring,
  3 for `guest.js`'s instrumentation). Confirmed by an independent full-suite run, not taken from a
  prior run's number.
- **Both new tests are mutation-tested against the EXACT pre-fix code**: reverting `checkDashSession`
  to the original (no `touchDevice` call) turns its new test red; reverting `guest.js`'s mint call to
  `mintSession(user, GUEST_SESSION_TTL_MS)` (no device, no event) turns its new test red. Each proves it
  actually catches the specific regression Codex reported, not just that the happy path is green.
- **`routes/googleAuth.js` has NO new automated test**, stated honestly rather than left implicit. There
  is no pre-existing test file for this route at all (`routes/guest.js` had none either, but was cheap to
  add one for — no external dependency). Testing the OAuth callback meaningfully requires stubbing
  `exchangeCode`/`verifyIdToken`, both destructured from `lib/googleAuth` at require time, which needs a
  module-cache monkeypatch this codebase has no existing pattern for. Building that harness from scratch
  is a materially bigger task than the 10-line fix it would cover, and rushing it under an already-active
  WIP-limit constraint risked a worse outcome than an honest gap. Confidence here rests on: the change
  mirrors, near line-for-line, `routes/auth.js`'s own login handler (which the full suite does exercise),
  and the full suite's 2256 pass with this route's module load succeeding confirms no syntax/require error.
  **A reviewer should weigh this gap explicitly** — it is real, not hidden.
- A CRLF hazard was hit and fixed WHILE editing, not after: a first string-replace script assumed bare
  `\n` line endings; this repo's checkout is CRLF. The script was written to fail loudly on a non-matching
  target rather than silently corrupt the file (same discipline as the mutation-testing harness earlier in
  this lane) — it caught its own mismatch before any byte was written, was corrected to normalise against
  the file's actual line ending, and a post-edit check confirmed zero bare-LF characters in any of the
  three touched files.

### What's next

Codex's review is otherwise clear on #48 — no other blocking finding. These three fixes are applied
directly to the existing #48 branch (not a new PR); the PR body and `docs/security/P-02-session-contract.md`
need a short update reflecting the corrected "unmodified" claim and the stated googleAuth test gap before
#48 is marked ready for human review. Still not pushed from this pass.