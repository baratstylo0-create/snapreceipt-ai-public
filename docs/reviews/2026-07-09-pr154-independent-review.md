# Independent Senior Review — PR #154

**Repository:** `Jeevan1811/receipt-analyser-saas`  
**Pull request:** #154 — `feat(m2): Team management view + business-mode branding`  
**Branch:** `feat/jeevan-m2-business-frontend`  
**Base:** `main`  
**Reviewed commit:** `7bcee72b0a1b0134eec27a161fa47fae03a3321b`  
**Review date:** 2026-07-09  
**Reviewer:** GPT-5.5 Codex, independent senior code-review/debugging pass  
**Verdict:** **Request changes**

---

## 1. Executive summary

The branch is mechanically healthy: the hermetic suite passes **1607/1607**, CI is green, the changed frontend consistently uses DOM text APIs rather than `innerHTML`, and the direct expense and statement routes correctly apply branch scope in the ordinary paths.

However, the review found four release-blocking issues:

1. The Agent API does not apply `req.scope` to any of its database helpers. An authenticated branch clerk can therefore read and mutate another branch's expenses through Agent tools.
2. The grid's optimistic concurrency check is a non-atomic read-then-write. Two concurrent edits can both pass and silently overwrite one another.
3. Any authenticated clerk can replace the account-wide FieldSpec and category set through `POST /api/templates`, despite ADR-021 defining this shape as HQ-owned.
4. A categories-only save resends a cached copy of all columns, allowing a concurrent or immediately preceding field save to be reverted.

These are not theoretical style objections. Each has a concrete failure sequence below. The first is a cross-branch authorization breach; the next three can corrupt or erase client configuration/financial data. PR #154 should not merge until they are fixed and protected by regression tests.

The review also found several medium/low-priority correctness problems: statement export cannot select a branch with no expenses, editing an obsolete category can clear it merely on blur, custom categories are exposed from an unauthenticated config endpoint, Manage sub-pages cannot retry a transient load failure, and the CSV formula guard does not cover whitespace/control-prefixed payloads.

---

## 2. Scope and verification performed

### 2.1 Required context read

The review followed the repository startup chain and examined:

- `docs/FRICTION_PROJECT_SOP.md`
- `AGENTS.md`
- `docs/PROJECT_BRIEF.md`
- `docs/ARCHITECTURE.md`, especially the frozen interfaces
- `docs/WORKLOG.md`
- `docs/STATUS.md`
- `docs/HANDOFF.md`
- `CLAUDE.md`
- `docs/DECISIONS.md`, especially ADR-020 through ADR-026
- `docs/clients/premala.md`
- `docs/roles/JEEVAN.md`
- The user-supplied independent-review brief

### 2.2 Git and PR identity verified

The checked-out worktree was verified as:

```text
branch: feat/jeevan-m2-business-frontend
HEAD:   7bcee72b0a1b0134eec27a161fa47fae03a3321b
base:   main
PR:     #154, OPEN
CI:     SUCCESS
```

The only pre-existing untracked paths were:

```text
.claude/worktrees/
AGENTS.md
```

They were not modified.

### 2.3 Tests run

The repository `.env` was moved aside for the test command and restored afterward, following the repo's hermetic-test requirement.

```powershell
node --test
```

Result:

```text
tests:    1607
pass:     1607
fail:     0
duration: ~12 seconds
```

Passing tests do not invalidate the findings below; the relevant concurrency, role-authorization, and cross-branch Agent cases are not currently represented in the suite.

### 2.4 Code paths traced

The review traced:

- `public/js/components/grid.js`
- `public/js/components/payments.js`
- `public/js/components/templates.js`
- `public/js/components/manage.js`
- `public/js/components/team.js`
- `public/js/components/nav.js`
- `routes/expenses.js`
- `routes/statement.js`
- `routes/templates.js`
- `routes/agent.js`
- `routes/auth.js`
- `lib/supabase.js`
- `lib/auth.js`
- `lib/agent.js`
- `lib/agentProposals.js`
- `lib/templates.js`
- Related route and frontend tests

The route inventory was also searched for every `/api/*` registration and every `sbSelect`, `sbInsert`, `sbUpdate`, and `sbSoftDelete` call to identify scope omissions.

---

## 3. Ranked confirmed findings

## Finding 1 — Critical: Agent API bypasses branch isolation

**Severity:** Critical / release blocker  
**Category:** Authorization, cross-branch financial-data disclosure and mutation  
**Primary files:**

- `routes/agent.js:35-41`
- `routes/agent.js:43-58`
- `routes/agent.js:73-82`
- `lib/agent.js:25-35`
- `lib/agent.js:97-115`
- `lib/agent.js:455-485`
- `lib/agentProposals.js:37-60`

### What is wrong

`checkDash` correctly resolves a business session and sets:

```js
req.user
req.scope
```

