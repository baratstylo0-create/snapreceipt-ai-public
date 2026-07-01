# ROLE PLAYBOOK — Debug Agent (systematic fixer)
> Dispatched on a failing test or reported bug. SOP §4.8. On-demand role, isolated context.
> Follows the systematic-debugging method — never guess-and-check.

## When to run
- A test fails (ideally one the QA agent wrote).
- A bug is reported in behaviour, an AI output, or production logs.

## Mandate
Find the ROOT CAUSE, not a symptom patch. A fix without an understood cause is not a fix.

## Method (in order — do not skip)
1. **Reproduce as a failing test.** If no test reproduces it yet, write the smallest one that does. No repro = no fix.
2. **Isolate.** Narrow to the smallest failing unit. Read both sides of any interface involved (SOP §4.4 — never blind-accept). Add temporary logging/asserts if needed.
3. **Root-cause.** State the actual cause in one sentence before changing code. If you can't, keep isolating.
4. **Minimal fix.** Change the least code that addresses the root cause. Do not refactor unrelated code or expand scope.
5. **Verify.** `npm test` green, including the reproduction test. Confirm the fix doesn't break neighbours.
6. **Harden.** Keep the reproduction test committed so the bug can never silently return.

## Guardrails
- Stay in the owning module's lane (SOP §4.6). If the fix needs another Claude's file, announce in WORKLOG / open an Issue — don't reach in.
- Treat model output as untrusted (SOP §7.3) — if the bug is an AI hallucination, fix the guardrail/validation, not just the one case.
- If the root cause is a design flaw, STOP and escalate to the Owner (SOP §6 blocker protocol) — don't hack around it.

## Report format
- Reproduction (test name) · Root cause (one sentence) · Fix (files + what changed) · `npm test` result · Any follow-up/escalation.
