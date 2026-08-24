# Agent cross-review workflow

**Status:** proposed by Claude-P, 2026-08-24. Complements `docs/COLLABORATION_AND_RELEASE_GOVERNANCE.md`
(integration-owned; this file does not modify it). Adopt, amend or reject via the usual PR route.

---

## 1. Why this exists

On the first day of the full-app program the repository reached **12 open PRs, 0 reviews, 0 merges**.
Seven of those PRs were opened that day by two AI agents. `main` had not moved.

That is not an accident of scheduling. It is structural:

- Every Tier-2 PR requires an **independent, non-author** reviewer.
- Exactly two people can be that reviewer — Jeevan and Barat — and both are also primary implementers
  carrying a full lane each.
- Two AI agents produce Tier-2 security PRs considerably faster than two part-time humans can review
  them.

The execution plan allocates 34 points of *building* per lane and gives review a single line
("cross-lane review duty is additional and rotates"). Build capacity was planned; review capacity was
assumed. **Review is the binding constraint on this program**, and the fix has to reduce human review
load, not add more building.

## 2. What this is — and what it is not

**It is:** a mandatory cross-lane pre-review pass by an agent that did not author the change, performed
*before* a human is asked to look.

**It is not** the Tier-2 approval. Governance is explicit and unchanged:

> AI agents may implement, test, review and prepare PRs. They do not receive independent production
> authority and may not approve their own Tier-2 work.

So an agent pre-review:

- **never** counts as the independent approving review;
- **never** unblocks a merge;
- **never** replaces device testing, security sign-off, or human judgement about product trade-offs.

What it does is ensure that by the time a human opens the PR, the mechanical findings are already
raised and answered, and the human's scarce attention goes to the things only a human can decide.

## 3. Trigger and flow

```
Agent opens PR (draft)
        |
        v
  Cross-lane agent pre-review        <-- this workflow
        |
        +-- findings posted as a PR comment
        |
        v
  Author agent responds: fixes, or disagrees with reasoning
        |
        v
  PR marked ready  ->  human Tier-2 review  ->  Jeevan or Barat merges
```

**Every PR labelled `agent:*` gets a pre-review before it is marked ready for human review.**

### Who reviews whom

| Author lane | Pre-reviewer |
|---|---|
| Platform (`agent:claude-platform`) | Codex |
| Mobile / integration (Codex) | Claude-P |

Neither agent ever pre-reviews its own lane's work. If a third agent joins, rotate so no pair becomes
the only path.

## 4. What a cross-lane reviewer should look for

Single-lane review misses a specific class of defect. Target these first — they are worth more than a
general read-through.

### 4.1 Cross-PR interactions

Two PRs, each correct alone, that break each other on merge. **This is the highest-value category and
the one nobody reviewing a single PR can see.**

*Real example from this repo:* M-03 set `FLAG_SECURE` **before** `super.onCreate()` so it applied
before the WebView existed. M-01 rewrote the same `onCreate` with `super.onCreate()` **first**. Whoever
merged second would resolve into one method — and the natural resolution silently drops the ordering
guarantee. M-03's test asserted only that the string `FLAG_SECURE` appeared *somewhere in the file*, so
it would still have passed. A security control degraded by a merge, with a green test.

Ask: *does this PR touch a method, file or contract another open PR also touches, and does the merge
preserve the guarantee — not just the text?*

### 4.2 Contract drift between lanes

One lane's assumption about another lane's interface, made without checking. Frozen API shapes,
session contracts, error schemas, capability flags.

Ask: *does this PR assume something about another lane that is written down somewhere — and is what is
written down still true?*

### 4.3 Tests that assert presence, not behaviour

A test that greps for a string passes whether the code works, is unreachable, or has been reordered
into uselessness.

Ask: *would this test fail if the control it guards were quietly removed or bypassed?* If not, say so
and propose the assertion that would.

### 4.4 Security controls that can silently degrade

Anything where the failure mode is "still compiles, still passes, no longer protects": ordering
guarantees, filter predicates folded into a WHERE clause, fail-open branches, defaults that flip.

### 4.5 Claims in the PR body that the diff does not support

Check two or three specific claims against the actual diff. Governance already says the receiving
account "must not trust a prose handoff over the actual diff and test results" — this is where that
gets enforced.

### 4.6 Scope creep past the lane boundary

Files outside the author's ownership, or shared files edited without the integration-owner note that
rule 6 requires.

## 5. Output format

Post one comment on the PR. Open with:

> **Cross-lane agent pre-review (\<agent\>) — not the Tier-2 approval**

Then, per finding:

1. **What** is wrong, concretely, with the file and the line.
2. **Why** it matters — the failure it produces, not a style preference.
3. **A suggested fix**, ideally as code.

Rules for the reviewer:

- **Finding nothing is a legitimate result.** Never manufacture findings to look thorough. "This is
  solid, here is what I checked" is a useful review.
- **Separate defects from decisions.** "This is a bug" and "this is a product trade-off that needs the
  Owner" are different, and conflating them wastes the author's time.
- **Say what you did not check.** A pre-review that does not cover device behaviour should say so, so
  nobody reads it as broader assurance than it is.

## 6. How the author responds

The author agent either fixes the finding or **disagrees with concrete reasoning**. Governance already
covers the receiving side:

> It must not trust a prose handoff over the actual diff and test results.

Blind agreement is as unhelpful as blind rejection. If a finding is wrong, say why — the reviewer may
have missed context, and that exchange is itself worth having in the PR record.

Unresolved disagreement escalates to Jeevan with both positions stated. It does not get silently
dropped by either side.

## 7. WIP limit

Pre-review only helps if the queue is bounded. Proposed alongside this workflow:

**At most 2 open Tier-2 PRs per lane.** An agent at the cap stops opening new feature PRs and instead:

1. pre-reviews the other lane's queue;
2. rebases its own queued branches;
3. writes the decision docs blocking its own next ticket;
4. reports that it is blocked on review — visibly, not silently.

A stalled queue is information. An agent that keeps building into one is hiding it.

## 8. Practices worth carrying across lanes

Two things that produced real findings in the platform lane and cost very little:

**Mutation testing on any security-relevant test suite.** After the suite is green, delete each control
it claims to defend and confirm the suite turns red. In this repo it caught two suites that could not
detect a deleted control, and one genuine bug (`Number(null) === 0`, so a null response body read as a
real count of zero) that ordinary review had missed.

**Verify the mutation actually applied.** Twice, a mutation harness silently failed to apply and
reported every mutation as "caught". A harness that does not exit non-zero when its edit fails to land
will tell you your tests are excellent when you have tested nothing.

## 9. Optional automation

This workflow is process, not tooling, and works with no CI change. If it proves useful, a small GitHub
Action could reduce the bookkeeping: on a PR labelled `agent:*` being marked ready for review, check
whether a comment beginning "Cross-lane agent pre-review" exists, and if not, post a reminder. That is
a nudge, not a gate — a gate would need bot write access and could block the humans it is meant to help.

Deliberately **not** proposed: any automation that marks a PR approved. Approval stays human.
