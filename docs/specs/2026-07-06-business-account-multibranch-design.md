# Design — M2 Business-Account (Multi-Branch / Multi-Staff) Layer

> **Feature:** M2 — per-client business-account option: HQ admin + branches + branch clerks + staff
> attribution, on one delivered instance. The long-deferred multi-user layer (MUGI.md §5), now specced.
> **Status:** Design approved by Owner (Jeevan) 2026-07-06 (section-by-section sign-off). Ready for
> plan → phased subagent-TDD.
> **Depends on:** ADR-021 (this layer's architecture decisions), ADR-010 (one codebase + capability
> flags — M2 is additive/flag-gated), ADR-020 (M2 = per-client option, not SaaS multi-tenancy),
> `docs/specs/2026-07-03-user-onboarding-chatid-linking-design.md` (the `/start <token>` binding this
> reuses), ARCHITECTURE §3.1–3.7 frozen interfaces (built against, not changed).
> **Owners:** schema (`schema.sql`) + `lib/supabase.js` scope helper = **Barat** (his frozen files →
> sign-off first). New backend `lib/auth.js` / `lib/branches.js` + `routes/*` + report/expenses/review
> extensions = **Jeevan**. Frontend (`public/index.html` + JS: login, team view, master overview,
> payment tabs, excel-lite grid) = **Mugi**. Spec/ADR/plan/coordination = **Jeevan (Owner)**.
> **Tier:** **Tier-2** (authentication, DB schema, and cross-branch data-isolation surface) →
> mandatory independent cross-review before merge (SOP §4.7, ADR-008).

---

## 1. Problem & goal

Today the system is **single-account, single-dashboard, single static token** — one person who knows
`DASHBOARD_TOKEN` sees everything; the Telegram bot identifies a person only by `rep_chat_id`; there is
no user table, no roles, no branches. A client whose business has an **HQ office + several branch
offices, each with a clerk who captures receipts and staff who hand them over**, cannot run on this shape.

This feature adds a **per-client business-account layer** (turned on only for clients who want it,
ADR-010/020) so that, on one delivered instance:

- An **HQ Admin** creates branches; each branch gets a **Branch Clerk** with **auto-generated login
  credentials** and a **one-time Telegram binding link**.
