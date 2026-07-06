# Business-Account (Multi-Branch / Multi-Staff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) tracking.
> **This is an epic** — build it phase-by-phase, each phase is its own branch + PR + Tier-2 review.

**Goal:** Add a per-client, flag-gated **business-account layer** (HQ admin + branches + branch clerks +
staff attribution) on the existing single-account system, delivered as an isolated instance per client
company. See the full design in `docs/specs/2026-07-06-business-account-multibranch-design.md` (ADR-021).

**Architecture:** One `account_id` = one client business; `branches` + `users` tables and
`branch_id`/`staff_user_id` on `expenses`. Identity via `crypto.scrypt` + opaque sessions reusing the
existing `checkDash` bearer path; a single `scopeForUser` "bouncer" funnelled through `lib/supabase.js`
filters every query by role/branch. Master view = live `GROUP BY` (no stored workbooks). Bot = clerk
tool with `/start <token>` binding. Anomaly = staff-first + admin N-day valve. Payments = admin-edit /
clerk-view + chunked bulk mark-paid.

**Tech Stack:** Node 22, Express, vanilla JS frontend (no framework), Supabase Postgres via REST,
`node:test`. **No new npm dependencies** (`scrypt` is Node core).

**Spec:** `docs/specs/2026-07-06-business-account-multibranch-design.md` · **ADR:** ADR-021 (+ ADR-010
one-codebase flags, ADR-015 custody, ADR-020 delivery model).

---

## ⛔ HARD CONSTRAINTS (apply to every task)

1. **Flag-gated (ADR-010).** The entire business layer lives behind `capabilities.multiUser` (from
   `getCapabilities()`). **Flag OFF = today's product, byte-for-byte** — no login roles, no branches, no
   staff tagging, personal bot. **All existing ~1104 tests must stay green after every task.** New
   behaviour is covered by new tests that run with the flag ON.
2. **One codebase, N deployments.** No per-client code forks, ever. Client differences = config/data
   (template, categories, branding, flags, secrets). No `if (client === 'X')`.
3. **Isolation via the ONE bouncer.** Every company/branch-scoped query goes through `scopeForUser` →
   `lib/supabase.js`. No route hand-rolls its own scope filter. Isolation tests are mandatory.
4. **Tier-2 discipline** (auth + DB schema + isolation): TDD, independent cross-review before merge,
   secrets never logged, `.env` moved aside for the suite (standing convention below).

**Standing project convention — run before/after `npm test`:**
```bash
mv .env .env.local.bak   # repo-root .env has LIVE creds
npm test
mv .env.local.bak .env
```

---

## Task split (Owner-directed 2026-07-06 — overrides the default ownership map for this epic)

| Area | Owner |
|---|---|
| **Supabase schema + migrations, identity/auth, provisioning, reports/master, payments, ALL frontend** | **Jeevan** |
| **`lib/supabase.js` scope-helper (central bouncer), the business Telegram bot (`lib/bot.js` + `routes/webhook.js`), Groq ZDR + OCR-provider config knob (`lib/groq.js`), FieldSpec business-category/shape plumbing (`lib/templates.js`/`lib/ocr.js`)** | **Barat** |
| **Frontend** | **Jeevan** (Mugi off this epic unless a frontend edit is explicitly handed over) |

Coordination: `scopeForUser` is a **frozen contract** (below) — Jeevan produces the scope object from a
session; Barat enforces it in `lib/supabase.js`. Announce shared-file touches in WORKLOG (SOP §4.6).
Branch per phase: `feature/<owner>-m2-<phase>` off `main`.

**Frozen contract — `scopeForUser(user)` → `{ account_id, branch_id?, role }`:**
- `role='admin'` → `{ account_id }` (no branch filter → sees all branches).
- `role='clerk'` → `{ account_id, branch_id }` (hard-filtered to that branch).
- `lib/supabase.js` helpers accept an optional `scope` and apply `branch_id` when present.

---

## Phase 1 — Identity foundation  (Jeevan; Barat owns the `lib/supabase.js` scope hook)

**Files:** `schema.sql` (new tables) · `lib/auth.js` (new) · `routes/auth.js` (new) · `routes/expenses.js`
(`checkDash` → session lookup) · `lib/supabase.js` (scope param — Barat) · `lib/account.js`
(`getCapabilities` reads `multiUser`) · tests.

