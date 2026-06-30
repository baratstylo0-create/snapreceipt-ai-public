# FRICTION_PROJECT_SOP.md — Master Operating SOP

> **This is the constitution.** Every Claude Code instance and every human working on a
> Friction project MUST read this file in full **before touching anything**. If a request
> conflicts with this document, STOP and ask the Repo Owner. This file overrides
> convenience, speed, and "it's just a small change."
>
> **Purpose:** Build vertical AI solutions and horizontal SaaS that are *provably legit* —
> not vibe-coded. Safe, secure, documented, and impossible for multiple Claude Codes to
> drift apart on.

---

## 0. How to use this document

1. On session start, a Claude Code instance reads, in order:
   1. This file (`FRICTION_PROJECT_SOP.md`)
   2. The repo's `CLAUDE.md` (project-specific, may override stack details only — **never** safety/git rules)
   3. `docs/PROJECT_BRIEF.md` (the filled intake — if missing or incomplete, **do not write code**)
   4. `docs/WORKLOG.md` (what every other Claude/human has done — the sync ledger)
   5. `docs/STATUS.md` (current phase, current sprint, open blockers)
   6. Open GitHub Issues + open PRs (the live task board)
2. Only then may it act — and only within its **claimed task**.

**Precedence order (highest wins):**
`Repo Owner's explicit instruction` → `this SOP` → `repo CLAUDE.md` → `defaults`.

---

## 1. Non-negotiable principles (the "we are not vibe coders" rules)

1. **No phase is skipped, and phases run in order.** See §5. Idea → Frontend with nothing in
   between is forbidden. The 16-layer stack in the company reference image is the law.
2. **No code before the Project Brief is 100% complete and signed off.** Brainstorming and
   information-gathering finish *first*. Half-known requirements = stop.
3. **Every layer is gated.** A phase is "done" only when its Phase Gate checklist passes
   (`templates/02_PHASE_GATE_CHECKLIST.md`). No self-certifying past a gate.
4. **Security is not a phase you reach — it is a constraint on every line.** Assume hackers
   will probe everything. Treat all input (including AI/model output) as hostile until validated.
