# STATUS — Receipt Analyser SaaS
> Current phase, sprint goal, blockers, who's on what. **Every Claude updates this.**

## Current phase
**P4 — Features.** ✅ P3 infra complete. ✅ **PR #9 (templates FieldSpec, #12) MERGED to `main`** — shared contract live. Feature work now open off `main`. In flight: PR #8 (reports #8, QA re-review) + PR #6 (categorization #6, review).

## Track
Vertical AI Solution. Milestone M1 = Personal version (12 features).

## Sprint goal (current)
P3 data & infra foundation: schema migrated, secrets wired + verified live, model routing locked. Next: sync Barat's infra PR onto merged `main`, land the `lib/config.js` vision-default fix, then begin OCR-coupled features off the modularized base.

## Who's on what
| Person | Claude | Current task | Branch | State |
|---|---|---|---|---|
| Jeevan | J1 | #8 reports — QA fixes pushed (truncation surfaced, strict dates, +tests) | `feature/jeevan-p4-reports` | PR #8 open, QA re-review |
| Jeevan | J2 | #6 categorization — LLM-supervised learning categorizer built, 50/50 tests, migration handed to Barat | `feature/jeevan-p4-categorize` | PR #6 open, review |
| Barat | B1 | #12 templates MERGED (PR #9). Next = apply `db/2026-07-01-category_corrections.sql` + wire `categorizeLineItems` into `lib/ocr.js` (#4/#1/#11) | — | active |
| Mugi | M1 | Not started — deferred (no repo access yet) | — | parked |

## Blockers
| Blocker | Owner | Status |
|---|---|---|
| Brief GO sign-off | Jeevan | ✅ DONE |
| GitHub remote + Barat collaborator | Jeevan | ✅ DONE (`baratstylo0-create`) |
| AI monthly cost cap | Jeevan | ✅ DONE (provisional $50/mo dev) |
| Merge modularization PR (unblocks lib/* + features) | Jeevan | ✅ DONE (merged to main) |
| Credentials → fill `.env` | Jeevan→Barat | ✅ DONE — filled, all keys verified live |
| Vision model routing (scout alive? maverick gone — ADR-007) | Barat | ✅ DONE — qwen/qwen3.6-27b both slots, Owner-confirmed |
| Apply schema.sql in Supabase | Barat | ✅ DONE — applied + REST-verified (6 new cols, field_templates, insert→read→delete round-trip) |
| Sync stale `feature/barat-p3-infra-schema` onto merged main | Barat | IN PROGRESS — merge done, resolving doc conflicts |
| `lib/config.js` still defaults `visionEscalate` to dead maverick id | Barat | OPEN — fix in this infra PR (env overrides it, no runtime break) |
| Invite Jeevan as Supabase project member | Owner | NOT NEEDED — owner runs Supabase solo; optional later for backup access |
| Mugi GitHub username (only when he starts) | Jeevan | deferred |

## Definition of Done — P3 infra
- [x] Modularization merged; `lib/` + `routes/` + tests on `main`
- [x] Schema migrated (field_templates + 6 expense columns) and verified
- [x] Secrets wired in `.env` (git-ignored) and verified live
- [x] Model routing finalized + documented (ADR-007)
- [ ] Barat's infra PR synced onto main, reviewed (Tier-2: schema/migration per SOP §4.7), merged by Owner
- [ ] `lib/config.js` vision-default cleaned of dead maverick id

## Not doing this sprint
Any of the 12 feature implementations, business-account layer, billing, hosting choice.