- [ ] **Schema:** add `users`, `sessions`, `branches`, `bot_bindings` (DDL sketch in spec §5). Keep
  `expenses` additive: `branch_id`, `staff_user_id` nullable (personal rows leave them null). RLS stays
  service-role-mediated (comment the future JWT-RLS policy, don't enable).
- [ ] **`lib/auth.js`** (TDD): `hashPassword`/`verifyPassword` (scrypt, constant-time), `mintSession`/
  `lookupSession`/`revokeSessionsForUser`, `scopeForUser`. Tests: round-trip, wrong password, tampered/
  expired session, scope shape per role.
- [ ] **`checkDash` swap:** when `multiUser` ON, resolve the bearer token via `lookupSession` →
  `{account_id, branch_id, role}` on `req`; when OFF, current static-token behaviour is unchanged.
  Tests: personal path identical (flag off); business path resolves a session.
- [ ] **`lib/supabase.js` scope hook (Barat):** helpers accept optional `scope`; apply `branch_id`
  filter when present. Tests: admin scope returns all; clerk scope filtered.
- [ ] **`POST /api/login` / `POST /api/logout`** in `routes/auth.js`. Tests: valid login → session token;
  bad creds → 401; logout revokes.
- [ ] **Isolation test (critical):** seed two branches; a clerk session for branch A cannot read branch
  B rows through `sbSelect`. Full suite green (personal tests unchanged).
- [ ] Commit(s): `feat(m2): identity foundation — users/sessions/scrypt auth + scopeForUser bouncer`.

## Phase 2 — Provisioning & revocation  (Jeevan)

**Files:** `lib/branches.js` (new) · `routes/branches.js` (new) · `account_settings` (`max_branches`).

- [ ] **`lib/branches.js`** (TDD): `createBranch` (→ branch row + clerk user + one-time `bot_bindings`
  token; returns username+password ONCE), `listBranches`, `softDeleteBranch` (active=false + revoke
  sessions + refuse binding), `addStaff`/`listStaff`/`removeStaff` (name-only).
- [ ] **On account setup, auto-create a "Head Office" branch and bind the HQ admin to it** (admin is also
  a capturer — HQ petty cash). Admin gets a `/start` binding scoped to Head Office + dashboard upload;
  admin reads still see ALL branches (scope has no branch filter), but admin *captures* tag to Head Office.
  Tests: Head Office exists after setup; admin binding scoped to it; admin upload tags Head Office.
- [ ] **`routes/branches.js`**: admin-scoped CRUD; clerk may manage only their own branch's staff.
  Enforce `max_branches`. All writes role-guarded via `scopeForUser`.
- [ ] Tests: cap enforced; created creds shown once then only hash stored; soft-delete flips active +
  kills sessions; clerk cannot create/delete branches; clerk manages only own-branch staff.
- [ ] Commit: `feat(m2): branch/staff provisioning + soft-revoke`.

## Phase 3 — Data dimensions: master view, reports, export  (Jeevan)

**Files:** `routes/webhook.js`/`routes/upload.js` write paths (tag `branch_id`/`staff_user_id`) ·
`lib/reports.js` + `routes/reports.js` (grouping dims) · `lib/excel.js` + export glue (Branch/Staff cols).

- [ ] Writes stamp `branch_id`/`staff_user_id` (from session for dashboard, from binding for bot).
- [ ] `buildReport` gains `branch`/`staff` grouping dims; `routes/reports.js` drill-down params
  (branch→staff→receipt); clerk report pre-filtered by scope.
- [ ] Export: `buildWorkbook` filtered by selection; add **Branch** + **Staff** columns (v1 single sheet).
- [ ] **Durable receipt-image storage (ADR-018) is a prerequisite for business** — land/enable it first:
  images stored to the private `receipts` bucket at ingestion from BOTH paths (Telegram + dashboard),
  `receipt_url` set (Barat ingestion hook + Jeevan `lib/storage.js`, per `2026-07-04-receipt-image-storage-design.md`).
- [ ] **Embed the receipt image in the export (`lib/excel.js`, Jeevan):** a "Receipt" column embedding a
  display-scaled thumbnail per row (exceljs `workbook.addImage`/`worksheet.addImage`, row height bumped) +
  a hyperlink to full-res; fetch bytes from storage at export time; blank cell when no image. Default =
  embed; **"links-only" mode** for very large exports (no resize dep — `sharp` rejected, ADR-014).
- [ ] Tests: master aggregate == sum of branch rows; clerk sees only own branch; export carries the two
  columns + an embedded image for rows with `receipt_url`, blank when absent; links-only mode emits
  hyperlinks not bytes; personal export unchanged (flag off → no Branch/Staff/Receipt columns).
- [ ] Commit: `feat(m2): branch/staff dimensions + embedded receipt image in export`.

## Phase 4 — Anomaly (staff-first) + payments + bulk pay  (Jeevan)

**Files:** `routes/review.js` (branch scope + clerk-first + N-day valve, `decided_by_role`) ·
`routes/expenses.js` (`payment_status` admin-only write, chunked bulk mark-paid, optimistic `updated_at`).

- [ ] Review queue branch-scoped; clerk decides first (`decided_by_role='clerk'`); admin can override an
  existing decision but not originate until `ANOMALY_VALVE_DAYS` elapsed (then force-decide allowed).
- [ ] `payment_status` (default 'pending') + `paid_at`/`paid_note`; admin-only write (clerk 403 on write,
  200 on read). Bulk `PATCH` over an id list, chunked (`BULK_PAY_CHUNK`), reversible.
- [ ] Optimistic concurrency: `updated_at` mismatch → 409 refresh.
- [ ] Tests: clerk-first gate, valve fires after N days, clerk cannot write payment_status, bulk chunking,
  stale-edit 409.
- [ ] Commit: `feat(m2): staff-first anomaly valve + payment tabs + chunked bulk mark-paid`.

## Phase 5 — Business Telegram bot  (Barat)

**Files:** `lib/bot.js` (business paths, flag-gated) · `routes/webhook.js` (`/start <token>` binding) ·
`lib/groq.js` (ZDR note + OCR-provider config knob) · `lib/templates.js`/`lib/ocr.js` (categories from
FieldSpec).

- [ ] `/start <token>` validates the one-time link → binds `chat_id → user/branch/role` (locked) for
  **both clerk and admin** (admin bound to Head Office; staff never bound); unbound chats refused. Enable
  **Groq ZDR** on the account (ops step) + document the OCR-provider knob.
- [ ] Upload → "which staff?" inline buttons (remember-last default) → tag `staff_user_id`; `branch_id`
  from binding. Personal-expense approve gate (existing detector). Categories from FieldSpec.
- [ ] Simplified today's-bills: list today's receipts + single Delete → "enter number" → "Bill deleted."
  **Branch-scoped.** Weekly = Sun–Sat.
- [ ] Tests: unbound refusal, binding lock, branch scope on today's-bills/delete, staff-tag step,
  personal-gate; personal bot path unchanged (flag off).
- [ ] Commit: `feat(m2): business Telegram bot — binding, staff-tag, branch-scoped flows`.

## Phase 6 — Frontend  (Jeevan)

**Files:** `public/index.html` + `public/js/*` (login, role-aware shell, team view, master overview,
payment tabs, excel-lite grid).

- [ ] Login screen (replaces bare token gate); role-aware shell: admin cockpit vs clerk branch view.
- [ ] Team/hierarchy view (branches, staff, generated creds display-once, binding-link icon) — mirror
  `concept-fresh.html`.
- [ ] Master overview with branch/staff drill-down; Payment Pending/Paid tabs with month+branch+staff
  filters, multi-select, sticky "N selected · total", bulk mark-paid; excel-lite grid (inline cell edit
  + autosave via per-field PATCH, values only, optimistic `updated_at`).
- [ ] Verify via preview tools (role-aware render, isolation, bulk-pay, cell edit). Personal dashboard
  unchanged when flag off.
- [ ] Commit: `feat(m2): role-aware dashboard, team view, payment tabs, excel-lite grid`.

---

## Verification (end-to-end, after phases land)

- `npm test` green throughout (personal baseline unchanged; new business tests added per phase).
- Business-on manual run: create account with `max_branches` + `multiUser=true`; admin creates 2 branches
  → 2 clerk logins + binding links; log in as clerk B → sees ONLY branch B; bind bot via `/start` →
  upload → "which staff?" → row appears in admin master under branch B/that staff; flag a personal
  receipt → clerk decides → admin sees "by clerk" + override; bulk mark a month paid (chunked) → clerk
  read-only; excel-lite cell edit autosaves, stale edit → refresh; export = one sheet + Branch/Staff;
  delete branch → clerk login + bot binding refuse.
- Flag-off regression: same build with `multiUser=false` behaves exactly like today's personal product.

## Out of scope (this epic) — see spec §12
Per-staff logins/bindings; stored per-branch workbooks; multi-sheet export; full-spreadsheet excel-lite;
DB-level JWT-RLS (later hardening); pooled multi-tenant (managed silos now — spec §10).
