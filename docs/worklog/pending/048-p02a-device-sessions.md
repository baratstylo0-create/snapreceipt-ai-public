## 2026-08-24 · Claude-P (platform/trust) · feature/claude-p-P-02-session-hardening · P-02a device sessions + auth timeline

- **Issue:** #35 [P-02] · Gate 1 · **Risk tier 2** (session surface + schema) · **first slice of three**.
- **Files:** added `lib/deviceSessions.js`, `routes/sessions.js`, `tests/deviceSessions.test.js`,
  `tests/sessions.route.test.js`, `tests/fixtures/fakePostgrest.js`; modified `schema.sql`, `lib/auth.js`,
  `lib/passwordReset.js`, `routes/auth.js`, `server.js`, this worklog.
- **Scope split (deliberate).** #35 bundles seven security changes; delivering them as one ~2000-line
  Tier-2 diff touching every authenticated request would be unreviewable, and governance rule 8 warns
  against it. **P-02a (this) = the durable record**: device list, revoke one / revoke others,
  authentication timeline, new-device detection, password-change audit stamp.
  **P-02b = the cookie/CSRF transport switch** — deferred because it changes the session contract that
  W-01 and M-02 both build against, so it needs their agreement first. **P-02c = step-up/recent-auth.**
- **Compatibility:** the bearer contract is **untouched** — `lookupSession` and `checkDashSession` are
  not modified, so every existing web and native client behaves identically. Schema is additive
  (`sessions.id/last_seen_at/user_agent/ip_hash`, `users.password_changed_at`, new `auth_events`).
  `mintSession` gained an OPTIONAL third arg; all four existing call sites work unchanged.
- **New endpoints:** `GET /api/sessions`, `GET /api/sessions/events`, `DELETE /api/sessions/:id`,
  `POST /api/sessions/revoke-others`. All authenticated; 404 without personalAuth/multiUser.
- **Privacy (PDPA / C-02):** the raw client IP is **never stored**. `ip_hash` is salted sha-256, and
  the salt is derived per-deployment (a fixed salt would be rainbow-table-able back to an IP in
  seconds). `ip_hash` and `token_hash` are both withheld from every API response.
- **Isolation:** `user_id` is folded into the DELETE's own WHERE clause, not checked in a preceding
  SELECT — no check-then-act window, and a cross-account attempt returns 404 (not 403, which would
  confirm the id exists).
- **One bug I introduced and fixed:** the first write of `lib/deviceSessions.js` put **literal control
  bytes** (0x00, 0x1f, 0x7f) into the source, which made git treat the file as binary. Replaced with
  proper `\u` escapes; verified 0 control bytes and `file` reports UTF-8 text.
- **Verification run:** `npm test` → **2251/2251 pass, 0 fail** (34 new; baseline on this branch was
  2217/2217, confirmed before any edit). **Mutation-tested**: dropping the `user_id` revoke boundary,
  dropping revoke-others' self-exemption, leaking `token_hash` into the device list, returning a raw
  IP instead of a hash, storing a raw IP on an auth event, or dropping the expiry filter each turns
  the suite red. One mutation initially reported clean because its `sed` silently failed to apply —
  re-run properly with node before being counted.
- **Open risks:** `touchDevice`'s throttle cache is per-process (a multi-instance deploy writes once
  per instance — harmless, just chattier); `isNewDevice` is an honest heuristic, not a security
  control, and fails quiet; `auth_events` has no retention sweep yet (**P-07**); no live database
  has been migrated.
- **Workspace note:** built in a **git worktree** (`../SnapReceiptAI-p02`) because Codex is working
  M-01 in the main checkout. Their uncommitted `android/**` work was never touched.
- **What's next:** independent (non-author) review, then Jeevan or Barat merges. P-02b needs a
  cross-lane session-contract agreement before it starts.