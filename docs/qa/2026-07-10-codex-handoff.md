# Codex hand-off — 2026-07-10 (QA/review + dashboard bulk-upload parity)

> Owner-directed (Jeevan). GPT-5.5/Codex is back; splitting the remaining work three ways
> (Claude-J, Barat, Codex). Same standing rules as every round: `docs/FRICTION_PROJECT_SOP.md`,
> `CLAUDE.md`, `AGENTS.md`, frozen interfaces (`docs/ARCHITECTURE.md` §3). **TDD** — every fix ships
> with a test. **`.env` move-aside before `node --test`** (`mv .env .env.local.bak` … restore after);
> suite is currently **1657** green on the A3 branch (baseline `main` = 1644). **No direct-to-main**
> (pre-push blocks it). **Do not merge — Claude-J reviews + merges** (Owner names every merge).

Codex has **two tracks**. Do Track 1 first (it unblocks merges), then Track 2.

---

## Track 1 — QA / review / debug the open PRs (do this first)

No human reviewer is available, so these six PRs are the bottleneck. For **each**: check out the
branch, read the diff, run the full suite (`.env` aside), and hunt for **correctness / security /
scope-isolation / edge-case** bugs. This is the same independent-review discipline you used for the
PR-154 review (`docs/reviews/2026-07-09-pr154-independent-review.md`) — verify claims yourself, don't
take the PR description's word for it.

Open PRs to review (all authored by Claude-J unless noted):

| PR | Branch | What it does | Watch for |
|----|--------|--------------|-----------|
| #160 | `qa/pr-g-rejected` | B9 rejected→recategorise chevron + B8 one-click permanent delete | B8 is a **hard delete** (`sbHardDelete`) restricted to `status='rejected'` — confirm the status gate can't be bypassed and clerk branch-scope holds |
| #161 | `qa/pr-h-recently-deleted` | B7 recently-deleted bin + Recover | `GET /api/expenses/deleted` + `POST /:id/restore` — confirm scope filter (clerk own-branch) on BOTH; restore refuses a non-deleted row |
| #165 | `qa/pr-i-bulk-select` | B4 bulk Approve/Delete | `POST /api/review/bulk` + `POST /api/expenses/bulk-delete` — per-id scope check, id cap (413), partial-failure semantics |
| #167 | `qa/pr-a3-review-reminder` | conditional pre-export reminder (info + Review + Download anyway) | `runExportGuard` fail-open on `/api/review` error; the "Review" nav uses `deps.switchView` |
| #169 | `qa/review-card-details` | review-queue cards show receipt thumbnail + meta | XSS: all untrusted fields via `Escape.setText`; thumbnail auth-fetch |
| #163 | `docs/assign-pr-k-to-barat` | doc-only (STATUS.md note) | trivial |

Also worth a pass if you have time: Barat's **#166** (Telegram D10–D13) and **#168** (batch/album capture).

**Output:** post findings as PR comments (or a `docs/reviews/2026-07-10-*.md` file, your call). Where a
bug is **clear and confined to that branch**, push a fix commit to the **same branch** (don't open a
new PR for it). Flag anything uncertain instead of guessing. **Do not merge.**

NB these six PRs all touch overlapping files (several touch `activity.js` / `routes/expenses.js`); a
trivial rebase between them at merge time is expected and is Claude-J's problem, not yours.

---

## Track 2 — Build: dashboard bulk-upload parity (issue #153)

Full spec in **issue #153** — read it in full first. Summary of the ask (Jeevan-lane:
`public/js/components/upload.js`, `routes/upload.js`, and a new bulk staff-assign endpoint in
`routes/expenses.js`):

1. **Staff attribution (the real gap).** `routes/upload.js` leaves `staff_user_id` null in v1 and there
   is no assign-staff control anywhere. Add: after a bulk upload, saved rows land in a reviewable grid
   with a **per-row staff dropdown** + **multi-select "assign selected → [staff]"**. Reuse the payments
   multi-select model (`public/js/components/payments.js`), **do not** pop N modals at upload time.
2. **Duplicate presentation.** Dups already surface under "Flagged for review"; upgrade the line to
   **name the existing row + View / Discard** (deep-link within the SPA).
3. **One assign API.** Staff assignment goes through **one** bulk endpoint — a branch-scoped
   `PATCH`/bulk on expenses setting `staff_user_id`, enforcing the M2 isolation contract
   (`lib/auth.scopeForUser` / `lib/supabase.scopeEq` — a clerk can only assign within their own branch).
   Used by both the grid dropdown and the bulk action.

**Coordination flags (raise in the PR, don't silently cross lanes):**
- The **image content-hash dedup column** in #153 is a **schema change** → `schema.sql` is **Barat's**
  lane and the bot side (#152) feeds the same column. **Do not add the column yourself** — coordinate
  with Barat, or scope your PR to the staff-attribution + duplicate-presentation parts and leave the
  cross-channel content-hash for a follow-up. Flag this decision in the PR body.
- Your new bulk staff-assign endpoint lands in `routes/expenses.js` **alongside Claude-J's open PRs
  #160/#161/#165** (which also add endpoints there). Expect a trivial merge-order rebase; branch off
  **current `main`** regardless.

**Not in scope:** the Telegram-bot batch/album side (#152) — that's Barat (#168). `team.js` — done, don't
touch. The staff-picker-scaling issue #151 — that's Barat (`lib/bot.js`).

---

## Definition of done (per PR)
- Each item implemented with a test; full suite green (`.env` moved aside).
- PR body lists the issue/QA IDs closed + every coordination flag raised (content-hash schema, endpoint collision).
- No direct-to-main; do not merge your own PR — Claude-J reviews and merges.
