# Spec — Per-line-item categorization (surface + persist)  ·  ✅ IMPLEMENTED (PR #79)

> **Status (2026-07-04):** shipped in **PR #79** (`feat/jeevan-line-item-categorization`) — OCR line-item
> extraction + per-item persist into `expenses.line_items` + dashboard per-item pill. Decisions locked to
> this spec's recommended defaults (A always-extract · B full item shape · C reuse #74's `awaiting_category`
> for flagged lines · D fx-scale · E cap 100). Kept as the design record; the "open decisions / what's next"
> below reflect the pre-build draft and are retained for history.

> **Owner-requested (2026-07-04).** The categorizer already computes a category for **each line item**,
> but the product only ever keeps ONE rolled-up category per receipt. This spec makes the per-line
> categories real: extracted, stored, and shown — so a single receipt with mixed items (groceries +
> a coffee + a phone charger) is categorized line-by-line, not collapsed to one dominant bucket.
>
> **This is a spec for sign-off, not an implementation.** It spans two lanes (Barat: `lib/ocr.js` OCR
> prompt + `assembleExpense` persistence; Jeevan: `lib/categorize.js` already done; Mugi: dashboard
> display). Merging it means "design agreed"; each lane builds its own part.

## 1. Why it matters
A real receipt is rarely one category. A single grocery-store run can include food, household goods, and
a SIM top-up; a hardware-store receipt mixes tools, consumables, and a snack. Rolling the whole receipt
into one "dominant" category:
- **loses accounting accuracy** — the whole basket lands in one bucket, so category totals/reports are wrong for mixed receipts;
- **wastes work we already do** — `categorizeLineItems()` already returns a per-item breakdown, and we throw it away;
- **blocks credible reporting** — "spend by category" is only as honest as its most granular unit, and right now that unit is the whole receipt.

## 2. Current state (verified 2026-07-04, `main`)
The plumbing is *almost* all there — three gaps, no more:
1. **`lib/categorize.js` — DONE.** `categorizeLineItems(receipt, fieldSpec)` returns
   `{ items: [{ description, amount, category, source, confidence, flagged }], category: <rollup>, merchant }`.
   The per-item array (`items`) is fully computed (rules + memory + LLM watchdog).
2. **`expenses.line_items jsonb default '[]'` column — EXISTS** (`schema.sql:26`). **No schema change needed.**
3. **GAP A — OCR doesn't extract line items.** Extraction is FieldSpec-driven (`buildInstruction` asks only
   for the customer's declared columns). Line items aren't a default column, so `fields.line_items` is
   `undefined` → the categorizer falls back to whole-receipt mode (`categorize.js:168`).
4. **GAP B — line items are never persisted.** In `assembleExpense` (`lib/ocr.js`), the built `expense`
   object has no `line_items` key, so the column stays `[]`. The categorizer's `.items` result is discarded;
   only `.category` (the rollup) is written to `expenses.category`.
