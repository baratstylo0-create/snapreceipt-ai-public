# FRONTEND — start here (Mugi's lane)

> **If you (or your Claude Code session) came looking for "the frontend" — this is the entry point.**
> The UI code does **not** live in a folder called `frontend/`. It lives in **[`public/`](public/)**
> (the web standard name for a static web root). This file exists so a search for "frontend" always
> lands you here.

## Where the frontend actually is

Everything the user sees is served from **`public/`** — a no-build, vanilla-JS app (no React, no
bundler, no `npm run build`; the browser loads the files directly):

```
public/
  index.html                  ← the shell (loads every script below; strict CSP, NO inline JS/CSS)
  css/
    app.css                   ← ALL styles (light / dark / warm themes via CSS variables)
  js/
    api.js                    ← the ONLY place that talks to /api/* (attaches the bearer token)
    app.js                    ← view switcher / bootstrapping
    authgate.js               ← dashboard-token gate
    escape.js                 ← Escape.setText / safeText — MANDATORY for any untrusted text in the DOM
    format.js  render.js      ← shared formatting + tiny render helpers
    exportGuards.js           ← export empty-data guards
    components/               ← one file per screen:
      nav.js        overview.js   activity.js   upload.js    templates.js
      reports.js    agent.js      falc.js       team.js      manage.js
      payments.js   settings.js   grid.js       login.js     ratemeter.js
  icons/  manifest.webmanifest ← PWA assets
```

Tests for all of the above live in **`tests/frontend/`**.

## Your workflow (pull → edit → self-merge)

You can now edit the frontend and **merge your own frontend-only changes** — the Owner has delegated
that. But your Claude Code session MUST run the self-review checklist first, because this repo is
under governance (strict CSP, XSS rules, a frozen backend API contract, auto-deploy to a live client).

**➡ The full guide + the pre-merge self-review checklist is in [`docs/roles/MUGI.md`](docs/roles/MUGI.md). Read it before your first edit.**

## The one-line summary of the rules

- **Only edit `public/**` (and `tests/frontend/**`).** Never touch `routes/`, `lib/`, `server.js`,
  `schema.sql`, or another person's files. Need a new API field/endpoint? Request it — don't build backend.
- **Render against the real `/api/*` contract** (ARCHITECTURE §3). Never call Supabase directly, never
  invent an endpoint, never hardcode the category list or currency (they come from `GET /api/config`).
- **CSP is strict:** no inline `<script>`, no inline `style=`, no `onclick=`/`on*=` handlers, no external
  script/style hosts. Build DOM in JS; put styles in `css/app.css`.
- **XSS:** any text that came from the API/user goes into the DOM via `Escape.setText(...)` — never
  `innerHTML` with dynamic content.
- **Merge only when:** CI is green, the self-review checklist passes, and the change is frontend-only.
  Anything touching backend/shared/schema still goes through the normal Owner review.
