# Design — Voucher / human-readable reference number per expense

> **Decision:** ADR-017 (proposed). **Status:** pending **Barat** sign-off (touches his frozen `schema.sql` + the insert path in `lib/ocr.js`/`lib/supabase.js`).
> **Owners:** `schema.sql` (column + counter + function + trigger) = **Barat**. Downstream display = **Jeevan** (`lib/excel.js` #2, `routes/expenses.js`) + **Mugi** (`public/`) + **Barat** (Telegram "saved" reply in `lib/bot.js`).
> **Tier:** Tier-2 (schema change on financial data; new DB function/trigger). Additive, backward-compatible.
> **Requested by:** Owner (Jeevan) — live use. A short, human-quotable ID for each expense, separate from the opaque DB UUID.

## Goal
Give every expense a short, human-readable reference like **`V-2026-0041`** that a person can say out loud, write on a paper receipt, or quote in a message — distinct from the row's `id` (UUID). It is a **system-generated internal reference**, NOT a value read off the receipt.

**Explicitly distinct from `invoice_number`:** `invoice_number`/`ai_raw.invoice_number` is the *merchant's* number printed on the receipt (extracted by OCR, may be missing/duplicated/garbage). `voucher_no` is *ours*, guaranteed present, unique, and ordered. Do not conflate them, and do NOT add `voucher_no` to the OCR prompt/FieldSpec — the model never sees or produces it.

## Format
`V-<YYYY>-<NNNN>` — literal `V`, 4-digit year, zero-padded sequence (min width 4, grows to 5+ digits past 9999/yr).
- Sequence **resets per calendar year** (`V-2026-0041`, then `V-2027-0001`).
- Scoped **per `account_id`** (multi-tenant-forward). Two accounts can both have `V-2026-0001`.
- Uniqueness enforced as `UNIQUE(account_id, voucher_no)`.

## The hard part: concurrency — generate in the DB, NOT in app code
**Rejected: app-side `count(*)+1`** (in `assembleExpense`/`sbInsert`). It races: two concurrent inserts read the same count and produce the same `voucher_no`. This is now a *live* hazard — post-PR #65 every **batch** path (Telegram album, PDF, dashboard mass-upload) inserts, so N rows from one album hit the insert path near-simultaneously. A read-then-write counter in JS across separate REST calls has no atomicity. **Do not do this.**

**Recommended: DB-side assignment via a `BEFORE INSERT` trigger + a per-(account,year) counter row.** Atomic inside Postgres, and — critically — **path-agnostic**: single-photo, batch, dashboard, and any future insert all get a correct number without each caller re-implementing it.

```sql
-- 1) New column on expenses (nullable; the trigger fills it).
ALTER TABLE expenses ADD COLUMN voucher_no text;
ALTER TABLE expenses ADD CONSTRAINT expenses_voucher_uq UNIQUE (account_id, voucher_no);

-- 2) Per-(account, year) counter. One row per account per year; the last issued seq.
CREATE TABLE voucher_counters (
  account_id text NOT NULL,
  year       int  NOT NULL,
  last_seq   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, year)
);

-- 3) Atomic "give me the next seq for this account+year" via upsert-increment.
CREATE OR REPLACE FUNCTION next_voucher_seq(p_account text, p_year int)
RETURNS int LANGUAGE sql AS $$
  INSERT INTO voucher_counters (account_id, year, last_seq)
  VALUES (p_account, p_year, 1)
  ON CONFLICT (account_id, year)
  DO UPDATE SET last_seq = voucher_counters.last_seq + 1
  RETURNING last_seq;
$$;

-- 4) Trigger: assign voucher_no on insert if not already set. Uses the row's own
--    expense year when present, else the insert date, so back-dated receipts still
--    file under a sensible year. (Decision A below can change this to always-now.)
CREATE OR REPLACE FUNCTION assign_voucher_no() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE y int; s int;
BEGIN
  IF NEW.voucher_no IS NULL THEN
    y := EXTRACT(YEAR FROM COALESCE(NEW.expense_date, CURRENT_DATE))::int;
    s := next_voucher_seq(NEW.account_id, y);
    NEW.voucher_no := 'V-' || y::text || '-' || lpad(s::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_assign_voucher_no BEFORE INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION assign_voucher_no();
```

The `ON CONFLICT ... DO UPDATE ... RETURNING` is atomic at the row level, so concurrent inserts serialize on the counter row and each gets a distinct seq. `voucher_no` is assigned **once** and is immutable thereafter (trigger only fires on INSERT and only when null).

## Immutability & deletes
- A number is **permanent** once assigned — never rewritten on edit, never recycled on (soft-)delete. A soft-deleted row keeps its `voucher_no`; the number is not reissued. Deletes therefore leave gaps — acceptable (an audit trail should have gaps, not reuse).
- Because generation is DB-side, editing a row via `PATCH /api/expenses/:id` cannot change `voucher_no` (the trigger is INSERT-only) — good.

## App-side changes (thin, additive)
- **`lib/ocr.js` / `lib/supabase.js` (Barat):** nothing *generates* the number (DB does), but the insert should `Prefer: return=representation` (or a follow-up select) so the assigned `voucher_no` is read back for the confirmation reply. `sbInsert` currently uses `return=minimal` — a `return=representation` variant (or a small `sbInsertReturning`) is needed to echo `voucher_no`.
- **`lib/bot.js` (Barat):** include `voucher_no` in the Telegram "✅ Captured" reply and the batch per-receipt breakdown.
- **`routes/expenses.js` (Jeevan):** already returns `select=*`; just confirm `voucher_no` is not filtered out.
- **`lib/excel.js` (Jeevan, #2):** add a `Voucher No` column (first column) to the export.
- **`public/` (Mugi):** show `voucher_no` in the table + card/drawer.

## Backfill of existing rows — DECISION NEEDED (see Decision B)
Existing rows predate the column and will have `voucher_no = NULL`. Options in Decision B.

## Decisions needed before Barat builds
- **A. Year basis:** number by the **receipt's `expense_date` year** (recommended — a Dec-2025 receipt entered in Jan 2026 files under 2025) **or** always the **insert year** (simpler, but back-dated receipts look odd). Spec above uses receipt-year with an insert-date fallback.
- **B. Backfill:** (i) leave old rows `NULL` and only number new ones; (ii) backfill all existing rows in `created_at` order per account+year (recommended — every row gets a reference); (iii) backfill only live (non-deleted) rows. Backfill is a one-time SQL script, not part of the trigger.
- **C. Gapless vs unique-ordered:** this design is **unique + ordered, gaps allowed** (rollbacks/deletes leave gaps). If a jurisdiction later needs a strict **gapless** voucher sequence for compliance, that's a heavier change (reserve numbers only on commit, reconciliation job) — out of scope for v1. Confirm gaps are acceptable.
- **D. Prefix:** `V-` assumed. Confirm, or make it a per-account setting later (YAGNI for v1).

## Non-goals (YAGNI)
- No per-account configurable format/prefix in v1 (single `V-YYYY-NNNN`).
- No strict gapless/legal-sequence guarantee (Decision C).
- No renumbering tools, no voucher-based public lookup URL.
- No change to `id` (UUID stays the primary key and the API/receipt path key).

## Security
- `voucher_no` is non-sensitive (no PII, no secret) — safe to show in the dashboard, Excel, and Telegram.
- The counter table and functions are server-side; the browser only ever sees the finished `voucher_no` on a row it's already authorized to read. RLS on `voucher_counters`: service-role only (same posture as everything else; anon denied).
- `SECURITY` of the trigger function: keep it `SECURITY INVOKER` (default) — it runs under the service role that already owns the insert; no elevation needed.

## Test plan (once Barat builds)
- Concurrency: fire N inserts for the same account+year in parallel → N distinct, contiguous `voucher_no`s, no dupes (the key test — proves the race is closed).
- Format: `V-2026-0001` shape; per-year reset (insert across a year boundary); >9999 grows width.
- Immutability: `PATCH` a row → `voucher_no` unchanged; soft-delete then insert another → number not recycled.
- Multi-account: two accounts each start at `0001` independently.
- Back-compat: an insert that already carries a `voucher_no` (e.g. backfill script) is left untouched by the trigger.
