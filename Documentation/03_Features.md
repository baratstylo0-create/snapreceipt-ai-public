# Features

## Purpose
What the product does today — shared core, personal, and business (multi-branch) layer.

## Overview
Every item below exists in the current codebase. Business features activate only when their flag is on (`lib/account.js`); off = the personal product is unchanged.

## Key Components

### A. Core capture & AI (all modes)
| Feature | What it does |
|---|---|
| Telegram photo capture | Send a photo → auto-read and logged |
| Multi-photo (album) | Several photos at once → all logged, one summary |
| PDF ingestion | Rendered to images, read the same way (size/pixel caps) |
| AI field extraction | Merchant, date, amount, subtotal, tax, currency, line items |
| Auto-categorisation | Rules + learned corrections + AI classifier |
| Confidence scoring | Low-confidence fields flagged; bot may ask to confirm |
| Category learning | A manual fix is remembered for next time |
| Currency handling | Stored in account default currency; original retained |
| Voucher number | Each expense gets `RC-2026-0041` (DB-generated, race-free) |

### B. Dashboard (web)
| Feature | What it does |
|---|---|
| List + filters | Browse, search, filter saved expenses |
| Edit | Correct any field; category edits feed learning |
| Soft delete | Hidden, recoverable — never hard-deleted |
| Reports/Overview | Totals, category breakdowns, custom colours |
| Review queue | Admin approves/rejects flagged expenses |
| AI agent chat | Ask questions; native tool-calling over your data |
| Excel export | Formatted workbook + business branch/staff columns + receipt images |
| Mass upload | Upload many receipts at once |
| Template import | Import a CSV/Excel header template (your own columns/categories) |

### C. Telegram bot
| Feature | Personal | Business |
|---|---|---|
| Today's Bills | List + per-bill ❌ delete | Staff name per line; one "Delete a bill → type number" |
| Today's Expenses | Today's total | Branch-scoped total |
| Weekly Record | Monday-start week | Sunday-start week |
| Category picker | Tap or "Others" + note | Same, plus the company's category set |
| Staff tagging | — | Pick who the receipt belongs to after saving |

### D. Business layer (M2 — flag-gated)
| Feature | Flag | What it does |
|---|---|---|
| Multi-user roles | `multiUser` | Admin + clerk logins; staff as a name-only directory |
| Branches | `multiUser` | Partition an account into HQ + offices |
| Company dimension | `companyDimension` | Group → Company → Branch → Staff; per-company categories |
| Send to Admin | `branchSubmission` | Clerk submits a branch's month in-dashboard (audit-trailed) |
| Petty cash + claims | `pettyCash` | Monthly float + cash-in; balance/claims computed on read |
| Monthly statement | `pettyCash` | Excel + PDF statement per branch × month, receipts appended |
| Branch isolation | always (business) | Clerk sees own branch only; admin sees all |

## Notes
- Personal mode is a strict subset — business columns/tables exist but stay unused/null.
- First client's custom PDF statement layout: foundation built, exact match **Requires Manual Review** during delivery.
