# Handoff: M2 Phases 8–10 (company dimension → petty cash/claims → statement export)

> **Written by Fable 5 (CTO session, 2026-07-07) for execution by a cheaper model (Opus/Sonnet).**
> Every design decision in these phases is ALREADY MADE and recorded (ADR-021…025). Your job is
> execution, not re-design. If something here contradicts what you find in the repo, the repo +
> ADRs win — say so in the PR instead of silently improvising.

## Session bootstrap (do this first, in order)

1. **Load the `fable-mode` skill** (`~/.claude/skills/fable-mode/SKILL.md`) and keep its gates on
   for the whole session. These phases are exactly the "layered task" it exists for.
2. Read `CLAUDE.md` (repo root) → `docs/FRICTION_PROJECT_SOP.md` (§4 rituals) → this folder's four
   files in order (`00` → `04`).
3. You are working **as Jeevan (Claude-J session)**. Branch per phase off `main`:
   `feature/jeevan-m2-<phase-name>`. Conventional Commits. **Never push to main directly**
   (pre-push hook blocks it); **never self-merge** — open the PR and stop; the Owner names merges.
4. Current state when this was written: `main` = `62c476d` (Phase 7 merged). Full suite =
   **1303/1303**. If `main` has moved, diff this pack's assumptions against reality first.

## Standing conventions (non-negotiable, apply to every task)

- **Test convention:** the repo-root `.env` holds LIVE creds. Before ANY `npm test` / `node --test`:
  `mv .env .env.local.bak` … run … `mv .env.local.bak .env`. Never commit `.env`.
- **TDD:** write the failing test first, watch it fail, implement, watch it pass. Full suite green
  after every task; the personal-product baseline must stay byte-for-byte (all new behaviour
  flag-gated).
- **Hard constraints (plan §"HARD CONSTRAINTS"):** flag-gated (ADR-010); one codebase, no
  `if (client === 'X')` ever; every scoped query goes through the `req.scope` bouncer; Security
  Gate (ADR-025): RLS on every new table, rate limiter on every new route, server-side validation
  on every write, no PII/images in logs.
- **WORKLOG:** append an entry to `docs/WORKLOG.md` (newest-first, house format) with every push.
- **Deps:** the ONLY new dependency approved across these phases is **`pdfkit`** (Phase 10,
  ADR-024). Nothing else. `sharp` is explicitly rejected (ADR-014).

## Build order (strict — each phase depends on the previous)

| # | Phase | File in this pack | New branch |
|---|---|---|---|
| 1 | Phase 8 — company dimension | `01-phase8-company-dimension.md` | `feature/jeevan-m2-company-dim` |
| 2 | Phase 9 — petty-cash floats + claim engine | `02-phase9-pettycash-claims.md` | `feature/jeevan-m2-pettycash` |
| 3 | Phase 10 — statement dual export (xlsx + pdf) | `03-phase10-statement-export.md` | `feature/jeevan-m2-statement` |

Phase 9's tables reference `company_id` (Phase 8). Phase 10's statement model calls Phase 9's
maths. Do them sequentially: build → PR → Owner merges → next phase off fresh `main`. Read
`04-context-pack.md` BEFORE Phase 8 — it contains the live contracts and test patterns you must
reuse (do not invent parallel ones).

## Definition of done (whole handoff)

- Three merged-able PRs (CI green, full suite green, +new tests per phase, zero regressions).
- Flag OFF (`multiUser`/`companyDimension`/`pettyCash` unset) ⇒ today's product byte-for-byte.
- Phase 10's export visually matches the client sample per the §2b styling contract
  (`docs/specs/2026-07-06-petty-cash-statement-format.md`) — the Owner does the final visual diff
  against the confidential sample (you don't have it; do NOT ask for it — build to the spec).
- Ops notes surfaced in each PR: which `schema.sql` migration blocks need applying in Supabase.

## Source-of-truth documents (read on demand, don't guess)

- `docs/specs/2026-07-06-petty-cash-statement-format.md` — statement layout + §2b styling + §5 DDL sketch + §6 sign rules.
- `docs/specs/2026-07-06-business-account-multibranch-design.md` — M2 architecture + frozen contracts.
- `docs/specs/2026-07-07-security-hardening-audit.md` — SEC-1…SEC-10 gate.
- `docs/DECISIONS.md` — ADR-021 (M2), ADR-022 (profiles), ADR-023 (company+petty cash), ADR-024 (pdfkit), ADR-025 (security).
- `docs/clients/premala.md` — the client profile these phases serve.
