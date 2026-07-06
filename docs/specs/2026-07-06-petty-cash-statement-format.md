# Petty Cash Monthly Statement — export format + petty-cash/claim model

> **Source:** two real client sample files (a construction co. + a trading co.) supplied by the Owner
> 2026-07-06 for **Premala** (first client). **Confidential:** the raw files are NOT in the repo; this
> spec is **anonymised** — placeholder names/amounts only, never the real company/staff/bank data.
> **Status:** design agreed (Owner-confirmed, CTO calls noted inline). Feeds ADR-023. Client profile:
> `docs/clients/premala.md`. Part of the M2 epic (ADR-021/022).

---

## 1. What the deliverable is

The client's monthly output is a **Petty Cash Monthly Statement of Account** — one statement **per
company × branch × month** — followed by **the receipt snapshots appended, one per page**. Today they
build it by hand in Excel (with broken `=#REF!` formulas and at least one sign error — see §6) and email
the PDF over WhatsApp. We generate it automatically from the receipts already captured in the system, in
**both Excel and PDF**, matching this layout.

## 2. Statement layout (exact structure, anonymised)

```
[COMPANY NAME]                                              ← company.name
PETTY CASH MONTHLY STATEMENT OF ACCOUNT
[MONTH & YEAR]                        [BRANCH]              ← e.g. "OCTOBER 2025"   "HQ" / "KL"
[PREPARED-BY NAME]                                          ← clerk/staff who compiled it

A.  SUMMARY OF CASH IN
    DATE | DESCRIPTION            | AMOUNT (RM) | [AMOUNT (INR)]   ← 2nd currency col OPTIONAL (dual-currency co.)
    ---- | Balance B/F           | …           | …
    ---- | Cash In <note>        | …           | …               ← the petty-cash FLOAT top-up(s)
         | TOTAL                 | =Σ          |

B.  SUMMARY OF EXPENSES: ([BRANCH])
    ITEM | DATE | [NAME] | DESCRIPTION | T. AMOUNT (RM)          ← NAME (staff) col is per-company optional
    1  <Category>                                                ← numbered categories from the company FieldSpec
       1  dd-mm-yy  [staff]  <merchant / description>   amount
       2  …                                              amount
                                            category SUBTOTAL
    2  <Category>   …                        category SUBTOTAL
    …  (as many categories as the company defines)
                                            SUBTOTAL (all expenses)

    A. TOTAL CASH IN-HAND   = Σ Section A
    B. TOTAL EXPENDITURE    = Σ Section B
    BALANCE                 = A − B                              ← see §6 (sign convention = correct accounting)

    PREPARED BY:        CHECKED BY:        APPROVED BY:
    DATE:               DATE:              DATE:
```

