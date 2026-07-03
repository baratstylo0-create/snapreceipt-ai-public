# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P5/P6 — Reference frontend + security hardening.** All 12 M1 backend features + #1 PDF (both surfaces) merged to `main` (`360` passing there). Active work is on **`feature/jeevan-p5-frontend`** (not yet merged, **522 passing** on-branch): Tasks 0/A–G of `docs/plans/2026-07-02-reference-frontend-qa-security.md` are **DONE** (shell+CSP+auth gate, Overview, Activity, Upload incl. PDFs, Templates, Reports+Excel, Agent chat) plus a Finexy-style visual pass. Verified live in a browser preview — clean render, zero console errors, CSP holds. **Barat's P6 lane also DONE + merged** (PR #42: rate limiting, webhook-secret test, control-char strip, Telegram bot QA checklist). Remaining on the plan: **Task H (security hardening — `/receipt/:fileId` auth gate, `checkDash` fail-closed, CORS tighten, reuse `lib/ratelimit.js`)**, then I/J/K (QA checklist, independent security-QA, live runbook).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
**Finish the frontend/security plan, then merge `feature/jeevan-p5-frontend`.** Next: J1's **Task H** (dashboard-side hardening — the two real findings: unauthenticated `/receipt/:fileId`, fail-open `checkDash`). Barat's Telegram live-QA is his own to run (has the creds) whenever he's able — not blocking. A new idea floated by Owner: **Groq API key rotation across multiple accounts** (Barat's + Jeevan's 2 + Mugi's) to multiply the free-tier daily cap — same model, no quality loss, purely a quota pool via the existing 429-retry loop in `lib/groq.js`. Design pending a short brainstorm + ADR; touches Barat's frozen file, so needs his sign-off. Slotted in after Task H.

## Who's on what
| Person | Claude | Current task | State |
|---|---|---|---|
| Jeevan | J1 | Frontend Tasks 0–G done (522 tests). Next: **Task H** hardening on his own route files + `server.js` | building Task H |
| Barat | B1/B2 | **P6 lane DONE + merged (PR #42).** Schema verification 4/5 confirmed (item 5 — no foreign data — pending a live re-scan when his tools are back). Telegram live-QA run his own to schedule | idle / available for live-QA + schema re-check |
| Mugi | M1 | Deferred — production UI/UX from this reference frontend, after it merges | parked |

## Feature status (personal M1)
- ✅ All 12 backend features + #1 PDF (both surfaces) merged to `main`.
- 🔄 In build (branch `feature/jeevan-p5-frontend`, not yet merged): reference frontend Tasks 0–G done; **Task H hardening next**; I/J/K (QA + security-QA + live runbook) queued.
- ⏳ To do: #3 dashboard (Mugi, from the reference frontend once merged); Groq multi-key rotation (design pending).

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| **SCHEMA VERIFICATION (2026-07-02, Barat) — 4/5 PASS, 1 pending.** ✅ account_id-text scoping (no tenant_id) · ✅ expense_date TEXT · ✅ 6 feature columns (confidence/anomaly/amount_original/currency_original/fx_rate/template_id) · ✅ field_templates + category_corrections tables — all confirmed via schema.sql + Barat's earlier live insert/read. ⚠️ **Item 5 (no unrelated/foreign-product data commingled) NOT YET RE-CONFIRMED LIVE** — Barat's query tools were in read-only mode when asked; he'll run one live table-list scan the moment they're back. Not a red flag (nothing foreign has ever surfaced), just an open re-check. | Barat | item 5 pending, re-scan when able |
| **LAUNCH GATE (ADR-015):** no real user onboarded until (a) every secret is rotated post-dev-exposure AND (b) Jeevan holds an independent Supabase backup outside the account | Owner/Barat | tracked, blocks any real-user launch |
| #6 categorizer hardening (GitHub issue #14) | Jeevan | tracked, non-blocking |
| `/api/templates` label sanitization + control-char rejection (GitHub issue #17) | Jeevan/Mugi | tracked, non-blocking |
| exceljs transitive `uuid` audit bump (GitHub issue #20) | Jeevan | tracked, non-blocking |
| Mugi GitHub username | Jeevan | deferred until he starts |

## GOTCHA (new this session)
A feature branch showing failing tests right after merging `main` in isn't necessarily a real bug — if a dependency was added to `package.json` on `main` after your branch forked, your local `node_modules` may just be missing it. **Always `npm install` before diagnosing "post-merge" test failures.** (PR #22 was nearly treated as blocked on a real bug; it was a stale `node_modules`.)

## Not doing yet
Business-account layer (business Excel template parked; personal M1 first per SOP), billing, hosting. Reference frontend (ADR-011) = after core backend features merge.
