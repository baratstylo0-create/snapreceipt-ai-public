# Team view → org-hierarchy tree (visual reshape)

**Date:** 2026-07-11 · **Author:** Jeevan (Owner-directed) · **Status:** approved design, pre-implementation
**Scope:** frontend-only. `public/js/components/team.js` + `public/css/app.css`. **No backend, schema, or API change.**

> **Lane note (collision rule §4.6):** `public/*` (team.js, app.css) is Mugi's M2 lane. This work is
> Owner-directed (Jeevan) and recorded here + in WORKLOG so Mugi has the context. Nothing in the M2
> data model, routes, or isolation contract changes — this is purely how the existing Team view is drawn.

## Problem
The Team view (ADR-021 Phase 2/8) renders branches as a flat responsive grid of cards
(`.team-branches` → `.team-branch-card`). It works but reads as a pile of equal cards; the
admin → branch → clerk/staff hierarchy isn't visible at a glance. The Owner wants the
organisation shape made obvious and easy to scan, taking cues from Mugi's original
`concept-fresh.html` org-tree mockup.

## Decision
Reshape the **admin** Team view into a **responsive vertical-spine hierarchy tree**. Keep every
existing capability and its immediate per-action save behaviour. This is a presentation change, not
a feature change.

Rejected alternatives:
- **Horizontal org chart** (literal concept mockup): pretty for ~4 branches, breaks when branches
  wrap; needs a horizontal-scroll lane. Premala already runs several branches → doesn't scale.
- **Inline "editing mode"** (rename fields, Save/Cancel, an HQ/org name field): the concept shows it,
  but the server has **no PATCH/PUT** for branches/companies/staff and no stored org name. Would need
  new backend routes + schema. Explicitly **out of scope** (Owner chose "visual reshape only").

## Shape (admin)
```
┌───────────────────────────────┐
│  ORGANISATION (root node)     │   title = org/account name (honest fallback "Your organisation")
│  Admin · sees every branch    │   subtitle = role line, NOT editable
└───────────────┬───────────────┘
                │  (vertical spine, CSS-only connector)
                ├─◗ Branch node — office (· state) · company chip · clerk / "no clerk yet"
                │        Staff (name-only): add (+) / two-step remove (×)
                │        Remove branch (two-step confirm)
                ├─◗ Branch node …
                └─◗ ＋ Add branch  (dashed tree-native node → expands existing add-branch form)
```
- **Root node**: non-editable. Title from `deps.session`/`deps.config` (account/org display name) with a
  safe fallback; subtitle is a static honest role line.
- **Branch node**: same content as today's card — `office (· state)`, clerk line (or "no clerk yet"),
  company chip when assigned, name-only staff list with existing add/remove, and Remove branch. Inactive
  branches keep the dimmed `is-inactive` treatment.
- **Add branch**: dashed node at the tail of the spine; expands the current add-branch form (unchanged
  POST + one-time credential panel flow).
- **Companies**: unchanged — feature-detected slim strip above the tree (chips + "＋ Add company");
  each branch shows its company as a chip. If the company dimension is off (live 404), no company UI.
- **Credential panel**: unchanged (renders after a branch is created).

## Shape (clerk)
A clerk sees only their own branch (server-enforced). No root/HQ chrome — a single branch node with
staff management, matching today's behaviour, lightly restyled to the node look. A "tree of one" root
would be noise.

## Interactions
All existing actions stay **immediate-save** (add/remove commit on click via the current APIs):
`POST/DELETE /api/branches`, `POST /api/branches/:id/staff`, `DELETE /api/staff/:id`,
`GET/POST/DELETE /api/companies`. No batching, no Save/Cancel, no role-switcher.

## Tech & guardrails
- **Pure DOM** only: `createElement` + `Escape.setText`, never `innerHTML` with a dynamic value
  (stored-XSS discipline, same as every other view).
- **CSS-only connectors** (spine + elbows via borders/pseudo-elements). No SVG, no libraries — the app
  has no build step and a strict CSP.
- **Responsive** (relative units, wraps/stacks on narrow) and **dark-theme aware** (existing tokens:
  `--panel`, `--line`, `--teal`, `--moss`, `--txt`, `--muted`, `--radius-sm`, `--panel-shadow`, …).
- **Tests:** existing exported pure helpers (`normalizeBranch`, `sortedBranches`, `botDeepLink`, …)
  keep their node tests unchanged. Add one small tested pure helper `rootLabel(session, config)` for the
  root node title/fallback. DOM render stays browser-verified (codebase convention — render fns aren't
  unit-tested).
- **Verification:** drive it live in the preview server — admin tree (0, 1, and many branches),
  add/remove branch, add/remove staff, company chip, and the clerk single-branch view — and screenshot.

## Out of scope
Inline rename, stored org/admin name, the "VIEWING AS" role-switcher, per-staff/clerk bot-ID fields,
and any backend/schema/route change. Those were the concept-only parts that contradict the signed-off
M2 data model (name-only staff; only the branch clerk is credentialed).
