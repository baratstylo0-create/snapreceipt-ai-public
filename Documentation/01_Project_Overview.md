# Project Overview

## Purpose
Receipt Analyser SaaS turns receipt/invoice photos into structured expense records automatically, via a Telegram bot or a web dashboard, using AI extraction.

## Overview
| Item | Detail |
|---|---|
| Product type | Vertical AI SaaS — expense capture + reporting |
| Primary input | Telegram photo/PDF, or dashboard upload |
| AI engine | Groq-hosted vision + text models |
| Backend | Node.js (≥20) + Express |
| Database | Supabase (PostgreSQL + Storage) |
| Frontend | Vanilla JavaScript (no framework) |
| Hosting | One isolated deployment per client |
| Tenancy | Single-account-per-instance |

One codebase serves two modes via configuration, not a fork:
- **Personal** — one person tracking their own expenses.
- **Business** — multiple branches, staff, admin/clerk roles, petty cash, monthly statements.

## Key Components
- **Telegram bot** — main capture channel; reads receipts, summarises daily/weekly totals.
- **AI pipeline** — vision model reads the image; rules + a text model categorise; results are validated.
- **Web dashboard** — list, filter, edit, review, report, export; business login for admin/clerk.
- **Business layer (M2)** — branches, staff, roles, petty cash, statement export, strict branch/company isolation.
- **Database** — Supabase Postgres holds every record; accessed only by the server (service-role key).

## How It Works
1. A receipt arrives (bot or dashboard).
2. AI reads it into structured fields (merchant, date, amount, tax, category, line items).
3. Saved and tagged to the account (and, in business mode, branch/company/staff).
4. Users view/manage on the dashboard and export to Excel/PDF.

## Notes
- Business features are flag-switched; off = personal product unchanged.
- Isolation is enforced at one application checkpoint today; database-level RLS is a planned hardening step.
- Anything not verifiable from code is marked **Requires Manual Review**.