**Observed variation between the two samples (⇒ everything company-configurable, via the FieldSpec/#12):**
- **Categories differ per company.** Construction co. → 9 (Petrol/Diesel, Touch-n-Go, Entertainment,
  Printing & Stationery, Sundry, Travelling, Accommodation, Hardware & Loose Tools, Parking). Trading co.
  → 5 (Tickets [bus/train/grab/flight], Hotel, Food, Others, Hardware(PPE) & Touch-n-Go). ⇒ the numbered
  category set is the **company's chart of accounts** (`companies.category_set` / template).
- **`NAME` (staff) column** present in one sample, absent in the other ⇒ optional column (driven by whether
  the company wants per-staff attribution; we always have `staff_user_id`, we just show/hide the column).
- **Optional sub-grouping** inside a category (e.g. "Petrol/Diesel — <vehicle plate>") ⇒ a sub-header row.
- **Second currency column** (e.g. INR) present for a cross-border company ⇒ optional, from our existing
  currency layer (ADR-005 FX, **never** the LLM).

## 3. Dual export (BOTH required — Owner: "must have both options, as accurate as the sample")

- **Excel (`.xlsx`)** — reproduce the layout with `exceljs` (ADR-012). Real computed subtotals/totals
  (SUBTOTAL/SUM semantics), NOT `#REF!`. Receipt thumbnail embedded per row + hyperlink to full-res
  (reuses the ADR-021/018 embed already planned for Phase 3).
- **PDF** — the statement page(s) **followed by one appended page per receipt image** (the snapshots),
  exactly like their filed output. Foundation = durable receipt-image storage (ADR-018). Rendering
  approach: decide when building — **reuse existing deps first** (`@hyzyla/pdfium` is already in the tree;
  `exceljs`→PDF or an HTML→PDF pass) before adding any new dependency (`sharp` stays rejected, ADR-014).
- Accuracy bar: visually faithful to the client sample; the **Excel template is the layout source of
  truth** (merged cells, column widths, sign-off block).

## 4. The petty-cash + claim model (the real new logic)

- **Each branch gets a petty-cash FLOAT**, an amount the **admin sets/edits per branch per month**
  (including the admin's own Head-Office branch — Owner's explicit call). Float top-ups + a Balance-B/F
  carried from the prior month make up Section A ("cash in-hand").
- **Expenses draw the float down.** `Balance = Cash-in-hand − Expenditure`.
- **Claim = overspend.** When cumulative expenses exceed the float (balance goes **negative**), the
  overspend was paid by staff out of pocket ⇒ it's a **claim** owed back to them. Identified by the
  **running-balance maths** (order the branch's expenses by date; once the running total passes
  cash-in-hand, the excess is claim), with a **per-expense override** (admin/clerk can force an expense
  in/out of "claim", e.g. a pre-approved out-of-pocket buy while the float still had money).
- **Reimbursement uses the existing payment layer** (Phase 4 `payment_status`): a claim is a **pending**
  reimbursement → **paid** once the staff member is reimbursed (bulk mark-paid applies).
- **Sign-off maps to roles:** *Prepared by* = the branch clerk/staff; *Checked/Approved by* = the admin.
  This dovetails with the **"Send to Admin"** submission (ADR-022): clerk prepares → submits → admin
  reviews/approves → statement finalised.

## 5. Data model additions (DDL sketch — finalised in schema task)

```
companies        (id, account_id, name, currency, category_set/template_id, active, created_at)
branches         + company_id            -- Group → Company → Branch → Staff
users            (unchanged; a clerk's branch already implies its company)
expenses         + company_id            -- stamped from the branch/session (derivable, denormalised for reports)
                 + claim_override text    -- null=auto, 'claim'|'petty_cash' = manual override
petty_cash_floats(id, account_id, company_id, branch_id, period text 'YYYY-MM',
                  balance_bf numeric, currency, updated_by, updated_at)
cash_in          (id, account_id, company_id, branch_id, period, date, description,
                  amount, currency)        -- the float top-ups (Section A rows); or fold into floats jsonb
```
Claim status is **computed** (running balance + `claim_override`), not a stored truth, so it can never
drift from the numbers. `payment_status` (Phase 4) carries the reimbursement state.

## 6. Correctness decisions (CTO calls — why ours beats their manual sheet)

- **BALANCE = Cash-in-hand − Expenditure** (standard accounting). **Positive = surplus** (carries forward,
  no claim); **negative = overspent = claim** owed to staff. The trading-co. sample showed BALANCE
  **−75.09** while `3000 − 2924.91 = +75.09` — a **manual sign error** (same family as its `#REF!`
  formulas). Our output = **+75.09 surplus, no claim**, i.e. correct. A per-client "match their exact
  (wrong) convention" toggle is possible but OFF by default.
- **Never reproduce `#REF!`** — compute real subtotals/totals from the captured rows.
- **Currency conversion via the FX layer**, never the LLM (ADR-005); the 2nd-currency column reads the
  same converted values.

## 7. Capability flag + scope

- New business capability flag **`pettyCash`** (per-client; Premala = ON). Off ⇒ no petty-cash/claim/
  statement surface; the general product is unchanged.
- All petty-cash/statement queries go through the same `scopeForUser` bouncer (ADR-021) — now company- +
  branch-scoped.

## 8. Open / pending
- [ ] Confirm the anonymised layout reproduces faithfully once built (visual diff vs the client sample).
- [ ] Company category sets + which companies exist for Premala (focus: Premala first).
- [ ] PDF render approach decided at build time (reuse-deps-first).
