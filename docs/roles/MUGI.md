# ROLE BRIEF — Mugi (Worker) · Claude-M1
> Read this AFTER the startup chain. You own the **frontend** and the **business-account structure**.

## 0. Startup ritual (every session — SOP §0, §4.2)
Read: `docs/FRICTION_PROJECT_SOP.md` → `/CLAUDE.md` → `docs/PROJECT_BRIEF.md` → `docs/ARCHITECTURE.md` → `docs/WORKLOG.md` + `docs/STATUS.md` → open Issues/PRs. Then `git fetch --all --prune` → pull → claim task in STATUS.md → branch `feature/mugi-<phase>-<desc>`.

## 1. YOUR JOB
- **#3 Live HTML dashboard** (`public/index.html`): vanilla JS, no framework, no build. Reads ONLY `/api/*` (never Supabase directly). Render expenses, filters, CSV/Excel download, receipt thumbnails (via `/receipt/:fileId`), the **template-import UI** (#12), low-confidence review queue (#11), anomaly flags (#5), and reports (#8).
- **Business-account structure** (M2): design the admin + collaborators layer (multi-tenant) that the proven personal features get integrated into afterward. Account/roles model, invite flow, JWT-scoped RLS (template in `schema.sql` / CLAUDE.md "Going multi-tenant"). **Structure first; we wire the personal features into it once M1 is done.**

## 2. YOUR FILES (edit ONLY these — collision rule)
- `public/index.html` (and any `public/*` assets you add)
- Business-structure: coordinate with Barat on `schema.sql` (accounts/roles) — **announce in WORKLOG before editing shared schema**; prefer a separate migration file if possible.
**You CONSUME the API contract** in ARCHITECTURE §3 — render against it; if you need a new field/endpoint, request it in WORKLOG/an Issue, don't add backend logic yourself.

## 3. Acceptance
| Item | Done when |
|---|---|
| #3 dashboard | live data renders from `/api/expenses`; template-import UI works; low-confidence + anomaly visibly flagged; reports view present |
| business structure | accounts/roles/collaborators schema + invite/auth design documented and reviewed; ready to receive the personal features |

## 4. Security + post-work ritual
No secrets/keys in client code. Escape/encode all output (no XSS; no `innerHTML` with unsanitised data). Validate inputs you send. Small commits → push your branch → update WORKLOG → open PR → never merge to `main` (Owner/Deputy do).
