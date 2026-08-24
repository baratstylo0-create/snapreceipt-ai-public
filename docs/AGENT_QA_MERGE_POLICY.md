# Agent-QA merge policy

**Status:** adopted 2026-08-25 by explicit Owner (Jeevan) direction, superseding the
"independent human Tier-2 reviewer" requirement in
`docs/COLLABORATION_AND_RELEASE_GOVERNANCE.md` for the scope defined below. This file is the
record of that decision — governance docs are updated separately; until they are, this file
is authoritative for what it covers.

## Why this changed

By the end of day one of the full-app program, the review-capacity mismatch predicted in the
plan critique (comment on #17) was already visible: 8+ PRs open, zero independent human
reviews, and the first merge that happened was an owner override that skipped the review step
governance called for — under real backlog pressure, not as an edge case. Two AI agents
produce Tier-2 output faster than two part-time human reviewers can read it. Holding the old
gate literally would mean either the humans review nothing else this week, or the bypass
that already happened becomes the norm anyway, just unrecorded.

The Owner's judgment, and the one this policy encodes: **agent cross-review, grounded in
research and backed by adversarial subagent QA, is a better first pass than most single-human
review** — today's pass caught a cross-PR security regression, a URI-confusion vulnerability,
and two real logic bugs, all before any human looked. What agent review cannot do is notice
the failure modes that never surface in normal use — an auth bypass, a cross-tenant leak, a
silent data-integrity break. Those don't announce themselves to a user clicking around; they
announce themselves when exploited, by which point a log is a post-mortem, not a safeguard.
So the gate narrows to exactly that gap, not the whole review.

## The policy

**Default gate — agent QA, no human review required to merge:**

1. Author agent builds, with its own tests and, for anything security- or logic-critical,
   mutation-testing that proves the tests actually catch the property they claim to (see
   `docs/AGENT_CROSS_REVIEW.md` §8 — this is not optional polish, it is load-bearing evidence).
2. A **different** agent (never the author, never the same lane) performs the cross-lane
   pre-review defined in `docs/AGENT_CROSS_REVIEW.md`: full diff read, claims checked against
   the actual code, cross-PR interaction check, research pulled in where the change touches a
   pattern with known pitfalls (auth, crypto, file/URI handling, injection surfaces — cite
   what was checked, e.g. OWASP guidance, the relevant CWE, platform docs).
3. Findings get resolved: fixed, or answered with reasoning the reviewing agent accepts.
4. CI green, no secrets in the diff, WORKLOG/schema fragment added correctly (see below).
5. **Merge.** Jeevan or Barat pushes the button; this is procedural at this point, not a
   second full read of the diff — the review already happened.

**Escalation — a human decision is required before merge, not after:**

- Any finding the reviewing agent rates **HIGH severity or above** and cannot resolve with
  confidence in-thread. (Example already in flight: #54's shared-URI-opened-with-app's-own-
  permissions finding — flagged, not silently fixed, because the blast radius needs a human
  call on whether the mitigation is sufficient before it ships.)
- Any change in **Tier 3** as already defined in `COLLABORATION_AND_RELEASE_GOVERNANCE.md`:
  production data mutation, secret/key rotation, live migration, signing-key recovery,
  incident action. **This policy does not touch Tier 3.** Two humans, explicit approval,
  unchanged.
- Anything that is a genuine product, legal, or architecture decision rather than a defect —
  agents flag these explicitly as "decision, not bug" (per `AGENT_CROSS_REVIEW.md` §5) and
  route them to the Owner rather than silently picking a side.

When escalation fires, the agent **opens the specific thing for the human** — the exact PR
comment or file, with a one-paragraph "here is what to look at and why," not a bare link and
a diff to read cold. That's the standing instruction this file also records.

## The safety net this policy leans on — and its current gap

The premise "you'll notice in normal use, and there will be logs to check" requires two
things that are **not both true yet**:

- **Structured, monitorable production logs and alerting** — this is **P-08** (`docs/FULL_APP_EXECUTION_PLAN.md`,
  issue #41), currently open, not built. `lib/log.js` and `lib/security-events.js` exist and
  emit structured lines today, but nothing aggregates, alerts on, or is regularly reviewed
  from them yet. Until P-08 lands, "check the logs" is aspirational for anything that doesn't
  also produce a visible symptom.
- **Someone actually using the affected surface regularly enough to notice** — true for
  everyday flows (dashboard, upload, expenses), not true for surfaces an attacker reaches
  before a legitimate user does (a share-intent from another app, a crafted API request).

**This is not a reason to keep the old gate.** It is a reason the HIGH-severity escalation
path above exists, and a reason P-08 should not keep sliding — it is the other half of what
makes "ship on agent QA, catch the rest via monitoring" actually true rather than aspirational.

## Changelog/schema conflicts — fixed alongside this policy

The mechanical accelerant behind today's review backlog was partly the git-conflict tax: every
PR touching `docs/WORKLOG.md` or `schema.sql` collided with every other PR touching the same
file, regardless of whether their actual code overlapped — three separate rebase rounds on the
same three PRs in one day, purely from adjacency, not real conflicts. Fixed by
`scripts/consolidate-changelog.js` and the `docs/worklog/pending/` / `db/migrations/pending/`
convention (see their own READMEs) — new entries are now separate files that can never collide,
folded into the canonical files by whoever merges, as a single-actor step that never itself
needs conflict resolution.

## What this does not change

- Tier 1 (docs, copy, isolated CSS, tests-only) was already low-ceremony; unaffected.
- Tier 3 is untouched, see above.
- File ownership and the collision rules in `COLLABORATION_AND_RELEASE_GOVERNANCE.md` §"Branch
  and task rules" are unchanged — an agent still does not edit another lane's owned files
  without a note.
- Nothing here authorizes an agent to merge its own work. Jeevan or Barat still performs the
  merge action itself; what changed is that it no longer waits on a full independent re-read
  of a diff the cross-review already covered.
