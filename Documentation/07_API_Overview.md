# API Overview

## Purpose
The HTTP endpoints, who can call them, and how requests are secured.

## Overview
All endpoints are Express routes mounted in `server.js`. Data endpoints live under `/api/*` and require a bearer token (`checkDash`). Business endpoints additionally require the matching capability flag and role. The Telegram webhook is a separate, secret-gated endpoint.

## Key Components (endpoints)

### Public / system
| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/` | Serve dashboard | none |
| GET | `/health` | Liveness check | none |
| GET | `/ready` | Deep readiness probe | rate-limited |
| POST | `/webhook` | Telegram updates | secret header |
| GET | `/api/config` | Public front-end config | none |

### Expenses & receipts
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/expenses` | List (branch-scoped for a clerk) |
| PATCH / DELETE | `/api/expenses/:id` | Edit / soft-delete |
| PATCH | `/api/expenses/payments` | Bulk mark-paid (admin) |
| GET | `/receipt/:fileId`, `/receipt/by-id/:id` | Fetch a receipt image |

### Reporting, export, review, agent
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/reports` | Aggregated report data |
| GET | `/api/excel` | Excel export |
| GET / POST | `/api/review`, `/api/review/:id` | Review queue list / decide |
| POST | `/api/agent`, `/api/agent/confirm` | Ask the AI agent / confirm its proposed action |
| POST | `/api/upload` | Mass-upload from dashboard |
| GET / POST | `/api/templates` | Read/import a custom field template |
| GET / PUT | `/api/settings/category-colors` | Read/save donut colours |

### Business (flag + role gated)
| Method | Path | Purpose | Gate |
|---|---|---|---|
| POST | `/api/login`, `/api/logout` | Business session | multiUser |
| GET/POST/DELETE | `/api/branches[/:id]`, `/…/staff` | Manage branches/staff | admin |
| GET/POST/DELETE | `/api/companies[/:id]` | Manage companies | companyDimension, admin |
| GET/POST/PATCH | `/api/submissions[/:id]` | Send-to-Admin flow | branchSubmission |
| GET/PUT/POST/DELETE | `/api/petty-cash*` | Floats + cash-in | pettyCash, admin |
| GET | `/api/statement` | Monthly statement (Excel/PDF) | pettyCash |

## How It Works
1. **`checkDash`** gates every `/api/*` and `/receipt` route — no valid bearer token, no data; **fails closed** in production.
2. In business mode the token resolves to a **session → scope** (`account_id`, role, branch/company). `lib/supabase.js` applies that scope to every query and stamps it on every insert.
3. Business routes also check the **capability flag** and **role**; non-qualifying requests get a 404/403.
4. **Errors are generic** — a global handler returns `{"error": "..."}`, never a stack trace or file path.

## Notes
- Request bodies have per-route size limits (e.g. 16 KB login, 10 MB upload).
- Sensitive routes carry their own rate limiters (login, agent, upload, statement, admin).
- Exact field shapes per endpoint live in the route files/tests — treat those as the contract.
