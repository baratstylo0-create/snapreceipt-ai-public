# Context pack — live contracts, test patterns, gotchas (verified against `main` @ 62c476d)

> Everything here was read from the actual code on 2026-07-07. Trust it, but if `main` moved,
> re-verify the signatures you use (Gate 2: open the file, don't design from memory).

## Ownership — files you must NOT touch (Barat's lane, issue #107)

`lib/supabase.js` · `lib/groq.js` · `lib/ocr.js` · `lib/templates.js` (read/import it freely) ·
`lib/confidence.js` · `routes/webhook.js` · `routes/templates.js` · `lib/bot.js`.
If a task seems to need a change there, put the need in the PR body for Barat instead.
Shared files you MAY touch with a WORKLOG announcement: `server.js` (mount lines), `schema.sql`
(append-only migration blocks — this epic's task split gives Jeevan the M2 schema).

## Key contracts (exact, current)

```js
// lib/supabase.js — ALL helpers auto-inject account_id (cfg.ACCOUNT_ID). Signatures:
sbSelect(table, { eq = {}, order, limit, extra } = {})     // -> rows[]   eq values go through encodeURIComponent
sbInsert(table, row)                                        // -> void (return=minimal)
sbInsertReturning(table, row)                               // -> row | null
sbUpdate(table, { id }, patch)                              // -> rows[] (filters by id + account_id)
sbSoftDelete(table, { id })                                 // -> void (sets deleted_at)
sbRpc(fnName, args = {})                                    // no account_id auto-inject

// lib/auth.js
scopeForUser(user) // admin -> {account_id, role:'admin'}; clerk -> {account_id, branch_id, role:'clerk'}
                   // Phase 8 widens clerk with company_id? — see 01-phase8 Task 8.3
hashPassword(pw) / verifyPassword(pw, stored) / mintSession(user) / lookupSession(token) / revokeSessionsForUser(id)

// routes/expenses.js exports
checkDash            // auth gate middleware. Business mode (multiUser ON): resolves the bearer session,
                     // sets req.user = {user_id, account_id, role, branch_id} and req.scope = scopeForUser(req.user).
                     // Personal mode: static-token compare, no req.scope. 401 on failure.
dashOrigin()         // CORS origin helper
sanitizeExpensePatch // re-exported from lib/expenseValidation — the PATCH allow-list

// lib/account.js getCapabilities() — current flags:
// account_type, businessProfile, claimsTax, bankReconciliation, multiUser,
// liveMasterMerge (def true), excelLiteGrid (def true), branchSubmission (def false), businessType
// Phase 8 adds companyDimension (def false); Phase 9 adds pettyCash (def false).

// lib/excel.js — buildWorkbook(expenses, fieldSpec, opts = {}) -> ExcelJS.Workbook
// opts: rangeLabel, generatedAt, branchStaff, branchNames, staffNames, receipts, receiptLinks, embedReceipts
// 'Expenses' sheet MUST stay worksheets[0]. round2() + MONEY_FMT ('#,##0.00') live here — copy the idiom.

// lib/templates.js (Barat's, import only): getFieldSpec() -> { account_id, columns:[{key,label,type,...}], updated_at }
//   NOTE: NO `categories` key today. Per-company category list = fieldSpec.categories IF a future
//   version adds it, else lib/categorize.js CATEGORIES — exactly the fallback lib/categorize.js
//   already implements (see its line ~62). Phase 10 should use that same fallback chain.
// lib/categorize.js: CATEGORIES (the real 18-category list)
// lib/storage.js: fetchReceiptObject(path) -> Buffer|null  (call pattern in routes/excel.js:93)
// lib/pdf.js: exports { rasterizePdf, rgbaToPng, PdfError } + honours the PDF_MAX_RENDER_PIXELS
//   bomb-guard — REUSE these for Phase 10's receipt rasterisation, don't re-wrap pdfium
// lib/ratelimit.js: createRateLimiter({ max }) -> Express middleware (per-IP fixed window)
```

## Route-file house pattern (copy `routes/submissions.js` — the newest, cleanest example)

Gate middleware (404 when flags off) → per-route limiter → `checkDash` → `express.json({limit:'16kb'})`
→ handler that role-guards via `req.scope`, validates inputs, try/catches to a generic 502 with a
`console.error('[tag]', e.message)` (message only — never bodies/PII).

## The test harness (verbatim-reusable — from `tests/submissions.route.test.js`)

```js
function stubDb({ session, handlers = {} } = {}) {
  const realFetch = global.fetch;
  const calls = [];
  let idN = 0;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('/rest/v1/')) return realFetch(url, opt);      // the test's own HTTP probe
    const method = opt.method || 'GET';
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ url: u, method, body });
    const table = (u.match(/\/rest\/v1\/(\w+)/) || [])[1];
    if (table === 'sessions' && method === 'GET') return { text: async () => JSON.stringify(session ? [session] : []) };
    const key = table + ':' + method;
    if (handlers[key]) return { text: async () => JSON.stringify(handlers[key]({ url: u, body })) };
    if (method === 'POST') return { text: async () => JSON.stringify([{ id: table + '-' + (++idN), ...body }]) };
    if (method === 'GET') return { text: async () => JSON.stringify([]) };
    return { text: async () => JSON.stringify([{ id: 'patched', ...body }]) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls };
}
const future = () => new Date(Date.now() + 3600e3).toISOString();
const ADMIN   = { user_id: 'ua', account_id: 'default', role: 'admin', branch_id: null, expires_at: future() };
const CLERK_A = { user_id: 'uc', account_id: 'default', role: 'clerk', branch_id: 'bA', expires_at: future() };
// withEnv({...}, fn) pattern: save/override/restore process.env keys around each test.
// Flags: CAP_MULTI_USER, CAP_BRANCH_SUBMISSION, (yours: CAP_COMPANY_DIMENSION, CAP_PETTY_CASH).
```

Run tests: `mv .env .env.local.bak; node --test [files]; mv .env.local.bak .env` — ALWAYS.
Full suite ≈ 10s, **1303/1303 on this baseline**. CI runs the suite on every PR.

## Gotchas (each one has already bitten somebody)

1. **`expense_date` is TEXT** ('YYYY-MM-DD'-ish). Period filtering = string prefix compare
   (`.slice(0,7) === 'YYYY-MM'`), lexical sort is safe for ISO dates. Never cast the column.
2. **Route order matters in Express**: register specific paths (e.g. `/api/expenses/payments`)
   BEFORE parameterised ones (`/api/expenses/:id`) — Phase 4 hit this.
3. **The stub harness's session row** is what `checkDash` resolves — a test "logs in" by seeding
   `session:` and sending any `Authorization: Bearer x`. No session ⇒ 401 path.
4. **`sbUpdate` filters by `{id, account_id}` only** — there is no generic multi-eq update helper.
   Upserts = select-then-insert-or-update (see submissions POST).
5. **exceljs Summary-sheet idioms** (fills as `{type:'pattern',pattern:'solid',fgColor:{argb:'FF...'}}`,
   `numFmt`) are in `lib/excel.js` — copy them, don't invent new helpers.
6. **Personal-mode byte-for-byte** is asserted by the whole existing suite running flag-free. If an
   old test breaks, YOUR change leaked outside the flag — fix the leak, never the old test
   (except the deliberate scope-shape update in Phase 8 Task 8.3).
7. **No PII/images/amounts in logs** (ADR-002). `console.error('[tag]', e.message)` only.
8. **Windows repo**: CRLF warnings on commit are normal; ignore. Don't commit `.env`,
   `.env.local.bak`, `.claude/worktrees/`, or `node_modules`.
9. **Commit style**: Conventional Commits + the repo's Co-Authored-By trailer convention.
10. **Money rounding**: always `Math.round((v + Number.EPSILON) * 100) / 100` (the `round2` idiom).

## Ops ledger (surface in every PR; the Owner executes these)

- Migrations pending in Supabase SQL editor: **M2-P4, M2-P7** (pre-existing) + yours (M2-P8, M2-P9).
- Pre-live gates (not yours to do, keep visible): Groq ZDR toggle, hosting/HTTPS, `npm run
  setup-admin` on the client instance, secret custody (ADR-015).
