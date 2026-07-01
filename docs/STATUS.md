# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** Merged to `main`: #12 template engine, **#6 categorization**, **#5 anomaly + ADR-010**, #10 currency, **#4 OCR + #11 confidence (PR #12)**. `npm test` on main = **91 passing**. Open PRs: #13 templates-route (unreviewed), #8 reports (needs QA re-review).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
Land remaining P4 PRs (#13, #8) via Tier-2 + QA. **Barat is unblocked** → ingestion wiring. Then Jeevan's #2 Excel / #9 agent / #7 mass upload. Then the ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J1/J2 | Review #13 + re-review #8; own features #2/#9/#7 after | #10, #11, #12 merged |
| Barat | B1 | **UNBLOCKED** — ingestion wiring (categorize + anomaly + currency into `lib/ocr.js`/`lib/bot.js`) + apply category migration | #12 merged |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #4 OCR · #5 anomaly · #6 categorization · #10 currency · #11 low-confidence · #12 template engine
- 🔄 In review: #8 reports (PR #8, needs QA re-review) · #12 endpoint (PR #13, unreviewed)
- ⏳ To do: #1 PDF (rasterisation deferred) · #2 Excel · #3 dashboard (Mugi) · #7 mass upload · #9 agent

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| PR #12 OCR Critical | Barat | ✅ DONE — fixed + merged |
| PR #13 + PR #8 review → merge | J1/J2 | OPEN — in queue |
| Barat ingestion wiring | Barat | UNBLOCKED — in progress |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
