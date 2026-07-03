# ROLE BRIEF — Mugi (Worker) · Claude-M1
> Read this AFTER the startup chain. You own the **production frontend** and, later (M2), the **business-account structure**.

## 0. Startup ritual (every session — SOP §0, §4.2)
Read IN ORDER: `docs/FRICTION_PROJECT_SOP.md` → `/CLAUDE.md` → `docs/PROJECT_BRIEF.md` (the frozen scope / "main report" — the 12 features, users, threat model, tech stack) → `docs/ARCHITECTURE.md` (**§3 = the frozen API contract you build against**) → `docs/WORKLOG.md` + `docs/STATUS.md` (what's current) → open Issues/PRs. Then `git fetch --all --prune` → pull `main` → claim your task in STATUS.md → branch `feature/mugi-<phase>-<desc>`. **Do NOT drift: trust these docs over any assumption. If a doc contradicts the code, the code on `main` wins — say so and flag it.**

## 1. WHERE THINGS ACTUALLY ARE (read this — the codebase moved on from the old single-file plan)
There is already a **complete, working reference frontend** in `public/` that surfaces EVERY backend feature. It is **not** a single `index.html` — it's a modular, no-build, vanilla-JS app:
```
public/
  index.html              ← shell (loads the scripts below; CSP-clean, no inline JS)
  css/app.css             ← all styles (Finexy-style visual pass already applied)
  js/
    api.js                ← the ONLY place that talks to /api/* (bearer-token attach, fetch wrapper)
    app.js                ← view switcher / bootstrapping
    authgate.js           ← dashboard-token gate
    escape.js             ← Escape.setText / safeText — MANDATORY for any untrusted text in the DOM
    format.js, render.js  ← shared formatting + tiny render helpers
    components/
      nav.js  overview.js  activity.js  upload.js  templates.js  reports.js  agent.js  ratemeter.js
```
Each `components/*.js` is one screen. This is your **starting point and reference** — study it to see every feature, flow, and button that must exist.

## 2. YOUR JOB (current — M1 production frontend)
**Deliver a production frontend design/concept.** The Owner's workflow: **you produce the design/concept (look, layout, UX, component structure — e.g. a Finexy-style modern dashboard); Jeevan's team then extracts the source and adapts our existing `public/` app to match it, following the frozen API contract.** So:
- You may build the concept as its own artifact (HTML/CSS mockup, component sketches, or a full alternative `public/`-style build) — but it MUST render against the **real `/api/*` contract** (§3 below), never Supabase directly, never a mocked/invented endpoint.
- Cover every screen the reference frontend has: Overview, Activity (list + filters + edit drawer + review queue), Upload (image/PDF/multi), Manage (template import + visual field builder), Reports (+ Excel export), Agent chat.
- Honour the data shapes and category/currency handling that already exist — don't reinvent the taxonomy (18 categories come live from `GET /api/config`) or currency (amounts are pre-normalised to the account currency server-side).

## 3. THE API CONTRACT YOU CONSUME (current, live on `main` — full detail in ARCHITECTURE §3)
All dashboard routes require the bearer token (`Authorization: Bearer <DASHBOARD_TOKEN>`) via `checkDash`, EXCEPT `/api/config` and `/health` which are open.
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | categories (the real 18), account currency, flags — **single source of truth for the category list** |
| GET | `/api/expenses` | list all expenses (account-scoped, soft-deleted excluded) |
| PATCH | `/api/expenses/:id` | edit (merchant, expense_date, amount, currency, category, status, remark, subtotal, tax) |
| DELETE | `/api/expenses/:id` | soft-delete |
| GET | `/api/reports` | totals + per-category + per-period breakdown |
| GET | `/api/excel` | download `.xlsx` (authed blob fetch, not a plain link) |
| POST | `/api/upload` | dashboard upload `{ images: [base64/data-URI] }` (images AND PDFs) |
| GET | `/api/templates` | the customer's FieldSpec (field labels/types) |
| POST | `/api/templates` | import a CSV field template |
| POST | `/api/agent` | AI chat `{ messages: [{role,content}] }` → `{ answer, toolCalls }` |
| GET | `/api/review` | the low-confidence / anomaly review queue |
| POST | `/api/review/:id` | `{ decision: 'approve'|'reject' }` |
| GET | `/receipt/:fileId` | receipt-image proxy (authed; see note) |

**Note on receipt images:** they currently often 404 — dashboard uploads store no image and the Telegram proxy needs `BOT_TOKEN`. A proper fix (Supabase Storage → `receipt_url`) is planned. Design the receipt-view UI, but expect the image may be absent (the existing frontend already shows a graceful "No receipt image on file" fallback — keep that behaviour).

## 4. YOUR FILES (collision rule §4.6)
- Anything under `public/` you add for your concept, and your own design docs under `docs/` (e.g. `docs/design/`).
- **You CONSUME the API contract** (§3) — render against it. If you need a new field or endpoint, request it in WORKLOG or a GitHub Issue; do NOT add backend logic yourself.
- The current `public/` app was authored by J1 (the reference build). Coordinate before rewriting it in place — your primary deliverable is the design/concept; the team integrates. Announce in WORKLOG before large edits to shared `public/` files.

## 5. Business-account structure (M2 — DEFERRED, do not build yet)
Design (later, on Owner's go) the admin + collaborators multi-tenant layer the proven personal features get wired into: account/roles model, Telegram deep-link invite flow (see `docs/specs/2026-07-03-user-onboarding-chatid-linking-design.md`), JWT-scoped RLS (template in `schema.sql` / CLAUDE.md "Going multi-tenant"). **Structure first, on paper; build only after the Owner signs off that personal M1 is solid.**

## 6. Acceptance
| Item | Done when |
|---|---|
| Production frontend concept | design/concept covers every screen the reference frontend has; renders against the real `/api/*` contract; no Supabase access, no invented endpoints; category list from `/api/config`; team can adapt our source to it without contract changes |
| Business structure (M2) | accounts/roles/collaborators schema + invite/auth design documented + reviewed; ready to receive the personal features |

## 7. Security + post-work ritual
No secrets/keys in client code. **Escape/encode ALL output** — every untrusted value (OCR merchant text, `ai_raw`, anomaly reasons, remarks, FieldSpec labels) goes through `Escape.setText`/`safeText`; NEVER `innerHTML` with unsanitised data (this app's #1 stored-XSS surface is exactly this). Validate inputs you send. Small commits → push your branch → update WORKLOG → open PR → **never merge to `main`** (Owner/Deputy do). Give Jeevan your GitHub username so he can add you as a collaborator.