5. **`main` is protected: changes reach it only through a reviewed PR — never a direct push.**
   Merges to `main` are restricted to the **Repo Owner or a named Deputy** (the Owner's backup
   for when they're away — see §2). **Worker Claudes never merge to `main` unattended**, and no
   one — Owner included — pushes to `main` directly, bypassing review. See §4.
6. **One task = one branch = one PR.** No mixing concerns.
7. **Every push updates the WORKLOG.** A Claude that pushed without logging it does not exist
   to the other Claudes — that is how drift happens.
8. **If unsure, stop and ask. Throwing away cheap code is fine; shipping wrong/unsafe code is not.**

---

## 2. Roles

| Role | Who | Can do | Cannot do |
|---|---|---|---|
| **Repo Owner** | The human who created the repo | Merge approved PRs to `main`, approve PRs, set protection, sign off gates, name a Deputy | Push to `main` directly, bypassing PR review |
| **Deputy** | A trusted teammate the Owner names per repo | Approve + merge PRs to `main` **when the Owner is unavailable**; same review bar | Push to `main` directly; change scope/stack |
| **Human Reviewer** | Teammate (when team = 2–3) | Review PRs, fill briefs, plan sprints | Merge to `main` unless they are the Owner or named Deputy |
| **Lead Claude** | The Claude assigned to coordinate | Plan, split tasks, update STATUS/WORKLOG, open PRs | Merge to `main`, invent stack/scope |
| **Worker Claude** | Any Claude on a feature branch | Implement its claimed task on its branch, push, open PR | Touch `main`, touch another Claude's branch, change scope, add deps without approval |

> Team size varies (1–3 humans). When solo, one human is Repo Owner + Reviewer, but the
> **gates and git discipline still apply** — they are what make a solo build look and behave
> like a real engineering org.

---

## 3. Decision tree: what kind of project is this?

Before planning, classify the project. This decides which "must-do" baseline applies.

```
Is the deliverable an AI capability (agent, RAG, model pipeline, automation)?
 ├─ YES → VERTICAL AI SOLUTION track
 │        + add AI-specific layers: data sourcing, prompt/guardrail design,
 │          eval suite, model routing + cost budget, hallucination/PII handling,
 │          prompt-injection defense, human-in-the-loop fallback.
 └─ NO / mostly app → HORIZONTAL SaaS track
          + standard 16-layer stack, multi-tenant from day one if SaaS.

Is it regulated data (health, finance, minors, biometric, EU personal data)?
 ├─ YES → COMPLIANCE PACK required (see §7.4) before Phase 3.
 └─ NO  → standard security baseline.
```

The chosen track is recorded in the Project Brief and dictates the Phase Gate checklist used.

---

## 4. Git & GitHub discipline (how multiple Claude Codes stay in sync)

This section exists to guarantee that **no Claude drifts the project**.

### 4.1 Branch model
- `main` — protected. Merges via reviewed PR only, by **Owner or named Deputy**. Always deployable. Never worked on or pushed to directly.
- `develop` — integration branch (optional for larger projects); PRs target here, Owner promotes to `main`.
- `feature/<phase>-<area>-<short-desc>` — all worker branches. One task each.
  - e.g. `feature/p4-auth-jwt-refresh`, `feature/p5-frontend-dashboard`.
- `fix/<short-desc>`, `chore/<short-desc>` — same rules.

### 4.2 The mandatory pre-work ritual (every Claude, every time before coding)
```
1. git fetch --all --prune
2. git pull (the base branch you branch from)
3. Read docs/WORKLOG.md  → what did others touch?
4. Read docs/STATUS.md   → current phase, sprint goal, blockers
5. Check open PRs + Issues → is my task already claimed/in-flight?
6. Claim my task on the board (assign the Issue to yourself / mark in STATUS.md)
7. Create my feature branch FROM the agreed base, never from a stale local copy
```
**Skipping this ritual is the #1 cause of drift and is a gate failure.**

### 4.3 The mandatory post-work ritual (every push)
```
1. Small, focused commits with clear messages (Conventional Commits style):
   feat:, fix:, chore:, docs:, test:, refactor:
2. Push to YOUR feature branch only.
3. Update docs/WORKLOG.md: date, who (which Claude/human), branch, files touched,
   what changed, what's next, any new assumption.
4. Open/update a PR targeting develop (or main if no develop). Never self-merge.
5. Note blockers in docs/STATUS.md and templates/03... if blocked.
```

### 4.4 Hard prohibitions
- ❌ Never push directly to `main` — not even the Owner. All changes go through a reviewed PR.
- ❌ Worker Claudes/humans never merge to `main`; only the Owner or named Deputy merges approved PRs.
- ❌ Never `git push --force` on a shared branch.
- ❌ Never check out, edit, or rebase **another Claude's** active branch.
- ❌ Never merge your own PR.
- ❌ Never resolve conflicts by blindly accepting "ours/theirs" — read both sides, ask if unsure.
- ❌ Never commit secrets, `.env`, keys, tokens, or real customer data.

### 4.5 Local enforcement (works without paid GitHub protection)
- Every repo ships a **pre-push hook** (`.githooks/pre-push`, activated via `core.hooksPath`)
  that **blocks direct pushes to `main`/`develop` locally** — so the rule holds even on a free
  private repo where server-side branch protection isn't available.
- `core.hooksPath` is a *local* git setting: **each teammate runs `setup-git-hooks.ps1` once
  after cloning** to activate it on their machine.
- Genuine-emergency override is `git push --no-verify` — allowed, but you **must** log it in
  `docs/WORKLOG.md` with the reason. Routine use of the override is a gate failure.
- Where available (paid plans / public repos), `setup-branch-protection.ps1` adds the
  server-side rule on top, so the protection isn't bypassable by skipping the hook.

### 4.6 Conflict & collision avoidance
- The Project Brief contains a **Module Ownership Map** (which area each branch/Claude owns).
  Two Claudes must not edit the same module simultaneously.
- If you must touch shared code (e.g. a shared type), announce it in WORKLOG **before** editing
  and keep the change minimal.
- Rebase your feature branch onto the latest base **before** opening/refreshing a PR.

---

## 5. The phase model (ordered, gated — mirrors the 16-layer stack)

Phases run **top to bottom**. You may not enter a phase until the previous gate passes.
Cross-cutting concerns (**security, version control, documentation, testing**) apply in
*every* phase, not just their named one.

| # | Phase | Stack layers covered | Exit gate proves… |
|---|---|---|---|
| **P0** | **Intake & Brainstorm** | — | Brief 100% filled, track chosen, scope frozen |
| **P1** | **Plan & Design** | system design, system architecture | Architecture doc, data model sketch, threat model |
| **P2** | **Setup** | CI/CD & version control, hosting baseline | Repo, branch protection, env template, CI skeleton, CLAUDE.md |
| **P3** | **Data & Auth foundation** | databases & storage, auth & permissions | Schema migrated, authZ on every entity, no secrets in repo |
| **P4** | **Backend** | APIs & backend logic, rate limiting (design) | Endpoints validated, parameterized queries, authZ enforced, tests |
| **P5** | **Frontend** | frontend | UI wired to API, input validation, no secrets client-side |
| **P6** | **Hardening** | security, rate limiting, caching & CDN | Security review passed, limits live, no injection vectors |
| **P7** | **Observability** | error tracking & logs, monitoring & alerts | Logs (no PII), error tracking, alerts on key paths |
| **P8** | **Testing & QA** | testing | Unit/integration/e2e + (AI track) eval suite green |
| **P9** | **Ship & Operate** | hosting & cloud, scaling | Deploy pipeline, rollback plan, runbook, scaling plan |

> **AI / Vertical track inserts between P3 and P8:** data sourcing & quality, prompt &
> guardrail design, **evaluation suite** (accuracy/regression), prompt-injection defense,
> PII/hallucination handling, model routing + cost budget. These get their own gate rows in
> the Phase Gate checklist.

Each phase ends by updating `docs/STATUS.md` to the next phase and recording the gate sign-off
(who approved, date) in `templates/02_PHASE_GATE_CHECKLIST.md`.

---

## 6. Sprint cadence (weekly)

- **One sprint = one week.** Planned every Monday, reviewed every Friday, using
  `templates/01_SPRINT_PLAN.md`.
- A sprint has: **a single primary goal**, a small set of tasks (each mapped to a phase + branch
  + owner), and an explicit "**Definition of Done**" and "**Not doing this week**" list.
- **Blocker protocol (do this, in order):**
  1. Log it immediately in `docs/STATUS.md` + the sprint plan's blocker section.
  2. Try the documented workaround if one exists; timebox to 30–60 min.
  3. If still blocked → do **not** invent a hack or hidden workaround. Park the task, pick the
     next unblocked task, and escalate to the Repo Owner with: what's blocked, what you tried,
     options, your recommendation.
  4. Never let a blocker silently change scope or stack.
- **What NOT to do during a sprint:** add unplanned features, swap the tech stack, refactor
  unrelated code, touch `main`, or "quickly" skip a gate to hit the goal.

---

## 7. Security mandate — "legit, not injectable" baseline

Applies to **every** project, enforced at the P6 gate but required from P0.

### 7.1 Secrets
- No secrets in git. `.env` is git-ignored; commit only `.env.example` with blank values.
- Secrets live in the host's secret manager / env vars. Rotate on suspicion.

### 7.2 Injection & input defense (the core anti-hacker rules)
- **SQL:** parameterized queries / ORM only. Never build SQL by string concatenation.
- **XSS:** escape/encode all output; never `dangerouslySetInnerHTML` with unsanitized data.
- **Command/path injection:** never pass unvalidated input to shells or file paths.
- **AuthZ on every endpoint and every entity** — verify the caller may access *this* record,
  not just that they're logged in.
- **Validate at the boundary:** schema-validate every API input (e.g. zod/pydantic). Reject by default.
- **Rate limiting & abuse protection** on auth, write, and AI endpoints (P6).
- **Dependencies:** no unvetted packages; run dependency/vulnerability scanning in CI.
- **Errors never leak internals** (stack traces, queries, keys) to the client.

### 7.3 AI-specific security (vertical/AI track)
- Treat **model output as untrusted input** — never execute it or trust it for authz decisions.
- **Prompt-injection defense:** isolate user content from system instructions; constrain tool
  use; allow-list actions; require human-in-the-loop for destructive actions.
- **PII/data handling:** minimize, mask in logs, document retention; no customer data in prompts
  sent to third parties without sign-off.
- **Evals before ship:** accuracy + regression eval suite is a hard gate (P8).

### 7.4 Compliance pack (only if §3 flagged regulated data)
- Document data classification, retention, access control, and the relevant regime
  (HIPAA / PCI / GDPR / etc.) **before P3**. No regulated build proceeds without it.

### 7.5 Required security review
- Run the security review (e.g. the `/security-review` skill) on the diff **before the P6 gate**
  and again before P9 ship. Findings are fixed or explicitly accepted by the Repo Owner.

---

## 8. Living documentation (must stay current — drift insurance)

Kept in `docs/` and updated **as work happens**, not at the end:

| File | Holds | Updated by |
|---|---|---|
| `PROJECT_BRIEF.md` | The frozen intake/scope (from template 00) | Owner at P0 |
| `ARCHITECTURE.md` | System design, components, data model, threat model | Lead Claude at P1 |
| `STATUS.md` | Current phase, sprint goal, blockers, who's on what | Every Claude |
| `WORKLOG.md` | Append-only ledger of every push (the sync source of truth) | Every Claude, every push |
| `CHANGELOG.md` | User-facing changes per release | On merge |
| `DECISIONS.md` | Why we chose X (ADR-lite) | Whoever decides |
| `RUNBOOK.md` | Deploy, rollback, incident steps | At P9 |

---

## 9. Definition of Done (a task is NOT done until all true)

- [ ] Code on a feature branch, not `main`.
- [ ] Its phase gate criteria met.
- [ ] Inputs validated; authZ enforced; no secrets; no injection vector introduced.
- [ ] Tests written and passing (and evals, on AI track).
- [ ] WORKLOG + STATUS updated; CHANGELOG/DECISIONS updated if relevant.
- [ ] PR opened, reviewed, and merged **by the Repo Owner** (never self-merged).

---

## 10. Quick "do / don't" card for every Claude Code

**DO:** read the 6 startup docs → claim one task → branch → small commits → validate all input
→ write tests → update WORKLOG every push → open a PR → ask when unsure.

**DON'T:** push to `main` or merge your own PR (Claudes never merge to `main`; only Owner/Deputy
merge approved PRs) → skip a phase/gate → start coding before the Brief is complete → add
deps/features/stack changes unprompted → edit another Claude's branch → commit secrets → hide a
blocker → trust model output blindly.
