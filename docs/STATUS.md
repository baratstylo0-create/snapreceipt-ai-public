# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** Merged to `main`: #12 template engine, **#6 categorization**, **#5 anomaly + ADR-010**, #10 currency, **#4 OCR + #11 confidence**, **#12 templates-route (PR #13)**, **#8 reports (PR #8)**. `npm test` on main = **127 passing**. No open PRs.

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
P4 feature backlog: waiting on Barat's ingestion-wiring PR (not yet opened). Meanwhile Jeevan starts #2 Excel / #9 agent / #7 mass upload. Then the ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J2 | #13 + #8 merged; starting #2 Excel export | #13, #8 merged |
| Barat | B1 | **UNBLOCKED** — ingestion wiring (categorize + anomaly + currency into `lib/ocr.js`/`lib/bot.js`) + apply category migration — PR not yet opened | in progress |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine + `/api/templates` route
- ⏳ To do: #1 PDF (rasterisation deferred) · #2 Excel · #3 dashboard (Mugi) · #7 mass upload · #9 agent

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| PR #13 templates-route Critical (stack-trace leak) | J2 | ✅ DONE — fixed + merged |
| PR #8 reports Important (fake-money/Infinity coercion) | J2 | ✅ DONE — fixed + merged |
| Barat ingestion-wiring PR review (Tier-2, when opened) | J2 | WAITING — not opened yet |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
