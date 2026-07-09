# Client Profile — Premala (first client)

> **What this is:** the per-client configuration profile for Premala, our first delivered client
> (ADR-022). It is **not** a code fork — it's a set of capability flags on the one shared codebase
> (ADR-010/020) plus notes on their workflow and what's pending. Other clients get their own
> `docs/clients/<name>.md`. **Precedence:** this profile configures behaviour; it never overrides the
> SOP, the frozen interfaces (`docs/ARCHITECTURE.md` §3), or the M2 design (ADR-021).

**Status:** design agreed 2026-07-06 (Owner-confirmed). Instance not yet provisioned. Custom PDF export
format **pending client samples**.

---

## 1. Their actual workflow (as told by the Owner)

- Each **branch** captures its own receipts and keeps its **own formatted Excel** with the **receipt
  snapshots embedded**, exported **as PDF** in a specific layout Premala already uses.
- Branches currently hand that file to the admin **manually, over WhatsApp / a chat app**.
- The **admin's "master template" is the admin's OWN file** — HQ / petty-cash expenses the admin captures
  themselves. It is **NOT** a company-wide spreadsheet that every branch live-merges into.
- The admin **does** want **live reports / analysis** on the dashboard.

## 2. How we deliver it — two layers, flagged independently (ADR-022)

| Layer | Behaviour for Premala | Mechanism |
|---|---|---|
| **Live data** (rows-not-workbooks, ADR-021) | **Unchanged.** Every branch receipt flows into the one shared DB → admin's **reports/analysis are live**. | default M2 data layer |
| **Live merged master workbook** | **OFF.** No all-branches-into-one live master spreadsheet. Admin's master file = their own Head-Office expenses. | `liveMasterMerge` = false |
| **In-dashboard live cell editing** ("excel-lite") | **ON** (Owner reversed the earlier OFF, 2026-07-09 — repeatedly requested). Lives as the **"Data editor (spreadsheet)"** sub-page of the **Manage** tab (dropdown), NOT a standalone tab. Read-only by default + an "Edit cells" toggle; search, pagination, category dropdown, CSV export. | `excelLiteGrid` = **true** |
| **Document hand-off** | **ON** — clerk hits **"Send to Admin"** in the dashboard; their compiled branch export lands in the admin's dashboard (no more WhatsApp). | `branchSubmission` = true |
| **Per-branch formatted Excel/PDF export** (receipts embedded → PDF, their layout) | **Pending samples** — build deferred. Foundation = Phase 3 receipt-image-in-Excel embed (ADR-018/021). | client-specific export task |

## 3. Capability flags (the Premala profile)

Set via `getCapabilities()` / `.env` on Premala's instance (exact env keys finalised when the flags land
in `lib/account.js`):

```
multiUser        = true    # branches + admin/clerk roles (M2)
companyDimension = true    # Group → Company → Branch → Staff (ADR-023; Premala runs multiple companies)
pettyCash        = true    # petty-cash floats + claim maths + Monthly Statement (ADR-023)
liveMasterMerge  = false   # NO live all-branch master workbook
excelLiteGrid    = true     # ON (2026-07-09, Owner) — the "Data editor" sub-page under Manage
branchSubmission = true    # "Send to Admin" in-dashboard hand-off
```

> **⚠️ OPS — live instances need the env flip too.** `excelLiteGrid` reads `CAP_EXCEL_LITE_GRID`
> (`lib/account.js`). The repo's local `.env` was set to `true` on 2026-07-09; **each live instance's
> `.env` (VPS) must be set `CAP_EXCEL_LITE_GRID=true` and the app restarted** for the Data editor
> sub-page to appear there. Until that flip, the live dashboard shows only the Template & Categories
> sub-page under Manage.

Everything else = general product defaults (their template/categories/branding/currency configured at
provisioning per ADR-020).

## 4. Why "Send to Admin" beats their current WhatsApp hand-off (CTO note)

1. **Security/privacy:** receipts are financial docs with PII. WhatsApp sends them outside every control
   we built; in-dashboard keeps them inside Premala's **isolated managed-silo instance** (ADR-020) —
   consistent with our processor/data-privacy posture (ADR-021 §11).
