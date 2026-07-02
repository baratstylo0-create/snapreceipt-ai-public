# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** Merged to `main`: #12 template engine + `/api/templates` route, **#6 categorization**, **#5 anomaly + ADR-010**, #10 currency, **#4 OCR + #11 confidence**, **#8 reports**, **#2 Excel export (PR #19, ADR-012 exceljs)**, **ingestion wiring (PR #22)**, **#9 dashboard agent Phase 1 (PR #25 — read-only constrained tool-calling)**, **`groqChatTools()` (PR #26 — un-darkens #9's live path)**. `npm test` on main = **192 passing** (run `npm install` on a fresh clone — a stale `node_modules` missing `exceljs` was mistaken for a code bug once, see GOTCHA below). **PR #27 (housekeeping + ADR-013) MERGED** (`a13ba6d`, full self-review protocol). Open: #7 mass-upload PR (this branch) pending final Tier-2 QA.

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
**#7 mass upload BUILT** on `feature/jeevan-p4-massupload` (212/212 tests): `lib/massupload.js` `runBatch` orchestrator + `routes/upload.js` `POST /api/upload` (503 dark-path until Barat's `extractReceipts` merges — lifts on restart). Every task passed two-stage spec + code-quality review (1 Critical found+fixed in Task 1). Next: final independent Tier-2 QA → PR → merge; open + QA Barat's `feature/barat-p4-mass-ocr`; then #1 PDF (joint rasterization brainstorm with Owner), then the ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J2 | **#7 mass upload built** (orchestration-only, DI, sanitized failure reasons per SOP §7.2) — final Tier-2 QA then PR/merge. Then QA Barat's mass-ocr branch | #7 built, QA pending |
| Barat | — | Ingestion wiring + `groqChatTools()` merged. **Cross-lane dep for #7:** additive `extractReceipts(image, fieldSpec, opts) -> {receipts, truncated}` in `lib/ocr.js` on `feature/barat-p4-mass-ocr` (J1 to open PR + QA). Business Excel spike done → **phase PARKED** (personal M1 first). #1 PDF: parked pending joint brainstorm | groq-tools done; mass-ocr branch awaiting PR/QA |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #2 Excel · #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine + `/api/templates` route · ingestion wiring (#5/#6/#10/#11 → PR #22)
- ✅ Also merged: **#9 dashboard agent** (Phase 1 read-only, PR #25) · **`groqChatTools()`** (PR #26)
- 🔄 Built, awaiting final Tier-2 QA + PR: **#7 mass upload** (`feature/jeevan-p4-massupload`, 212/212; dashboard live path 503 until Barat's `extractReceipts` merges + restart; Telegram multi-photo adapter = Barat follow-up reusing `runBatch`)
- ⏳ To do: #1 PDF (joint brainstorm pending) · #3 dashboard (Mugi)

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| Barat's `extractReceipts()` (#7 cross-lane) — open its PR + independent QA | J2 | next action |
| #1 PDF rasterization approach — needs joint Owner brainstorm before build | Owner/J1/Barat | pending |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| exceljs transitive `uuid` audit bump (GitHub issue #20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## GOTCHA (new this session)
A feature branch showing failing tests right after merging `main` in isn't necessarily a real bug — if a dependency was added to `package.json` on `main` after your branch forked, your local `node_modules` may just be missing it. **Always `npm install` before diagnosing "post-merge" test failures.** (PR #22 was nearly treated as blocked on a real bug; it was a stale `node_modules`.)

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
