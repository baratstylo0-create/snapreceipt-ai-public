# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features (nearly complete).** Merged to `main`: #12 template engine, #6 categorization, #5 anomaly (ADR-010), #10 currency, #4 OCR + #11 confidence, #8 reports, #2 Excel (ADR-012), ingestion wiring (#22), **#9 dashboard agent Phase 1 (#25)**, **`groqChatTools()` (#26)**, **#7 MASS UPLOAD — both surfaces**: `runBatch` + `POST /api/upload` (#28), Barat's `extractReceipts()` (#29), Barat's **Telegram multi-photo adapter (#32)**. `npm test` on main = **273 passing** (`npm install` on a fresh clone — a missing `exceljs` was mistaken for a code bug once, see GOTCHA). Open: `chore/jeevan-j1-session-end` (this session's HANDOFF/STATUS refresh + 1 cherry-picked telegram-QA test, 274) — Owner to merge. **Only remaining backend feature: #1 PDF** (blocked on a joint rasterization brainstorm with the Owner — planned as a fresh session).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
**#7 mass upload COMPLETE + MERGED on both surfaces** (dashboard `POST /api/upload` #28 + Telegram multi-photo #32, both Tier-2-QA'd; extractReceipts #29). main = 273. Remaining: (1) merge the `chore/jeevan-j1-session-end` housekeeping PR; (2) **#1 PDF ingestion** — the last backend feature, blocked on a joint rasterization brainstorm with the Owner (**fresh session** per the one-session-per-feature workflow decision); (3) ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J2 | **#7 mass upload built** (orchestration-only, DI, sanitized failure reasons per SOP §7.2) — final Tier-2 QA then PR/merge. Then QA Barat's mass-ocr branch | #7 built, QA pending |
| Barat | B1/B2 | **#1 PDF ingestion built** — `lib/pdf.js` (`rasterizePdf`, ADR-014 `@hyzyla/pdfium`) + Telegram PDF path in `lib/bot.js`. 292/292 tests, live end-to-end verified (real PDF → real render → real Groq extraction). `feature/barat-p4-pdf` pushed, PR open — Tier-2, awaiting independent QA. Also fixed issue #30 (merged, PR #34). #1 PDF was the last item in Barat's lane | PR open, awaiting QA |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #2 Excel · #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine + `/api/templates` route · ingestion wiring (#5/#6/#10/#11 → PR #22)
- ✅ Also merged: **#9 dashboard agent** (Phase 1 read-only, PR #25) · **`groqChatTools()`** (PR #26)
- 🔄 Built + QA'd (APPROVE), PR pending merge: **#7 mass upload** (`feature/jeevan-p4-massupload`, 240/240; dashboard live path 503 until Barat's `extractReceipts` merges + restart; Telegram multi-photo adapter = Barat follow-up reusing `runBatch`)
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