5. **GAP C — no per-item display.** The dashboard edit drawer already renders `line_items` descriptions
   (`activity.js` `act-lineitems`) but shows no per-item category (there's nothing to show today).

## 3. Design
Keep the receipt-level `expenses.category` EXACTLY as-is (backward compatible — reports, filters, the
pill colours, the agent all keep working). Add the granularity **inside the existing `line_items` jsonb**.

### 3.1 Extract line items (GAP A — Barat, `lib/ocr.js`)
Add a line-items block to the extraction prompt, requested **outside** the FieldSpec column loop (same
pattern as the existing `QUALITY_KEY` / `looks_like_receipt`, so a customer's own columns are untouched):
```
"line_items": [ { "description": "<item name>", "amount": <number> }, ... ]   // [] if none legible
```
- Untrusted output rules unchanged (SOP §7.3): coerce each item — `description` → `String(...).slice(0,cap)`,
  `amount` → finite `Number` or drop. Cap the array length (e.g. 100) to bound cost/DoS.
- Fail-safe: a missing/garbage `line_items` → `[]`, i.e. today's exact behaviour (whole-receipt fallback).

### 3.2 Categorize + persist (GAP B — Barat, `lib/ocr.js` `assembleExpense`)
The categorizer is already called; capture its **`.items`**, not just `.category`, and write it back:
```js
const cat = await categorize({ merchant, amount, line_items }, fieldSpec);
if (cat && cat.category) expense.category = cat.category;      // rollup — unchanged
expense.line_items = Array.isArray(cat && cat.items) ? cat.items : (Array.isArray(line_items) ? line_items : []);
```
- `expense.line_items` now carries `[{ description, amount, category, source, confidence, flagged }]`
  into the existing jsonb column. **No schema migration.**
- Currency: line-item `amount`s are the receipt's own currency at extraction time. If #10 FX conversion
  scales the receipt total, either (a) leave line items in the original currency with a note, or (b) scale
  them by the same `fx_rate`. **Open decision D.**

### 3.3 Display (GAP C — Mugi, dashboard)
Extend the existing `act-lineitems` block: show each item's `category` (and a subtle flag when
`flagged`/low-confidence). All values through `Escape.setText` — line-item text is hostile OCR output.
No new endpoint: `GET /api/expenses` already returns the whole row incl. `line_items`.

### 3.4 Reporting (follow-on — Jeevan, OPTIONAL, not v1)
Once per-item categories are stored, `lib/reports.js` / `lib/agent.js` / `lib/excel.js` *could* break spend
down by line-item category instead of receipt-level. **Explicitly out of scope for v1** — v1 = extract,
persist, display. Reporting stays receipt-level until a follow-up spec.

## 4. Ownership split (SOP §4.6)
| Part | Lane | File(s) | Status |
|---|---|---|---|
| Per-item categorizer | Jeevan (#6) | `lib/categorize.js` | ✅ already done |
| OCR line-item extraction (GAP A) | **Barat** (#4) | `lib/ocr.js` (`buildInstruction`, coerce) | to build |
| Persist enriched line_items (GAP B) | **Barat** (#4) | `lib/ocr.js` (`assembleExpense`) | to build |
| Dashboard per-item display (GAP C) | **Mugi** (#3) | `public/js/components/activity.js` | to build |
| Reporting by line-item (follow-on) | Jeevan | `lib/reports.js`/`agent.js`/`excel.js` | deferred |

## 5. Open decisions (need sign-off before build)
- **A. Always extract line items, or opt-in?** Extracting adds OCR tokens/latency on every receipt.
  Recommend: **always**, but cap the array; revisit if cost shows up. (Alt: a per-account flag.)
- **B. Store the FULL item objects, or a trimmed shape?** Recommend the full
  `{ description, amount, category, source, confidence, flagged }` (it's what the categorizer already emits;
  `source`/`confidence` power the same review-flagging as receipt-level #11).
- **C. Does a flagged LINE ITEM route the whole receipt to the review queue (#5)?** Recommend: **yes** —
  fold a low-confidence/flagged line into the existing `anomaly.reasons`, same as a low-confidence field,
  so one bad line surfaces for human review rather than silently mis-bucketing.
- **D. Currency of line-item amounts when the receipt is FX-converted (#10).** Recommend: **scale by the
  same `fx_rate`** so line items sum to the (converted) receipt total and reports stay consistent — mirrors
  how subtotal/tax are already scaled in `assembleExpense`.
- **E. Cap on line items per receipt?** Recommend a hard cap (e.g. 100) for cost/DoS; extras dropped with
  the same "truncated" signal the mass-upload path uses.

## 6. Non-goals (v1)
- No schema change (reuse the existing `line_items` jsonb column).
- No change to `expenses.category` (receipt-level rollup stays the primary category everywhere).
- No reporting/Excel/agent breakdown by line-item category yet (§3.4 — separate follow-up).
- No per-line editing UI in v1 (display only; the whole-receipt category stays the editable one).

## 7. Test plan (when built)
- `lib/ocr.js`: line_items extracted + coerced (hostile/garbage/oversized → safe []/cap); `assembleExpense`
  writes `expense.line_items` with per-item categories; missing line_items degrades to `[]` (today's behaviour).
- Backward compat: every existing row / test fake with no line_items still works (category = rollup, display shows nothing extra).
- Currency: converted receipt scales line items by `fx_rate` (decision D).
- Review routing: a flagged line item surfaces in the review queue (decision C).
