# Folder Structure

## Purpose
How the codebase is organised, for fast navigation.

## Overview
Clean split: **`server.js`** wires everything, **`lib/`** holds logic, **`routes/`** holds HTTP endpoints, **`public/`** is the dashboard, **`docs/`** is project documentation/decisions.

```
receipt-analyser-saas/
├── server.js                 # Entry point — mounts middleware + routes
├── schema.sql                # Full database schema (run once on Supabase)
├── package.json               # Dependencies + scripts
├── render.yaml / Dockerfile / fly.toml   # Deployment configs
│
├── lib/                       # All logic (36 modules)
│   ├── config.js / account.js         # Env config, model routing, capability flags
│   ├── auth.js / supabase.js          # Sessions, scopeForUser, DB access + isolation
│   ├── bot.js / telegram.js           # Bot conversation logic + Telegram API client
│   ├── ocr.js / groq.js / groqkeys.js # AI pipeline + provider client + key rotation
│   ├── categorize.js / categoryMemory.js / confidence.js
│   ├── agent.js / agentProposals.js   # Dashboard AI agent
│   ├── branches.js / pettyCash.js     # Branch/staff, petty-cash maths (business)
│   ├── statement.js / statementXlsx.js / statementPdf.js
│   ├── reports.js / excel.js / templates.js
│   ├── pdf.js / storage.js            # PDF rendering, receipt image storage
│   ├── anomaly.js / reviewDecision.js / expenseValidation.js
│   ├── money.js / currency.js / ratelimit.js
│   ├── security-headers.js / cors-preflight.js / log.js / http.js
│
├── routes/                    # HTTP endpoints (17 files)
│   ├── webhook.js / auth.js
│   ├── expenses.js / receipt.js / reports.js / excel.js / review.js
│   ├── agent.js / upload.js / templates.js / settings.js / misc.js
│   └── branches.js / companies.js / submissions.js / pettyCash.js / statement.js
│
├── public/                    # Browser dashboard (vanilla JS, no framework)
│   ├── index.html / css/app.css
│   └── js/  (app.js, api.js, render.js, authgate.js + components/)
│
├── setup/                     # Admin provisioning CLI (setup-admin)
├── tests/                     # Automated tests (node --test) — 100+ files
└── docs/                      # Architecture, decisions, specs, runbooks, status
```

## Key Components
| Folder | Contains | User-facing? |
|---|---|---|
| `lib/` | All logic — testable, framework-free | No |
| `routes/` | Thin HTTP handlers calling `lib/` | No |
| `public/` | The dashboard | Yes |
| `docs/` | Architecture, ADRs, runbooks | Team |
| `tests/` | Automated tests | Team |

## Notes
- Routes stay thin — real logic lives in `lib/`; `server.js` is wiring only.
- Frontend uses **external** JS/CSS only (no inline scripts) to satisfy a strict CSP.