But `routes/agent.js` constructs `writeDeps` once, at route-mount time:

```js
const writeDeps = {
  sbSelect: deps.sbSelect || sbSelect,
  sbUpdate: deps.sbUpdate || sbUpdate,
  sbSoftDelete: deps.sbSoftDelete || sbSoftDelete,
  saveTemplate: deps.saveTemplate || saveTemplate,
  getFieldSpec: deps.getFieldSpec || getFieldSpec,
};
```

The handlers pass these raw helpers directly into `runAgent()` and `confirmProposal()`:

```js
const out = await runAgent(messages, { chat, ...writeDeps, autoMode });
```

```js
const result = await confirmProposal(proposalId, writeDeps);
```

No helper receives `req.scope`.

`lib/agent.js` consequently performs unscoped account-wide queries:

```js
return sbSelect('expenses', {
  extra: 'deleted_at=is.null&status=neq.rejected',
  order: 'created_at.desc',
  limit: ROW_FETCH_LIMIT
});
```

and:

```js
const rows = await sbSelect('expenses', { eq: { id } });
```

Its confirmed writes are also unscoped:

```js
await sbUpdate('expenses', { id }, clean.body);
await sbSoftDelete('expenses', { id });
await sbUpdate('expenses', { id }, { status, anomaly });
```

`lib/supabase.js` only applies branch isolation when a `scope` is actually supplied. Omitting it falls back to account-only filtering, so a clerk sees the entire client account.

### Concrete failing scenario

Assume:

```text
branch A clerk session: branch_id = bA
branch B expense:        id = exp-B, merchant = "Private Supplier", branch_id = bB
```

The branch-A clerk sends:

```http
POST /api/agent
Authorization: Bearer <branch-A-clerk-session>
Content-Type: application/json

{
  "messages": [
    {
      "role": "user",
      "content": "List all expenses from Private Supplier."
    }
  ]
}
```

When the model invokes `listExpenses`, `loadExpenses()` performs an account-wide query without `scope`. The result can contain `exp-B`, including its merchant, amount, category, date, status, remark, and raw expense ID.

The ID is deliberately exposed by `listExpenses` so the propose tools can act on it. The clerk can then ask:

```text
Change that expense amount to 1.
```

With:

```json
{ "autoMode": true }
```

the edit proposal is auto-confirmable. `confirmProposal()` calls unscoped `sbUpdate('expenses', {id:'exp-B'}, ...)`, modifying branch B.

Delete is not auto-confirmable, but a clerk can still create and explicitly confirm a delete proposal. The confirm path remains unscoped.

### Additional proposal-ownership problem

`lib/agentProposals.js` stores proposals globally by random ID:

```js
const store = new Map();
```

Proposal records contain no creator identity, session identity, role, branch, or scope. `/api/agent/confirm` accepts any valid proposal ID from any authenticated user. IDs are high-entropy and not realistically guessable, but this is still a missing authorization binding: possession of a proposal ID is treated as authority to execute it.

### Required fix

Create scoped adapters inside each authenticated request, with trusted scope injected **after** caller-provided options:

```js
function scopedDeps(req) {
  return {
    sbSelect: (table, opts = {}) =>
      sbSelect(table, { ...opts, scope: req.scope }),

    sbUpdate: (table, key, patch) =>
      sbUpdate(table, { ...key, scope: req.scope }, patch),

    sbSoftDelete: (table, key) =>
      sbSoftDelete(table, { ...key, scope: req.scope }),
  };
}
```

Then pass the request-specific dependencies into both `runAgent()` and `confirmProposal()`.

Also:

- Bind every proposal to at least `user_id`, `account_id`, `role`, and branch scope.
- Require the confirmer to match the creator, unless an explicitly designed admin-override policy exists.
- Make `ADD_TEMPLATE_FIELD` admin-only.
- Consider making all Agent writes admin-only until every tool has an explicit role policy.
- Do not trust the model to enforce permissions. Tool availability and server-side helpers must enforce them.

### Regression tests required

1. Branch-A clerk Agent `listExpenses` receives only branch-A rows.
2. Branch-A clerk Agent report/top-merchants calculations exclude branch B.
3. Branch-A clerk cannot propose an edit/delete/review action for a branch-B ID.
4. Even if a branch-B proposal somehow exists, branch-A confirm cannot update/delete branch B.
5. A proposal created by user A cannot be confirmed by user B.
6. Clerk cannot execute `ADD_TEMPLATE_FIELD`.
7. Admin retains intended account-wide Agent access.

---

## Finding 2 — High: optimistic concurrency check is non-atomic

**Severity:** High / release blocker  
**Category:** Lost update, financial-data integrity  
**Primary files:**

- `public/js/components/grid.js:33-59`
- `routes/expenses.js:175-203`
- `lib/supabase.js:88-93`