2. **Cheap:** the rows are already in the shared DB, so submission is a lightweight state-change + admin
   notification, not a file transfer.
3. **Audit trail for free:** who submitted, which branch, which period, when — the WhatsApp flow has none.

## 4b. Petty cash + claim + monthly statement (ADR-023 — samples received 2026-07-06)

Premala's core deliverable is a **Petty Cash Monthly Statement of Account** (one per company × branch ×
month) with **receipt snapshots appended**, exported as **both Excel and PDF**. Full anonymised format:
`docs/specs/2026-07-06-petty-cash-statement-format.md`. Key points:

- **Company dimension:** Premala runs **multiple companies** → Group → **Company** → Branch → Staff. Each
  company has its own **category set** (chart of accounts). Focus: build for Premala first.
- **Admin sets the petty-cash FLOAT per branch per month** (incl. the admin's Head-Office branch).
- **Claim = overspend maths:** `Balance = Cash-in-hand − Expenditure`; negative balance = claim owed to
  staff → reimburse via `payment_status`. (Their sample's `−75.09` is a manual sign error; ours computes
  the correct `+75.09` surplus — see spec §6.)
- **Dual export required, faithful to the sample:** Excel (real totals, embedded receipt thumbnails) +
  PDF (statement + appended receipt pages). Never reproduce their `#REF!`/sign bugs.
- **Flags:** add `pettyCash = true` to the Premala profile (§3 above).

## 5. Open items / pending Owner input

- [x] **Export samples received** (2026-07-06) — Petty Cash Monthly Statement (Excel template + completed
  PDF). Format captured (anonymised) in `docs/specs/2026-07-06-petty-cash-statement-format.md`.
- [ ] **Confirm faithful reproduction** once the exporter is built (visual diff vs the client sample).
- **NOT needed from the Owner:** Premala's company list / category sets / branches / staff names — the
  **admin enters all of this IN the product** (companies + branches + staff via provisioning; categories via
  template import #109; floats per branch). We already learned the needed *shape* from the sample files.
  (Optional: we could pre-seed their instance at handoff for a smoother start, but it's not required and
  not a blocker.)
- [x] **Categories imported (2026-07-09, Owner-directed).** The live instance's account-wide category set is
  now the **Construction co.** 9-category chart of accounts (Petrol/Diesel, Touch-n-Go, Entertainment,
  Printing & Stationery, Sundry, Travelling, Accommodation, Hardware & Loose Tools, Parking — `+Others`
  auto-appended), applied via `saveTemplate()` (`lib/templates.js`), existing template columns left untouched.
  **Known limitation, explicitly deferred (not a blocker):** the runtime only supports ONE account-wide
  category set today — `companies.template_id` exists in schema (references `field_templates.id`) but
  `getFieldSpec()` doesn't use it yet, so the **Trading co.** 5-category set (Tickets, Hotel, Food, Others,
  Hardware(PPE) & Touch-n-Go) from the same sample batch is NOT wired in. Per-company category-set
  resolution is a small, contained follow-up (`lib/templates.js` + the OCR-categorization + statement-export
  call sites) whenever Trading co. is actually provisioned — not needed for the current customisation pass.
- [x] **Category editor UI (2026-07-09).** The gap noted above (categories could only be changed via a
  script) is closed — the **Manage** tab (`public/js/components/templates.js`) now has a "Category list
  (chart of accounts)" section: add/remove/reorder rows, Save. Reuses the existing visual field builder's
  exact CSS/interaction idioms; order matters (the Statement export numbers categories in this order).
- [ ] **Operational pre-live only** (not build blockers): provision Premala's isolated instance (own
  Supabase project + Telegram bot token + Groq keys, ADR-015), enable **Groq ZDR**, apply migrations,
  hosting + HTTPS, run `setup-admin` (Phase 2 bootstrap) to mint the first admin.

## 6. What this does NOT change

The **general MVP build continues untouched.** Premala is a flag profile on the same build; the ADR-021
phase roadmap (identity → provisioning → data dims → anomaly/payments → bot → frontend) proceeds as the
default product. The only roadmap *additions* from Premala are the general `branchSubmission` feature and
the (parked) client-specific PDF export format.
