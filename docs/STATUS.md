# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** Merged to `main`: #12 template engine + `/api/templates` route, **#6 categorization**, **#5 anomaly + ADR-010**, #10 currency, **#4 OCR + #11 confidence**, **#8 reports**, **#2 Excel export (PR #19, ADR-012 exceljs)**. `npm test` on main = **150 passing**. No open PRs.

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
P4 feature backlog: waiting on Barat's ingestion-wiring PR (not yet opened). Jeevan's #2 Excel done → next #9 dashboard agent, then #7 mass upload. Then the ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J2 | #13 + #8 + #2 merged; next #9 dashboard agent → #7 mass upload | #2 Excel merged |
| Barat | B1 | **UNBLOCKED** — ingestion wiring (categorize + anomaly + currency into `lib/ocr.js`/`lib/bot.js`) + apply category migration — PR not yet opened | in progress |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #2 Excel · #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine + `/api/templates` route
- ⏳ To do: #1 PDF (rasterisation deferred) · #3 dashboard (Mugi) · #7 mass upload · #9 agent

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| Barat ingestion-wiring PR review (Tier-2, when opened) | J2 | WAITING — not opened yet |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| exceljs transitive `uuid` audit bump (GitHub issue #20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