### What is wrong

The client correctly includes the row's loaded timestamp:

```js
if (row.updated_at) {
  patch.expected_updated_at = String(row.updated_at);
}
```

The server checks it:

```js
const curRows = await sbSelect('expenses', {
  eq: { id: req.params.id },
  scope: req.scope
});

if (String(cur.updated_at || '') !== expected) {
  return res.status(409).json(...);
}
```

But the subsequent write is a separate network/database operation:

```js
const rows = await sbUpdate(
  'expenses',
  { id: req.params.id, scope: req.scope },
  body
);
```

`sbUpdate()` only filters by ID/account/branch/company. It does not include `updated_at` in the PATCH predicate.

This is a classic time-of-check/time-of-use race. The timestamp comparison proves only that the row was current when the SELECT ran, not when the PATCH executes.

### Concrete failing interleaving

Initial row:

```json
{
  "id": "e1",
  "merchant": "Old",
  "amount": 10,
  "updated_at": "T1"
}
```

Request A:

```json
{
  "merchant": "New Merchant",
  "expected_updated_at": "T1"
}
```

Request B:

```json
{
  "amount": 99,
  "expected_updated_at": "T1"
}
```

Possible execution:

```text
A SELECT sees T1 -> passes
B SELECT sees T1 -> passes
A PATCH writes merchant -> updated_at becomes T2
B PATCH writes amount    -> updated_at becomes T3
A returns 200
B returns 200
```

If the PATCH payloads affect overlapping fields, the later request silently wins. Even with distinct fields, the claimed guarantee—“a stale or concurrent edit 409s”—is false.

The race is especially reachable in the UI because multiple cells can briefly be editing/saving against the same local row timestamp.

### Rows with no `updated_at`

`buildCellPatch()` intentionally omits the guard when `row.updated_at` is absent. Such rows have no concurrency protection at all:

```js
if (row.updated_at) patch.expected_updated_at = String(row.updated_at);
```

The current unit test explicitly blesses this behavior. If nullable/pre-migration timestamps remain supported, the system must define an alternative concurrency policy rather than silently disabling protection.

### Required fix

Make comparison and mutation one atomic PostgREST PATCH:

```text
/expenses
  ?id=eq.<id>
  &account_id=eq.<account>
  &branch_id=eq.<branch>
  &updated_at=eq.<expected>
```

The DB update must match both the row identity and expected timestamp in the same statement.

Suggested shape:

```js
async function sbUpdate(table, { id, scope, expectedUpdatedAt }, patch) {
  // Build normal scope predicates.
  // If expectedUpdatedAt is supplied, add updated_at=eq.<value>.
  // Prefer return=representation.
}
```

Then:

- One returned row → success.
- Zero returned rows with an expected timestamp → stale/not-found ambiguity.
- Perform a scoped existence lookup only after zero rows if the API needs to distinguish 404 from 409.
- Do not return `{ok:true}` for an empty update result.

### Regression tests required

Build a deterministic race test with a barrier:

1. Seed one row at T1.
2. Start two PATCH requests with expected T1.
3. Release them together.
4. Assert exactly one returns 200.
5. Assert exactly one returns 409.
6. Assert final row equals the winning complete update.

Also test:

- stale own-branch edit → 409;
- another-branch ID remains 403/404 according to the chosen non-enumeration policy;
- nonexistent admin ID does not return fake `{ok:true}`;
- null/missing `updated_at` behavior is explicit.

---

## Finding 3 — High: clerk can overwrite the HQ-owned account template and categories

**Severity:** High / release blocker  
**Category:** Missing role authorization, global configuration corruption  
**Primary files:**

- `routes/templates.js:31-41`
- `routes/templates.js:47-76`
- `public/js/components/nav.js:41-56`
- `public/js/components/manage.js:26-35`
- `public/js/components/templates.js:946-956`
- `docs/DECISIONS.md`, ADR-021

### What is wrong

ADR-021 explicitly defines one canonical FieldSpec per client and says:

> Exactly ONE data shape per client — the FieldSpec (#12) — and it is HQ-owned. Staff contribute rows, never columns.

But `POST /api/templates` has only `checkDash` authentication:

```js
app.post(
  '/api/templates',
  templatesLimiter,
  checkDash,
  ...
);
```

It does not require:

```js
req.scope.role === 'admin'
```

In business mode, `sectionsFor()` gives clerks the same top-level sections as admins. `Manage` always includes Template & Categories, while the Data editor is the only capability-gated sub-page.

The frontend therefore actively presents account-wide template/category controls to a branch clerk, and the server accepts the mutation.

### Concrete failing scenario

Branch-A clerk logs in and sends:

```http
POST /api/templates
Authorization: Bearer <branch-A-clerk-session>
Content-Type: application/json

{
  "name": "default",
  "csv": "Merchant,Amount",
  "categories": ["Personal", "Others"]
}
```

The request succeeds.

Consequences affect the whole client instance:

- OCR extraction fields change.
- Admin and every other branch receive the altered category set.
- Statement category numbering changes.
- Category dropdowns change.
- Future exports follow the clerk's replacement FieldSpec.

This is not branch-scoped data entry. It is HQ-owned account configuration.

### Required fix

Server:

```js
function adminOnly(req, res, next) {
  if (!req.scope || req.scope.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}
```

Apply it to `POST /api/templates` in multi-user mode. Preserve the personal-mode owner behavior.

Frontend:

- `subPagesFor()` should accept role, not merely a boolean `business`.
- Admin: Template & Categories + Data editor when enabled.
- Clerk: Data editor when enabled; no account-template editor.
- If a clerk has no permitted Manage sub-page, remove Manage from their nav.

GET `/api/templates` may remain readable if clerks need labels for their UI, but write authorization must be explicit and server-enforced.

### Regression tests required

1. Business clerk POST `/api/templates` → 403.
2. Business admin POST `/api/templates` → 200.
3. Personal static-token owner retains existing behavior.
4. Clerk UI does not mount Template & Categories.
5. Direct API request remains blocked even if the UI is bypassed.

---

## Finding 4 — High: categories-only save can revert or lose columns

**Severity:** High / release blocker  
**Category:** Configuration data loss, race condition  
**Primary files:**

- `public/js/components/templates.js:607-617`
- `public/js/components/templates.js:641-660`
- `public/js/components/templates.js:824-833`
- `public/js/components/templates.js:946-956`
- `routes/templates.js:67-76`
- `lib/templates.js:265-290`

### What is wrong

The category editor attempts to preserve columns by keeping the last loaded/saved array:

```js
var currentColumns = [];

function renderSpec(spec) {
  var vm = summarizeFieldSpec(spec);
  currentColumns = vm.columns;
}
```

On category save it reconstructs CSV from that cached array:

```js
var csv = columnsToCsvHeader(currentColumns);
submitCsv(csv, nameInput.value, names, ...);
```

This is safe only if no one changes the columns between the load and category save.

The server's `saveTemplate()` has a useful contract for omitted `categories`, but it has no “categories-only” write contract. The POST route always requires CSV and therefore always rewrites columns.

### Concrete single-user failure

No second admin is necessary.

Initial stored columns:

```text
Merchant,Date,Amount
```

The page loads them into `currentColumns`.

The user edits the visual field builder to:

```text
Merchant,Date,Amount,Project Code
```

Then:

1. Click **Save template**. Request A sends the new four-column header.
2. Before A completes and calls `renderSpec()`, click **Save categories**.
3. Request B reconstructs CSV from stale `currentColumns`, still containing only three columns.
4. A stores four columns.
5. B finishes after A and stores three columns plus the new categories.
6. “Project Code” disappears.

The two busy flags are independent:

```text
fbBusy
catBusy
```

Saving one section does not disable the other.

The same loss occurs with:

- two browser tabs;
- two devices logged in as admin;
- an operational script updating the template while the page is open;
- any future second admin role.

### Static round-trip assessment

For a FieldSpec produced through the current CSV/Excel parsers, `columnsToCsvHeader()` correctly preserves label order and ordinary comma/quote escaping when no concurrent update occurs. The static helper is not the primary defect.

The problem is architectural: categories-only save should not transmit or overwrite columns at all.

### Required fix

Preferred:

```http
PATCH /api/templates/categories
{
  "categories": [...],
  "expected_updated_at": "..."
}
```

The server should:

- validate admin authorization;
- update only `categories`;
- optionally perform atomic `updated_at` CAS;
- return the effective FieldSpec.

Alternative:

Allow `POST /api/templates` with `{categories}` and no CSV, then load/update current stored columns entirely on the server. This is still weaker than a direct categories-only DB patch unless the update is atomic.

Short-term UI mitigation:

- Cross-disable field and category save buttons whenever either request is active.
- Re-fetch current FieldSpec immediately before any operation that could replace columns.

UI disabling alone is not sufficient because separate tabs/devices remain possible.

### Regression tests required

1. Category-only request does not include or modify columns.
2. Concurrent field update and category update preserve both results.
3. Stale `expected_updated_at` returns 409.
4. Category-only update leaves key, label, type, required, and order byte-equivalent.
5. Admin-only role enforcement.

---

## Finding 5 — Medium: admin cannot export a statement for a branch with no expenses

**Severity:** Medium  
**Category:** Correctness, unavailable financial artifact  
**Primary files:**

- `public/js/components/payments.js:249-275`
- `public/js/components/payments.js:423-432`
- `public/js/components/payments.js:442-457`

### What is wrong

The Payments view fetches `/api/branches` for branch names, but the actual branch selector values are derived exclusively from expense rows:

```js
var branches = {};

state.rows.forEach(function (r) {
  branches[
    r.branch_id == null || r.branch_id === ''
      ? 'unassigned'
      : String(r.branch_id)
  ] = true;
});

fill(
  branchSel,
  'All branches',
  Object.keys(branches).sort(),
  state.branchNames
);
```

`/api/branches` populates only the ID→name map:

```js
((r && r.branches) || []).forEach(function (b) {
  names[b.id] = b.office;
});
```

Therefore, a branch with no row in the current `/api/expenses` result never becomes selectable.

### Concrete failing scenario

1. Admin creates branch `bNew`.
2. Admin configures its petty-cash float and/or cash-in.
3. The branch has not submitted its first expense.
4. Admin opens Payments and chooses a month.
5. `bNew` is absent from the branch selector.
6. `statementReady()` rejects “All branches,” so the admin cannot export `bNew`'s valid opening statement.

The server route can generate the statement if called directly with `branch=bNew`; the UI makes the supported operation unreachable.

The 2,000-row expense cap creates a second variant: a valid branch could disappear from the selector if none of its expenses are in the loaded slice.

### Required fix

Maintain a real branch list:

```js
state.branches = [];
```

Populate the admin selector from `/api/branches`, with expense-derived fallback only if the branch route fails.

For clerks:

- hide/disable the branch selector, or show only their own branch;
- continue omitting `branch` from the statement URL so the server remains authoritative.

### Regression tests required

1. Admin branch selector includes a branch with zero expenses.
2. Admin can export a float/cash-in-only statement.
3. Clerk still cannot choose or forge another branch.
4. Selector is not affected by the expense row cap.

---

## Finding 6 — Medium: clicking an obsolete category can silently clear it

**Severity:** Medium  
**Category:** Financial classification integrity, UI state bug  
**Primary files:**

- `public/js/components/grid.js:251-288`
- `public/js/components/grid.js:279-285`
- `lib/expenseValidation.js:20-47`

### What is wrong

Category editing builds a `<select>` from the account's current categories:

```js
categories.forEach(function (c) {
  var o = document.createElement('option');
  o.value = c;
  o.textContent = c;
  input.appendChild(o);
});

input.value = String(row.category || '');
```

If the row contains a legacy category that has since been removed from the chart of accounts, no option matches. A standard select then has no matching selected value, effectively producing `''`.

Blur automatically commits:

```js
input.addEventListener('blur', commit);
```

The server accepts an empty string as valid text for `category`:

```js
body[k] = v.slice(0, MAX_TEXT_LEN);
```

### Concrete failing scenario

Stored row:

```json
{
  "category": "Old Travel"
}
```

Current category list:

```json
["Petrol/Diesel", "Accommodation", "Others"]
```

User actions:

1. Enable Edit cells.
2. Click the “Old Travel” category cell.
3. Click elsewhere without deliberately choosing a category.

Result:

```json
{
  "category": ""
}
```

The financial classification is erased merely by focus/blur.

### Required fix

When the current row category is absent:

- prepend a disabled or marked legacy option carrying the current value, or
- add it as a normal current-value option plus the allowed replacements.

For example:

```text
Old Travel (current — no longer in category list)
Petrol/Diesel
Accommodation
Others
```

Also consider:

- requiring an explicit `change` before blur can commit a select;
- server-side rejection of empty category when category is intentionally being updated.

### Regression tests required

1. Legacy category is preserved on click→blur.
2. Selecting a valid replacement saves it.
3. Current valid category remains selected.
4. Empty category cannot be accidentally submitted.

---

## Finding 7 — Low: imported account categories are publicly readable

**Severity:** Low  
**Category:** Unauthenticated business-metadata disclosure  
**Primary files:**

- `routes/expenses.js:217-249`

### What is wrong

`GET /api/config` is intentionally unauthenticated because the frontend needs bootstrap information before deciding whether to show token auth or business login.

PR #154 changes it from returning only generic categories to loading and returning the client's effective imported chart of accounts:

```js
const spec = await getFieldSpec();
categories = spec.categories;
```

No `checkDash` middleware protects this route:

```js
app.get('/api/config', async (req, res) => { ... });
```

Anyone who can reach the deployment can retrieve:

- the client's custom category names/chart of accounts;
- whether multi-user is enabled;
- whether Excel-lite and branch submission are enabled;
- the Telegram bot username.

The flags and bot handle may be intentionally public bootstrap data. The custom chart of accounts is client-specific business metadata and is not necessary before login.

### Concrete failing request

```http
GET /api/config
```

No bearer token is required. The response can include:

```json
{
  "categories": [
    "Petrol/Diesel",
    "Touch-n-Go",
    "Hardware & Loose Tools"
  ]
}
```

### Required fix

Split configuration into:

1. Public bootstrap config:
   - `multi_user`
   - minimal auth-mode information
   - non-sensitive branding required before login

2. Authenticated account config:
   - categories
   - feature controls not needed by login
   - operational/client-specific values

Alternatively, omit `categories` when there is no valid bearer and fetch them after authentication.

### Regression tests required

1. Unauthenticated bootstrap response does not contain custom categories.
2. Authenticated admin/clerk receives effective categories.
3. Personal-mode boot remains functional.

---

## Finding 8 — Low: Manage lazy-load failures cannot retry

**Severity:** Low  
**Category:** State machine, transient failure recovery  
**Primary files:**

- `public/js/components/manage.js:80-114`
- `public/js/components/grid.js:368-373`
- `public/js/components/templates.js:619-631`
- `public/js/components/templates.js:978-987`

### What is wrong

Manage sets a sub-page as loaded before calling its loader:

```js
if (!loaded[id]) {
  loaded[id] = true;
  var inst = instances[id];
  if (inst && typeof inst.load === 'function') inst.load();
}
```

It neither waits for nor observes the returned promise.

Grid catches its own failure:

```js
return Api.apiFetch('/api/expenses')
  .then(...)
  .catch(function () {
    note('Could not load expenses...');
  });
```

That catch resolves the promise, and Manage has already permanently marked the page loaded. Switching away and back never retries.

Templates has a related problem: `loadCurrent()` catches and resolves with `undefined`. The outer `load()` therefore enters its `.then()` branch, marks `state.loaded=true`, seeds an empty builder, and does not retry on revisit.

### Concrete failing scenario

1. User opens Manage.
2. `/api/templates` or `/api/expenses` receives a transient 502/network failure.
3. An error message appears.
4. Network recovers.
5. User switches sub-pages and comes back.
6. No new request is issued.
7. Only full-page reload recovers.

### Required fix

Use separate states:

```text
idle -> loading -> loaded
               -> failed -> retryable
```

Only mark loaded after successful resolution:

```js
if (loading[id] || loaded[id]) return;
loading[id] = true;

Promise.resolve(inst.load())
  .then(function () {
    loaded[id] = true;
  })
  .catch(function () {
    loaded[id] = false;
  })
  .then(function () {
    loading[id] = false;
  });
```

Component loaders must reject on failure or return a structured success/failure result instead of swallowing errors.

### Regression tests required

1. First load rejects.
2. Revisit invokes load again.
3. Successful load marks the page loaded.
4. Later revisits do not duplicate successful loads.
5. Repeated rapid selection while loading issues only one request.

---

## 4. Possible issue requiring verification

## Possible Finding A — CSV formula guard misses whitespace/control-prefixed payloads

**Severity:** Potential Medium security issue  
**Category:** Spreadsheet formula injection  
**Primary files:**

- `public/js/components/grid.js:90-100`
- `public/js/components/grid.js:102-116`
- `tests/frontend/grid.test.js:98-139`

### Current behavior

The guard only checks the first raw character:

```js
var safe = /^[=+\-@]/.test(raw) ? "'" + raw : raw;
```

Directly demonstrated:

```text
"=1+1"   -> "'=1+1"
"\t=1+1" -> "\t=1+1"
"  =1+1" -> "  =1+1"
"\r=1+1" -> "\"\r=1+1\""
```

The tab/space-prefixed values do not receive the protective apostrophe.

Spreadsheet clients differ in whether leading whitespace/control characters are stripped or treated as formula triggers. This should be verified against the exact Excel/LibreOffice versions used by the client.

### Suggested hardening

Normalize for detection without altering the exported display value:

```js
var dangerous = /^[\u0000-\u0020]*[=+\-@]/.test(raw);
var safe = dangerous ? "'" + raw : raw;
```

Depending on client testing, also consider guarding Unicode whitespace and other spreadsheet-specific trigger forms.

The final CSV still needs ordinary RFC-4180 quoting after formula neutralization.

### Required verification/tests

Open generated CSVs in the target spreadsheet clients with:

- `=1+1`
- `+1+1`
- `-1+1`
- `@SUM(1,1)`
- `\t=1+1`
- `\r=1+1`
- `  =1+1`
- leading non-breaking space + `=`
- comma/quote/newline combinations around the payload

Assert every cell is displayed as inert text and never evaluated.

---

## 5. Areas checked and found solid

## 5.1 Direct expense route isolation

No cross-branch leak was found in the ordinary expense routes after tracing:

```text
checkDash
  -> lookupSession
  -> scopeForUser
  -> req.scope
  -> sbSelect/sbUpdate/sbSoftDelete
```

Specifically:

- `GET /api/expenses` passes `scope:req.scope`.
- A clerk receives both DB-level branch filtering and in-memory `clerkVisible()` filtering.
- `PATCH /api/expenses/:id` checks branch ownership and then performs a scoped update.
- `DELETE /api/expenses/:id` checks branch ownership and then performs a scoped soft delete.
- Caller-controlled `account_id`, `company_id`, or `branch_id` cannot override the trusted scope in `stampScope()`.

The concurrency issue in Finding 2 remains, but it is separate from branch isolation.

## 5.2 `lib/supabase.js` scope composition

The following properties are correct:

- `scopeEq()` always includes the trusted `account_id`.
- Clerk `branch_id` is a hard equality predicate.
- `scopeOr()`'s null-tolerant company condition remains branch-bounded for current clerk roles.
- In `sbSelect`, trusted scope fields are spread after caller `eq`, so caller values cannot override them.
- In `stampScope`, trusted scope fields are applied after row fields, so a clerk cannot smuggle another branch/account on insert.
- Admin scope intentionally has no branch filter.

The documented future risk remains valid: a company-only role with no branch must not ship while null-tolerant company rows exist.

## 5.3 Statement export branch forcing

The server-side statement route correctly ignores a clerk-supplied branch:

```js
if (s.role === 'clerk') {
  branchId = s.branch_id;
}
```

The float, cash-in, and expense queries also receive `scope:s`, providing defense in depth.

No direct clerk path was found to export another branch through `GET /api/statement`.

The frontend helpers are also correct for the intended contract:

- Clerk requires only a month.
- Admin requires month plus a real branch.
- Clerk URL omits `branch`.
- Admin URL includes the selected branch.

The empty-branch selector bug in Finding 5 is a UI reachability problem, not a server isolation failure.

## 5.4 XSS/CSP handling in reviewed frontend

No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` assignment was found in the reviewed public code.

Untrusted values such as:

- merchant names;
- categories;
- template labels;
- company/branch/staff names;
- statement/submission labels;
- server error text;

are rendered using `textContent` or `Escape.setText`.

The Telegram deep link is constructed under a fixed `https://t.me/` origin, uses `encodeURIComponent` for the binding token, and uses `noopener noreferrer`.

## 5.5 Static FieldSpec column round-trip

For columns produced by the existing CSV/Excel parsers:

- `columnsToCsvHeader()` preserves order;
- labels containing commas/quotes are CSV-escaped;
- reparsing recreates the canonical key/type/required values;
- category omission semantics in `saveTemplate()` correctly leave stored categories untouched for column-only imports.

The category-save defect is not ordinary CSV mangling; it is stale-state replacement/concurrency.

## 5.6 Session/token lifecycle

The following were verified:

- Tokens use 32 random bytes encoded as base64url.
- Only SHA-256 token hashes are stored.
- Session lookup is account-scoped.
- Expiration is enforced on lookup.
- Passwords use Node core `scrypt`.
- Unknown-user login performs a dummy hash verification.
- Logout revokes all sessions for the authenticated user.
- Branch deletion deactivates branch users and revokes their sessions.
- Staff identities cannot receive a login scope.

Potential cleanup of expired session rows is operational hygiene, not an authentication bypass.

## 5.7 Payments statement gating

`statementReady()` and `statementUrl()` implement the intended clerk/admin distinction correctly. No branch-forcing bug was found in those helpers or the server route.

---

## 6. Test-gap analysis

## 6.1 Agent tests lack all business-scope cases

Existing Agent route tests cover:

- input validation;
- static-token authentication;
- proposal shape;
- auto-mode coercion;
- generic error handling.

They do not create a business session or assert `req.scope` is injected into Agent dependencies.

This gap allowed an entire branch-isolation bypass to remain green.

### Add

- `tests/agent.route.scope.test.js`
- two branches, two expenses, clerk/admin sessions;
- read and every write kind;
- proposal ownership.

## 6.2 Grid tests test payload construction, not atomic concurrency

`tests/frontend/grid.test.js` proves that `expected_updated_at` is included in a client object. It does not prove that the server uses it atomically.

### Add

- route-level stale timestamp test;
- deterministic concurrent requests;
- no-timestamp policy test;
- empty update result handling.

## 6.3 Template tests prove string conversion, not preservation

The current `columnsToCsvHeader` tests prove:

- labels become a CSV header;
- key fallback works;
- empty input produces an empty sentinel.

They do not perform:

```text
stored FieldSpec
  -> category-only HTTP save
  -> persisted DB row
  -> getFieldSpec
```

They also do not test concurrent saves or role authorization.

### Add

- categories-only integration round-trip;
- concurrent field/category requests;
- admin vs clerk;
- exact deep equality of columns before/after category update.

## 6.4 Manage tests cover only pure page selection

`tests/frontend/manage.test.js` covers only `subPagesFor()`. It does not mount the shell or exercise:

- initial load;
- duplicate load prevention;
- rejected load;
- retry after rejection;
- missing component;
- rapid page switching.

### Add

A minimal fake DOM test or browser-level component test with stub components whose `load()` calls are counted and can resolve/reject under test control.

## 6.5 Payments tests do not test selector sources

The statement helper tests prove URL/gating behavior but do not mount Payments with:

- a branch returned by `/api/branches`;
- zero expenses for that branch;
- a float/cash-in-only month.

### Add

A mounted view test asserting the branch remains selectable and its export URL is correct.

## 6.6 CSV guard tests omit leading whitespace/control cases

Current tests cover only formulas whose first character is exactly:

```text
=-@
```

### Add

- tab prefix;
- CR/LF prefix;
- ordinary spaces;
- non-breaking spaces;
- payloads that also require CSV quoting;
- real spreadsheet smoke verification.

---

## 7. Recommended fix order

1. **Agent branch scope and proposal ownership**
   - Highest severity.
   - Cross-branch finance-data breach.
   - Must be Tier-2 independently reviewed.

2. **Atomic expense PATCH concurrency**
   - Prevent silent lost updates.
   - Add deterministic concurrent regression test.

3. **Admin-only template/category writes**
   - Enforce ADR-021 server-side.
   - Adjust Manage sub-pages by role.

4. **True categories-only server update**
   - Remove cached-column resend.
   - Add CAS and concurrent-save test.

5. **Statement selector from branch master data**

6. **Legacy category preservation**

7. **Authenticated account config split**

8. **Retryable Manage loading**

9. **Spreadsheet-client formula-injection verification**

Each concern should remain a focused commit. The first four touch Tier-2 surfaces and require independent review before merge.

---

## 8. Design disagreements

## 8.1 Disagreement: “categories-only save never changes columns”

That claim is not supported by the implementation. Reconstructing columns client-side and resending them is still a column replacement. It happens to preserve the last locally observed shape in a single non-concurrent flow, but it cannot guarantee preservation under concurrent or interleaved saves.

The correct design is semantic partial update:

```text
change categories -> update categories only
```

not:

```text
change categories -> serialize and replace columns + categories
```

## 8.2 Disagreement: business mode can expose the same Manage configuration to both roles

ADR-021 says the data shape is HQ-owned. A role-aware frontend should reflect that policy, while the server must enforce it. “Views render role-aware internally” is insufficient when the Template component itself has no clerk restriction and its route accepts clerk writes.

## 8.3 Disagreement: the Agent can reuse unscoped helpers because `sbSelect` is account-scoped

Account scoping is not enough in M2. The core security invariant is branch isolation for clerks. Any feature that reads or writes expenses—including AI tools—must consume the same `scopeForUser` contract as ordinary routes.

## 8.4 Disagreement: read-before-write is optimistic concurrency

A separate SELECT comparison followed by an unconditional PATCH is advisory freshness checking, not atomic optimistic concurrency. Correct optimistic concurrency requires the expected version/timestamp in the mutation predicate.

---

## 9. Acceptance criteria before approval

PR #154, or its follow-up fix PRs, should satisfy all of the following before approval:

- [ ] Clerk Agent reads contain only the clerk's branch.
- [ ] Clerk Agent cannot edit/delete/review another branch.
- [ ] Proposals are bound to their creating user/scope.
- [ ] Template Agent actions are admin-only.
- [ ] Expense CAS is atomic; a deterministic race produces one 200 and one 409.
- [ ] Missing/empty update result never becomes fake success.
- [ ] Clerk cannot POST account-wide template/category changes.
- [ ] Categories-only save cannot modify columns.
- [ ] Concurrent field/category saves preserve both changes.
- [ ] Admin statement selector includes empty branches.
- [ ] Obsolete category click/blur preserves the stored category.
- [ ] Custom categories are not exposed anonymously.
- [ ] Failed Manage loads can retry without a full reload.
- [ ] Formula-prefix behavior is verified in the target spreadsheet client.
- [ ] Full hermetic suite remains green.
- [ ] Tier-2 fixes receive an independent approving review.

---

## 10. Final assessment

PR #154 contains useful, well-presented frontend work, and several reviewed areas are genuinely solid. In particular, direct expense/statement branch scoping, DOM text rendering, session primitives, and the basic statement clerk/admin URL contract are sound.

The branch nevertheless cannot be considered safe for a real multi-branch finance client in its current state. The Agent scope omission alone violates the system's primary isolation invariant and is sufficient to block merge. The non-atomic grid concurrency guard and the two template/category authorization/data-loss issues independently justify changes before release.

The strongest path forward is not a broad rewrite. These are contained fixes:

- request-scoped Agent database adapters plus proposal ownership;
- atomic timestamp predicate on expense PATCH;
- explicit admin authorization on global configuration;
- a true partial category update;
- a handful of targeted UI/state corrections.

Once those are implemented with the regression tests listed above, the branch should be reviewed again specifically against the cross-branch and concurrent-write threat models.