- Clerks capture receipts (dashboard + a business-flavoured Telegram bot), tagging each to a **staff**
  member (a name in the branch's directory — attribution only, no login, no bot).
- The Admin sees a **live, aggregated master view** across every branch, with branch/staff drill-down,
  reports, export, a **staff-first anomaly review** flow, and a **payment pending/paid** tracker with
  bulk actions.
- The dashboard reshapes by role: **admin cockpit** (all branches, edit powers) vs **clerk branch view**
  (own branch, fewer powers).

**Done when:** an admin on a business-enabled instance can create branches → generated clerk creds +
binding links; a clerk logs in and sees **only their branch** (isolation holds); a clerk binds the bot
and uploads a receipt tagged to a staff member; it appears in the admin's master view under that
branch/staff; a flagged receipt is decided by the clerk first and the admin can only override (with an
N-day safety valve); the admin bulk-marks a month's bills paid while clerks see them read-only; export
produces one pivotable sheet with Branch/Staff columns; deleting a branch revokes its clerk's login and
bot binding; and the work has passed independent Tier-2 review.

## 2. Key insight — rows, not workbooks (the whole tangling problem, designed away)

The Owner's flagged risk — staff Excel files diverging from the admin's "master template" and tangling
the data — is removed **structurally**, not with reconciliation code, by one rule: **there is exactly
one data shape per client, and staff never define it.**

- The **column definition (FieldSpec)** already lives once per account in `field_templates` (#12). In a
  business account it is **HQ-owned**. Staff/clerks contribute **rows**, never columns.
- The **"live master template" is a query**, not a file: `expenses` grouped by branch → staff. A clerk's
  upload appears in the admin view on next load because it is literally the same table. There is **no
  stored master workbook and no sync** to drift.
- A **"branch workbook"** is just `buildWorkbook()` (#2) called with the rows filtered to that branch —
  generated on demand, never stored.
- **Import flows one way.** A staff-supplied Excel is **mapped into** the canonical FieldSpec at import
  time (the `parseTemplate` CANON aliasing already does this kind of header-mapping); unmappable fields
  fall to `ai_raw`/`remark`, never spawning a new column. Bulk **"import data back" is blocked** (already
  the "Import data back — Blocked (safety)" row in the concept's access matrix).

Because two things can only "tangle" if they have different shapes that must be reconciled, and there is
now only ever **one** shape that only HQ can change, shape-mismatch is **impossible by construction**.

## 3. Architecture (additive; reuses the existing spine)

```
                         ┌─────────────── one client instance (one account_id) ───────────────┐
  HQ Admin login ───▶ role=admin  ──┐                                                          │
  Branch Clerk login ─▶ role=clerk ─┤   lib/auth.js: scrypt verify → session token             │
                                    │   scopeForUser(user) → { account_id, branch_id?, role }   │
                                    ▼                                                           │
      routes/* ── every query passes through the ONE scope helper (the "bouncer") ──▶ Supabase  │
                                    ▲                                                           │
  Telegram (clerk only) ─ /start <token> ─▶ bot_bindings: chat_id → user/branch/role (locked)   │
                                                                                                │
  expenses rows tagged { account_id, branch_id, staff_user_id } ── live GROUP BY ─▶ master view │
                         └──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Identity & auth — `lib/auth.js` (Jeevan; new concern)

The identity layer the system doesn't have yet, built as light as is safe for a next-week ship.

```
hashPassword(plain) -> "scrypt$<salt>$<hash>"          // Node core crypto.scrypt — NO new dependency
verifyPassword(plain, stored) -> bool                   // constant-time compare (timingSafeEqual)
mintSession(user) -> token                              // opaque random; stored HASHED in sessions
lookupSession(token) -> { user_id, account_id, branch_id, role } | null
revokeSessionsForUser(user_id) -> void
scopeForUser(user) -> { account_id, branch_id?, role }  // THE central bouncer
```

- **Passwords never stored in the clear** — only a scrypt fingerprint (salt + hash). `crypto.scrypt` is
  in Node core, so this honours the two-deps ethos (no bcrypt/argon dependency).
- **Session = opaque token** returned as `Authorization: Bearer` — the *exact* header `checkDash` already
  reads. The only change to the existing auth path: instead of comparing to one env constant, look the
  token up → resolve `{account_id, branch_id, role}`.
- **`scopeForUser` is the single choke-point.** Admin → `{account_id}` (all branches). Clerk →
  `{account_id, branch_id}` (their branch only). Every route derives its query filter from this one
  helper so no endpoint can forget to scope. This is the security backbone (see §6).

### 3.2 Scope enforcement — `lib/supabase.js` extension (Barat; his frozen file → sign-off)

`sbSelect/sbInsert/sbUpdate/sbSoftDelete` already auto-inject `account_id`. Extend them to also accept an
optional **branch scope** derived from `scopeForUser`, so a clerk's reads/writes are transparently
constrained to their `branch_id`. Admin scope passes no branch filter (sees all). Keeping this in the
existing helper (not each route) is what makes the bouncer trustworthy.

### 3.3 Provisioning — `lib/branches.js` + `routes/branches.js` (Jeevan)

```
createBranch(account_id, { state?, office, clerkName }) 
   -> { branch, clerk: { username, password /* shown ONCE */ }, bindingLink }
listBranches(scope) ; softDeleteBranch(scope, branch_id)
addStaff(scope, branch_id, name) ; listStaff(scope, branch_id) ; removeStaff(scope, branch_id, staff_id)
```

- On branch create: one `branches` row + one `users` row (role=clerk, scrypt fingerprint, active=true) +
  a one-time `bot_bindings` token; the generated username + password are returned **once** for the admin
  to hand over, then only the fingerprint remains.
- **`max_branches`** cap read from `account_settings`/`getCapabilities()` (the "how many they pay for").
- Admin **or** the branch's own clerk may manage that branch's staff directory (access matrix).
- **Delete = soft-revoke:** `active=false` + `revokeSessionsForUser` + bot binding refuses + notify clerk
  via bot. Nothing hard-deleted (audit-safe, reuses the soft-delete pattern).

### 3.4 Master view & reports — `routes/reports.js` + `lib/reports.js` extension (Jeevan)

`buildReport()` already buckets by time + category. Add **branch** and **staff** as grouping dimensions;
the admin Overview drills branch → staff → receipt. The clerk view calls the same code pre-filtered by
`scopeForUser` to their branch. No new aggregation engine — the master view *is* this query.

### 3.5 Export — `lib/excel.js` (reused as-is, Jeevan glue)

`buildWorkbook(expenses, fieldSpec)` called with rows filtered to the current selection (all / branch /
staff / date). **v1 = one sheet** with two added attribution columns (**Branch**, **Staff**) so an
accountant can pivot/filter in Excel. The "one tab per branch" split is a later, data-free rendering
change (out of scope, §10).

### 3.6 Anomaly (staff-first) & payments — `routes/review.js` + `routes/expenses.js` extension (Jeevan)

- **Anomaly reuses the whole existing machine** (`status` saved/needs_review/rejected, the `anomaly`
  JSONB audit trail, `routes/review.js`). Business rules layered on: the review queue is **branch-scoped**;
  the **clerk decides first** (audit records `decided_by_role='clerk'`); the admin sees items already
  stamped "approved/rejected by clerk" and can **override** an existing decision but **not originate**
  one — **except** an admin **safety valve**: after an item sits unresolved **N days** (`ANOMALY_VALVE_DAYS`)
  the admin may force-decide, so the queue never jams.
- **Payments:** new per-receipt `payment_status` (`pending` default / `paid`) + `paid_at` + `paid_note`.
  **Admin edits, clerk views** (enforced by the bouncer — only role=admin may write `payment_status`).
  Pending/Paid tabs = a filter; **bulk mark-as-paid** is a role-guarded batch `PATCH` over a selected id
  list, **chunked** for large sets (the Bill.com 200-cap lesson), reversible from the Paid tab. Reuses
  the existing `PATCH /api/expenses` validation; optimistic `updated_at` guards concurrent edits.

### 3.7 Business Telegram bot — `lib/bot.js` + `routes/webhook.js` extension (Barat boundary; Jeevan logic)

A **clerk tool** (only clerks are bound). Reuses today's-bills, weekly, media-group batch, confirm-delete,
category-picker, and `rep_chat_id` ownership plumbing; reshapes scope from person → branch:

- **First contact = role lock:** `/start <token>` validates the one-time link → binds
  `chat_id → clerk/branch/role` in `bot_bindings`, locked. Unbound chats are refused ("ask your admin for
  your link"). This *is* the CIO section's "lock role on first access," sourced from the admin page.
- **Upload → "which staff?"** the branch's staff directory as inline buttons (remember-last as default);
  `branch_id` comes from the binding automatically. Tags `staff_user_id`.
- **Personal-expense gate:** the existing `personal` anomaly detector → "⚠ looks personal — approve to
  save?" → saves only on approve.
- **Categories from the FieldSpec** (the imported Excel template) via `categorize.js`; unknown →
  existing ask-for-remark flow.
- **Simplified today's bills:** list today's receipts **with staff name** + a **single Delete** button →
  "enter the number of the receipt to delete" → the message becomes "Bill deleted." **Branch-scoped.**
  Weekly record switches to **Sun–Sat**.

## 4. Data flow (end to end)

```
Admin creates branch → users(clerk) + branches + bot_bindings(token) ; creds shown once
Clerk logs in → scrypt verify → session token (Bearer) → scopeForUser → {account_id, branch_id, role=clerk}
Clerk taps binding link → /start <token> → chat_id bound to clerk/branch (locked)
Clerk sends receipt photo → OCR pipeline → "which staff?" → row { account_id, branch_id, staff_user_id }
   (personal? → approve gate ; flagged? → status=needs_review in that branch's queue)
Admin Overview → buildReport grouped by branch/staff → drill-down → export (1 sheet + Branch/Staff cols)
Clerk decides flagged item first → admin sees "…by clerk", may override (or force-decide after N days)
Admin bulk-marks month's bills paid (chunked) → clerks see payment_status read-only
Admin deletes branch → clerk active=false → sessions killed + bot binding refuses + clerk notified
```

## 5. New / changed schema (Barat owns `schema.sql`)

- **`branches`** — `id, account_id, state?, office, clerk_name, active, created_at`.
- **`users`** — `id, account_id, branch_id?, role (admin|clerk|staff), username?, password_hash?,
  display_name, active, created_at`. (Staff rows carry name only — no username/hash/bot.)
- **`sessions`** — `token_hash, user_id, account_id, created_at, expires_at` (opaque bearer lookup).
- **`bot_bindings`** — `chat_id?, user_id, account_id, branch_id, role, bind_token, token_expires_at,
  bound_at?, active`.
- **`expenses`** — add `branch_id`, `staff_user_id`, `payment_status` (default 'pending'), `paid_at`,
  `paid_note`. Anomaly audit gains `decided_by_role` (in the existing `anomaly` JSONB).
- **`account_settings`** — carries `max_branches` + business capability flags (via `getCapabilities`).
- RLS stays as-is (service-role mediated) for v1; JWT-scoped RLS is the later hardening step (§6, ADR-021).

## 6. Security & privacy (Tier-2 — auth + cross-branch isolation)

- **Isolation is enforced by the one `scopeForUser` bouncer**, funnelled through the `lib/supabase.js`
  helpers — a single, tested choke-point rather than per-route filters. This is the #1 review focus:
  test that **branch A's clerk can never read/write/export/delete branch B's rows** (positive and negative
  tests on every route).
- **App-side scoping is a policy, not a wall (honest limitation):** until DB-level RLS is enabled, a
  coding bug *could* leak cross-branch data because the database itself won't stop it. Mitigation = the
  single choke-point + isolation tests; **RLS remains on the roadmap** as belt-and-suspenders (ADR-021).
- **Passwords:** scrypt fingerprints only, constant-time verify; **generated passwords shown once**, never
  stored or logged.
- **Sessions:** opaque tokens stored **hashed**; revoked on branch/staff soft-delete; expiry enforced.
- **Bot binding tokens:** one-time + expiring, so a forwarded link can't bind a stranger; unbound chats
  refused.
- **No secrets/PII in logs** (ADR-002 unchanged); `account_id` scoping unchanged and now joined by branch
  scoping.

## 7. Testing (TDD; phased; independent Tier-2 QA before merge)

- **Auth (`lib/auth.js`):** hash/verify round-trip, wrong password rejected, tampered session rejected,
  expired session rejected, `scopeForUser` returns correct shape per role.
- **Isolation (the critical suite):** clerk B cannot read/patch/delete/export branch A rows via any route
  or the bot; admin can. Plant a branch-A row and assert it never appears in a branch-B response.
- **Provisioning:** `max_branches` cap enforced; create returns creds once; soft-delete flips `active`,
  kills sessions, and makes the bot binding refuse.
- **Reports/export:** master aggregate == sum of branch rows; export carries Branch/Staff columns; clerk
  report pre-filtered.
- **Anomaly/payments:** clerk-first gate (admin cannot originate before N days), valve fires after N days,
  bulk mark-paid chunks large sets and is reversible, `payment_status` write refused for clerks,
  optimistic `updated_at` rejects a stale edit.
- **Bot:** unbound chat refused; `/start <token>` binds + locks; branch-scoped today's-bills; staff-tag
  step; delete-by-number; personal-expense approve gate.

## 8. Ownership & sequencing

> **Owner reassignment for THIS epic (2026-07-06):** the authoritative task split is the table in
> `docs/plans/2026-07-06-business-account-multibranch.md` — **Jeevan** takes Supabase schema + identity/
> auth + provisioning + reports/payments + **all frontend**; **Barat** takes `lib/supabase.js` scope
> helper + the business Telegram bot + Groq ZDR/OCR-provider knob + FieldSpec plumbing; **Mugi off** this
> epic. **Flag-gating invariant (ADR-010):** the whole layer sits behind `capabilities.multiUser`; with
> the flag OFF the personal product is byte-for-byte unchanged and all existing tests stay green. The
> table below records the default-map lanes for reference.

| Piece | Owner | Notes |
|---|---|---|
| This spec + ADR-021 + plan + coordination | **Jeevan (Owner)** | drives |
| `schema.sql` (new tables + columns) + `lib/supabase.js` scope extension | **Barat** | his frozen files → sign-off first (ARCHITECTURE §3.3) |
| `lib/auth.js`, `lib/branches.js`, `routes/{auth,branches}.js` | **Jeevan** | new backend concern |
| `routes/{reports,expenses,review}.js` extensions | **Jeevan** | reuse existing validators |
| `lib/bot.js` + `routes/webhook.js` business paths | **Barat** boundary / **Jeevan** logic | coordinate on the shared file (SOP §4.6) |
| Frontend (login, team view, master overview, payment tabs, excel-lite grid) | **Mugi** | `public/index.html` + JS |

**Sequence (phased, each shippable/testable):**
1. **Identity foundation** — schema + `lib/auth.js` + `POST /api/login` + swap `checkDash` to session
   lookup + `scopeForUser` bouncer + isolation tests.
2. **Provisioning** — `lib/branches.js` + `routes/branches.js` (creds + binding token + staff directory +
   soft-revoke).
3. **Data dimensions** — `branch_id`/`staff_user_id` on writes; report grouping + drill-down; filtered export.
4. **Anomaly + payments** — branch-scoped clerk-first review + N-day valve; `payment_status` + chunked
   bulk mark-paid.
5. **Bot** — `/start` binding, staff-tag, branch-scoped today's-bills + simplified delete.
6. **Frontend** — role-aware shell, team view, master overview, payment tabs, excel-lite grid (Mugi).

## 9. Config (env-driven, ARCHITECTURE §3.5)

- `ANOMALY_VALVE_DAYS` — days before the admin may force-decide a clerk-unresolved item (default 3).
- `SESSION_TTL_HOURS` — session lifetime (sensible default).
- `BIND_TOKEN_TTL_MINUTES` — one-time bot-binding link lifetime.
- `BULK_PAY_CHUNK` — batch size for bulk mark-as-paid (default ~100–200).
- `max_branches` — per-client cap (in `account_settings`, not env — it's per-instance data).

## 10. Per-client delivery, isolation & customization (multi-client)

This layer is delivered as an **isolated instance per client company** (ADR-020): **one codebase, N
deployments.** As more companies want this system, each gets its own instance that reuses *everything*
and differs only in a **config/data surface — never a code fork:**

- **Their columns & categories** → FieldSpec rows in `field_templates` (#12) + the category set. Data.
- **Branding** (company name, logo, colours) → `account_settings` KV. Data.
- **Which features/roles are on** (business layer, `claimsTax`, bank-rec, …) → capability flags
  (ADR-010 `getCapabilities`). Config.
- **Currency, `ANOMALY_VALVE_DAYS`, `max_branches`, `BULK_PAY_CHUNK`** → env / `account_settings`. Config.
- **Their own Telegram bot, Supabase project, Groq keys** → per-instance `.env`.

**Hard rule (the guardrail that keeps N clients maintainable):** a client-specific request becomes
either **(a)** a new **config knob** every instance can use, or **(b)** a **flag-gated capability
module** — **never** a per-client code branch. If a request can't be generalized into one of those,
that's the signal to push back or design it as a flagged module, not to fork `main`. One repo, one test
suite, N configured deployments. Any `if (client === "X")` in code means the model is broken.

**Hosting model (DECIDED — managed silos, operated by us).** We host and operate everything; the client
touches nothing (this is the solution-provider value prop). Each company runs as its **own hosted
instance + own Supabase project + own bot token**, all on our infrastructure. **Cross-company isolation
is physical** (separate databases), not `account_id`/branch row-filters — so a scoping bug can at worst
leak *between branches of the same company* and **never between two companies**. This bounds the §6
app-side-scoping caveat to within-company and is a further reason the RLS-deferral is acceptable for v1.
Onboarding a client = a provisioning script (spin up their Supabase project + deploy + bot token + seed
their template), not a code change.

**Forward-compatibility to a pooled model (free — no schema cost now).** Every table already carries
`account_id` and every query auto-injects it (`lib/supabase.js`); in the silo model each instance simply
*is* one `account_id`. So if client volume ever makes running N instances the bottleneck, migrating to a
**pooled multi-tenant** shape (many `account_id`s in one shared DB) is already structurally open — the
tenant seam exists today. That migration is **deliberate, not a switch-flip:** because the app currently
uses the service-role key (which **bypasses RLS**), pooling would require moving company-scoped queries
onto Supabase-Auth + **JWT-scoped RLS keyed on `account_id`**. Silos need none of that, so v1 ships clean
and the door to pooling stays open (revisit only at scale).

## 11. Data privacy, security & client-trust posture

On a managed-silo deployment we are the client's **data processor** (they are the controller). A client
asking *"will you leak our data / what do you do about it?"* is answered on three legs — **technical
controls, contractual commitments, transparency.**

**Technical controls (in place / by design):**
- **Physical per-company isolation** — each company in its own Supabase project; no cross-company reach.
- **Encrypted in transit (TLS)** and **at rest** (Supabase default).
- **Least privilege** — service-role server-side only; the browser never touches the DB directly.
- **No secrets/PII in logs; card last-4 masked; retention policy** (ADR-002).
- **scrypt-hashed passwords, revocable sessions**, soft-delete/revoke on offboarding.
- **Data export + delete-on-exit** (they're never locked in or exposed forever).

**Sub-processors (must disclose):** Supabase (DB/storage), the OCR/vision provider (default Groq),
Telegram (bot transport), the FX API. Receipt content leaves to the OCR provider — **disclose proactively.**

**OCR provider is a per-deployment config knob (key mitigation).** Vision/OCR flows through one boundary
(`lib/groq.js` + model routing), so the OCR backend is swappable per instance:
- **Default:** Groq — **verified (2026-07-06):** Groq's Services Agreement forbids training/fine-tuning
  on Inputs/Outputs; data **not retained by default** (temporary ≤30-day logs only for error/abuse
  troubleshooting); **Zero Data Retention (ZDR) is a Console toggle** that removes even that; a **DPA**
  (GDPR/CCPA/**PDPL**) is available. **Action:** enable ZDR on the account (Barat) so the client-facing
  claim "does not train on your data and retains nothing" is airtight; countersign Groq's DPA for
  regulated clients.
- **Stricter/regulated client:** point that instance at a provider with a signed **DPA + zero-retention**
  (Azure OpenAI / AWS Bedrock / Google Vertex) or a managed document-OCR (AWS Textract / Google Document
  AI / Azure Document Intelligence).
- **Air-gapped/on-prem mandate only:** self-hosted OCR (last resort, large lift).
So "no third-party LLM" is handled by **provider escalation + a DPA**, a per-silo config change — not local
hosting and not a rewrite.

**Pre-sale gaps to close (ADR-015 custody ladder + paperwork) — do BEFORE onboarding a paying client:**
1. Company-owned Supabase org, **paid tier, one project per client, PITR backups, region set** — off the
   personal free project.
2. **Legal entity** (to sign contracts/DPAs).
3. **DPA + plain-English data-handling summary.**
4. **Breach/incident runbook + contractual notification clause** (norm: ≤72h).
5. **Operator hygiene:** MFA on every admin account (Supabase/host/Cloudflare/GitHub/BotFather/OCR),
   company email (not personal), password manager, **named minimal access register**, per-person logins.

**Client-facing security one-pager (stub to produce):** what we store · where (region) · encryption
(transit/rest) · who can access (named, minimal) · isolation (dedicated DB) · sub-processors · backups ·
retention · export & deletion on exit · breach-notification commitment.

**Infrastructure & domain/cost posture (corrected):** a custom domain is **not technically required** —
free host subdomains work, and the Telegram bot needs only a public HTTPS **webhook**, not a custom
domain. At most **one ~$10/yr company domain** covers **unlimited client subdomains** (`clientA.ourbrand.com`)
with free auto-SSL; alternatively the client points a subdomain of **their own** domain at the instance
(we buy nothing — best fit for "it's their system"). We **never** need one paid domain per client.

## 12. Out of scope (YAGNI / deferred)

- **Per-staff dashboard logins and per-staff bot bindings** — cut; only clerks are credentialed/bound.
- **Stored per-branch workbooks / a synced master file** — cut entirely (rows-not-workbooks).
- **Multi-sheet ("one tab per branch") export** — deferred; v1 is one pivotable sheet.
- **Full spreadsheet excel-lite** (keyboard nav, copy-paste ranges, fill-down) — fast-follow; v1 is
  inline-cell-edit + autosave (values only, no column changes).
- **DB-level JWT-scoped RLS** — later hardening milestone (v1 isolation is the app-side bouncer).
- **Per-supplier/merchant payment grouping** — possible later add to the payment tab.
- **Any change to the frozen OCR/extraction interfaces** — consumed as-is.
