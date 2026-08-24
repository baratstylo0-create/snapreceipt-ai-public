# P-02 — Session contract: what shipped in P-02a, and what P-02b must agree first

**Issue:** #35 · **Lane:** Platform/trust (Claude-P) · **Gate:** 1 · **Risk tier:** 2
**This PR implements P-02a only.** P-02b and P-02c are described here so the split is reviewable, not
so they can be assumed done.

---

## 1. Why #35 is being delivered in three slices

Issue #35 asks for seven things at once: cookie sessions, CSRF, rotation/fixation defence, device
sessions, password-change revocation, step-up auth, and suspicious-login events — while preserving the
native bearer contract. Built as one change that is a very large diff altering **every authenticated
request in the application**. Governance rule 8 exists to prevent exactly that, and a reviewer cannot
give it a real read in one pass.

| Slice | Contents | Status |
|---|---|---|
| **P-02a** | Device sessions, revoke one / revoke others, authentication timeline, new-device detection, password-change audit stamp | **this PR** |
| **P-02b** | HttpOnly/Secure/SameSite cookie sessions + CSRF, rotation/fixation defence | **blocked** — see §4 |
| **P-02c** | Step-up / recent-auth on sensitive actions | after P-02b |

P-02a was chosen to go first because it is the only slice that is **purely additive**: it changes no
existing contract, so it can be reviewed and merged without waiting on another lane.

## 2. What P-02a changes

**Nothing about how a session is resolved.** `lookupSession` and `checkDashSession` are untouched. Every
existing web and native client behaves byte-for-byte as before. This is worth checking in the diff
rather than taking on trust — it is the claim that makes the PR low-risk.

### Endpoints (all authenticated; 404 without `personalAuth` or `multiUser`)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/sessions` | `{ devices: [{ id, current, created_at, last_seen_at, user_agent, expires_at }] }` |
| `GET` | `/api/sessions/events` | `{ events: [{ event, created_at, user_agent }] }` |
| `DELETE` | `/api/sessions/:id` | `{ ok: true }` or `404` |
| `POST` | `/api/sessions/revoke-others` | `{ ok: true, revoked: <n> }` |

`event` is one of `login_ok`, `login_fail`, `logout`, `session_revoked`, `password_changed`, `new_device`.

### Schema (additive)

`sessions` gains `id`, `last_seen_at`, `user_agent`, `ip_hash`. `users` gains `password_changed_at`.
New table `auth_events`. The `sessions` primary key is still `token_hash` — deliberately unchanged, since
altering it would be a breaking rewrite of the whole lookup path.

## 3. Design decisions a reviewer should check

**A surrogate `id`, not the token hash, is the device handle.** A device list must be addressable
("revoke *that* one"), and the row's natural key is `token_hash`. Putting a value derived from a live
credential into URLs, browser history and logs would be a self-inflicted wound, so a meaningless
surrogate is generated instead. `token_hash` never leaves the server.

**The raw IP is never stored.** `ip_hash` is a salted sha-256. The salt comes from `SESSION_IP_SALT`,
falling back to a value already unique per deployment — **not** a shared constant, because an unsalted
or globally-constant hash of an IPv4 address is brute-forceable back to the address in seconds. The hash
is enough to answer "same network as last time?" for new-device detection and nothing more. It is
withheld from every API response, since a stable per-network identifier is a correlatable one.

**Authorization lives in the WHERE clause.** `revokeDevice` folds the caller's `user_id` into the DELETE
itself rather than doing a SELECT-then-check. There is no check-then-act window, and a missed match
returns `false` so the route answers **404, not 403** — a 403 would confirm that someone else's session
id exists.

**Revoke-others spares the caller.** Signing someone out of the device they are using at the exact
moment they are trying to secure their account would be actively harmful.

**Observability can never fail a login.** `recordAuthEvent`, `touchDevice`, `isNewDevice` and
`stampPasswordChanged` all swallow their errors by contract, and there are tests asserting they do not
throw when the database is down. Security *actions* propagate; security *bookkeeping* does not.

**`isNewDevice` is a heuristic, stated as one.** It compares user-agent + ip_hash against live sessions.
It is for "worth telling the user about", not for making access decisions, and it fails quiet rather
than inventing an alarming notification when the lookup breaks.

## 4. What P-02b needs before it can start

The cookie switch is not merely more code — it changes the contract **W-01 and M-02 both build
against**, and the execution plan makes the session plumbing under `public/` platform-owned precisely so
this does not get decided twice. Today the browser holds its token in `sessionStorage`
([public/js/app.js:7](../../public/js/app.js)), which is script-readable and is the thing P-02 must
eliminate.

Open questions that need a named answer, not an assumption:

1. **Dual-mode resolution.** Browser uses an `HttpOnly` cookie; Android keeps `Authorization: Bearer`
   in OS-backed storage. `checkDashSession` accepts either. Does M-02 agree the native side stays on
   bearer, or does the WebView adopt cookies too?
2. **CSRF strategy.** Double-submit (non-HttpOnly `csrf` cookie + `X-CSRF-Token` header) is the
   no-new-dependency option that fits this codebase. Confirm before it is built.
3. **`SameSite` value**, and whether the Capacitor WebView origin counts as same-site — this decides
   whether the Android app can use cookies at all.
4. **Rotation points.** Rotate on login is uncontroversial; rotating periodically mid-session needs the
   clients to tolerate a changing cookie without logging the user out.
5. **Migration.** Existing `sessionStorage` tokens must keep working through a transition window, or
   every signed-in user is logged out on deploy.

**Recommendation:** settle these in #35 (or a short ADR) with Barat and Jeevan before P-02b is written.
Building it first and negotiating afterwards means rewriting whichever client guessed wrong.

## 5. Verification performed

- `npm test` → **2251/2251 pass, 0 fail** (34 new). Baseline on this branch measured at **2217/2217**
  before any edit, so the delta is exactly the new tests.
- **Mutation-tested.** Each of the following turns the suite red: dropping the `user_id` boundary from
  `revokeDevice`; removing revoke-others' self-exemption; leaking `token_hash` into the device list;
  returning a raw IP instead of a hash; storing a raw IP on an auth event; dropping the expiry filter
  from the device list. One mutation first appeared "caught" only because its `sed` had silently failed
  to apply — it was re-run with a verified replacement before being counted.
- The Supabase fake genuinely evaluates PostgREST filters, including the `neq.` used by revoke-others,
  and throws on any filter it does not implement. A fake that approximated `neq.` could have turned
  "revoke every device except mine" into "revoke everything" without a test noticing.

**Not performed:** no live database was migrated; no penetration testing; no browser or device testing
(there is no UI in this slice).

## 6. Migration and rollback

Apply the dated block at the tail of `schema.sql` — all statements are `if not exists` and idempotent.

**Rollback:** `drop table auth_events;`, drop the four added `sessions` columns and
`users.password_changed_at`, and unmount `routes/sessions.js`. Because session resolution is unchanged,
nothing else depends on any of it; the previous behaviour returns exactly.

**Note for whoever merges:** `tests/fixtures/fakePostgrest.js` is also added by PR #46 (P-01). This
branch's copy is that file plus `neq.` support — a strict superset. On conflict, **keep this version**;
P-01's tests pass against it unchanged.
