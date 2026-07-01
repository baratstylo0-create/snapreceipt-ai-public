# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** Merged to `main`: #12 template engine + `/api/templates` route, **#6 categorization**, **#5 anomaly + ADR-010**, #10 currency, **#4 OCR + #11 confidence**, **#8 reports**, **#2 Excel export (PR #19, ADR-012 exceljs)**, **ingestion wiring (PR #22 — #5/#6/#10/#11 into `lib/ocr.js`)**. `npm test` on main = **160 passing** (run `npm install` on a fresh clone — a stale `node_modules` missing `exceljs` was mistaken for a code bug once this session, see GOTCHA below). Open: **PR #24** (docs-only refresh after #22, Tier-1, awaiting Owner merge — self-merge auto-blocked).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
**#9 dashboard agent (Phase 1, read-only tool-calling) built** on `feature/jeevan-p4-agent` — 184/184 tests, ready to open its PR for independent Tier-2 QA (AI prompt boundary + tool-calling security). Then #7 mass upload. Then the ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J1 | #9 dashboard agent built (Phase 1, tool-calling + stateless multi-turn), opening PR for Tier-2 QA → then #7 mass upload | #13/#8/#2 merged; #9 ready for QA |
| Barat | — | Ingestion wiring **merged (PR #22)**. `category_corrections` applied + REST-verified live in Supabase (2026-07-01). Cross-lane ask from #9: add an **additive** `groqChatTools()` to `lib/groq.js` (full assistant message incl. `tool_calls`, does not change existing `groqChat`) — see `docs/ARCHITECTURE.md` §3.2 for the exact signature. Non-blocking (routes/agent.js's live path is dark until it lands; all tests inject a fake chat). Barat's only remaining own item: #1 PDF ingestion (his call) | done, one new cross-lane ask |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #2 Excel · #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine + `/api/templates` route · ingestion wiring (#5/#6/#10/#11 → PR #22)
- 🔄 Built, awaiting Tier-2 QA: **#9 dashboard agent** (Phase 1 read-only — `feature/jeevan-p4-agent`, 184/184, PR not yet opened)
- ⏳ To do: #1 PDF (rasterisation deferred) · #3 dashboard (Mugi) · #7 mass upload

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| PR #24 (docs refresh) awaiting Owner merge (self-merge auto-blocked) | Owner | OPEN |
| #9 PR not yet opened — open + dispatch independent Tier-2 QA | J1 | next action |
| Barat: additive `groqChatTools()` in `lib/groq.js` (#9 cross-lane, non-blocking) | Barat | tracked, non-blocking |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| exceljs transitive `uuid` audit bump (GitHub issue #20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## GOTCHA (new this session)
A feature branch showing failing tests right after merging `main` in isn't necessarily a real bug — if a dependency was added to `package.json` on `main` after your branch forked, your local `node_modules` may just be missing it. **Always `npm install` before diagnosing "post-merge" test failures.** (PR #22 was nearly treated as blocked on a real bug; it was a stale `node_modules`.)

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
