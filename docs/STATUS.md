# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features (nearly complete).** Merged to `main`: #12 template engine, #6 categorization, #5 anomaly (ADR-010), #10 currency, #4 OCR + #11 confidence, #8 reports, #2 Excel (ADR-012), ingestion wiring (#22), #9 dashboard agent Phase 1 (#25), `groqChatTools()` (#26), **#7 MASS UPLOAD — complete both surfaces** (#28/#29/#32), issue #30 fix (PR #34). `npm test` on main = **275 passing**. No open PRs. **#1 PDF ingestion: brainstorm+spec+ADR-014+plan DONE (PR #35/#36)** — `@hyzyla/pdfium` (WASM), interop spike PASSED in-session (J1), fallback not needed. **Barat dispatched, building `feature/barat-p4-pdf`** per `docs/plans/2026-07-02-pdf-ingestion.md`. Next Claude: check `gh pr list` for his PR; if open, do independent Tier-2 QA; if not yet, this is a waiting state — check WORKLOG/HANDOFF for anything else pending, else idle-window tasks (see STATUS "Not doing yet" / open GitHub issues).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
**#1 PDF ingestion is IN BUILD.** Brainstorm+spec+ADR-014+plan done (PR #35/#36); Barat dispatched on `feature/barat-p4-pdf` per `docs/plans/2026-07-02-pdf-ingestion.md`. His Task 0 interop spike is pre-validated (J1 ran it in-session — see ADR-014). Remaining: (1) Barat builds `lib/pdf.js`+Telegram path, TDD, PR → independent Tier-2 QA → merge; (2) J1's Task 7 route glue (`routes/upload.js`) after that merges; (3) ADR-011 reference frontend for Mugi.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J2 | **#1 PDF Telegram side QA'd + MERGED (PR #38)** — 2 Important findings (render-dimension bomb + raw-error leak) found, fixed by Barat, re-QA APPROVE (317/317). Next: build Task 7 (`routes/upload.js` PDF glue) after the `/api/upload` Buffer→data-URI fix lands | #38 merged, Task 7 next |
| Barat | B1/B2 | **#1 PDF ingestion built + merged** (`lib/pdf.js` rasterizer + Telegram path, `@hyzyla/pdfium` ADR-014, render-pixel cap). Also fixed issue #30 (#34). Separate open branch `fix/barat-ocr-buffer-image` (/api/upload raw-Buffer bug) awaiting J2 PR/QA. PDF was the last item in Barat's lane | PDF merged; buffer-fix awaiting QA |
| Mugi | M1 | Deferred — production UI/UX from the ADR-011 reference frontend (later) | parked |

## Feature status (personal M1)
- ✅ Merged: #2 Excel · #4 OCR · #5 anomaly · #6 categorization · #8 reports · #10 currency · #11 low-confidence · #12 template engine · ingestion wiring (#22) · #9 agent Phase 1 (#25) · `groqChatTools()` (#26) · **#7 mass upload both surfaces** (#28/#29/#32) · issue #30 fix (#34)
- 🔄 In build: **#1 PDF** — `lib/pdf.js` rasterizer + Telegram path (Barat, `feature/barat-p4-pdf`); route glue (J1, after)
- ⏳ To do: #3 dashboard (Mugi), ADR-011 reference frontend

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| **OPEN VERIFICATION — inspect Barat's actual Supabase project (`xurnpvesgcybrnilxszf`).** Before integration: confirm its `expenses` table matches standalone `schema.sql` (scoped by **`account_id`** text, `expense_date` as **TEXT**, has the 6 feature columns `confidence`/`anomaly`/`amount_original`/`currency_original`/`fx_rate`/`template_id`, plus `field_templates` + `category_corrections` tables) and that the receipt data isn't commingled with unrelated data. **NOTE:** the MCP Supabase connector here is authed to Jeevan's OWN org (project `fziaxuhonvrhqjulhcyu` = Jeevan's CRM bot, NOT this app) and cannot reach Barat's project (permission denied) — so this must be verified by Barat directly, or by re-authing the connector with a token that has access to `xurnpvesgcybrnilxszf`. (An earlier scan mistakenly inspected Jeevan's CRM project and was retracted.) | Barat/Owner | verify before integration |
| **LAUNCH GATE (ADR-015):** no real user onboarded until (a) every secret is rotated post-dev-exposure AND (b) Jeevan holds an independent Supabase backup outside the account | Owner/Barat | tracked, blocks any real-user launch |
| Barat's `lib/pdf.js` PR — not yet open; check `gh pr list` | Barat/J1 | in build |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| exceljs transitive `uuid` audit bump (GitHub issue #20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## GOTCHA (new this session)
A feature branch showing failing tests right after merging `main` in isn't necessarily a real bug — if a dependency was added to `package.json` on `main` after your branch forked, your local `node_modules` may just be missing it. **Always `npm install` before diagnosing "post-merge" test failures.** (PR #22 was nearly treated as blocked on a real bug; it was a stale `node_modules`.)

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
