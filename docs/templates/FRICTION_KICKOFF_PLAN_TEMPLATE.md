# FRICTION KICKOFF PLAN
### CTO Validation Document — Fill this before any code is written

> **How this works:** Your team fills every section below. Once complete, submit it for CTO
> review. The CTO (Claude acting as Friction CTO) checks every section against the SOP and
> either approves (GO) or returns it with specific fixes (NO-GO). No build starts without a GO.
>
> "TBD" is only allowed in Section 10 (Open Questions). Everywhere else = answer it or stop.

---

## STATUS
- **Filled by:**
- **Date submitted:**
- **CTO review status:** ⬜ Pending / ✅ Approved (GO) / ❌ Returned (NO-GO)

---

## SECTION 1 — Project Overview

| Field | Your answer |
|---|---|
| **Project name** | |
| **One-sentence pitch** | |
| **Client / internal product?** | |
| **Track** | ☐ Vertical AI solution  ☐ Horizontal SaaS  ☐ Hybrid |
| **Regulated data?** | ☐ No  ☐ Yes → regime: (HIPAA / GDPR / PCI / other) |
| **Repo Owner (primary merger)** | |
| **Deputy (backup merger when Owner away)** | |

---

## SECTION 2 — Problem & Users

- **What problem does this solve:**
- **Who specifically is it for (persona, not just "users"):**
- **What pain exists today without this:**
- **Top 3 user journeys (step-by-step, be specific):**
  1.
  2.
  3.

---

## SECTION 3 — MVP Scope (what is and is NOT in Milestone 1)

**Must-have for MVP (the product is useless without these):**
-
-
-

**Explicitly NOT in MVP (write these down to prevent scope creep):**
-
-
-

**Success metric — how do we know MVP works:**

---

## SECTION 4 — AI-Specific (fill ONLY if Vertical AI or Hybrid track)

| Field | Your answer |
|---|---|
| **What the AI does (capability)** | |
| **Input sources & data quality** | |
| **Required accuracy / acceptable error rate** | |
| **3+ golden eval examples (input → expected output)** | |
| **What happens when model is unsure (fallback)** | |
| **Human-in-the-loop checkpoints** | |
| **PII / sensitive data handling** | |
| **Model(s) to use** | |
| **Monthly AI cost budget (hard cap)** | |

---

## SECTION 5 — Tech Stack (lock it — Claudes cannot change this without Owner approval)

| Layer | Choice | Notes / version |
|---|---|---|
| **Frontend** | | |
| **Backend / API** | | |
| **Database** | | |
| **Auth & permissions** | | |
| **Hosting / cloud** | | |
| **CI/CD** | | |
| **Key third-party services** | | |
| **Forbidden (libs / patterns / vendors)** | | |

---

## SECTION 6 — System Design Sketch

> Keep this high-level — it gets expanded into `docs/ARCHITECTURE.md` at P1.

**Main components and how they connect:**
```
(draw a simple text diagram or describe in bullets)
```

**Data model (entities + key relationships):**
```
e.g. User → owns → Project → has many → Tasks
```

**External integrations:**
-

**Scaling expectations:**
- Launch: __ users / __ requests per day
- 6 months: __ users / __ requests per day

---

## SECTION 7 — Threat Model (security from day 0)

| Field | Your answer |
|---|---|
| **What data is sensitive here** | |
| **Likely attackers / abuse cases** | |
| **Where untrusted input enters the system** | |
| **Top risk #1 + how we prevent it** | |
| **Top risk #2 + how we prevent it** | |
| **Top risk #3 + how we prevent it** | |

---

## SECTION 8 — Team & Claude Assignment

> This section defines WHO owns WHAT. Two people/Claudes must never edit the same module.
> Fill the Module Ownership Map completely — this is the collision-prevention contract.

### The team

| Person | Role | Claude instances they control | Branch prefix |
|---|---|---|---|
| Jeeva | Repo Owner | Claude-J1, Claude-J2 | `feature/jeeva-...` |
| Barat | Deputy | Claude-B1, Claude-B2 | `feature/barat-...` |
| Mugi | Worker | Claude-M1 | `feature/mugi-...` |

### Module Ownership Map (fill every row — no blank owners)

| Module / Area | Who owns it | Branch prefix | Notes |
|---|---|---|---|
| Project setup & CI/CD (P2) | | | |
| Database schema & migrations (P3) | | | |
| Auth & permissions (P3) | | | |
| Backend APIs (P4) | | | |
| AI pipeline / prompts (P3.5 if applicable) | | | |
| Frontend (P5) | | | |
| Security hardening (P6) | | | |
| Observability / logs (P7) | | | |
| Tests & evals (P8) | | | |
| Deploy & runbook (P9) | | | |

### Within-person Claude rules (how Jeeva's 2 Claudes or Barat's 2 Claudes split work)

> Each person splits their own module into sub-tasks and assigns one per Claude.
> They must still follow the same rules: one task = one branch = one PR.

| Person | Claude-1 handles | Claude-2 handles |
|---|---|---|
| Jeeva | | |
| Barat | | |
| Mugi | (only 1 Claude) | — |

---

## SECTION 9 — Milestones & Timeline

| Milestone | Description | Phases covered | Target week |
|---|---|---|---|
| M1 — MVP | | P0 → P? | Week |
| M2 | | | Week |
| M3 (ship) | | P0 → P9 | Week |

---

## SECTION 10 — Open Questions / Deferred

> The only section where "TBD" is allowed. List unknowns with an owner and a deadline.

| Question | Owner | Must resolve by |
|---|---|---|
| | | |

---

## SECTION 11 — Pre-Build Checklist (team self-check before submitting)

Before sending for CTO review, confirm:

- [ ] Every field in Sections 1–9 is filled (no blanks except Section 10)
- [ ] Track is chosen
- [ ] Stack is locked — no "we'll decide later"
- [ ] Module Ownership Map has an owner for every row
- [ ] Repo Owner and Deputy are named
- [ ] Threat model has at least 3 specific risks with mitigations
- [ ] MVP scope has a "NOT doing" list
- [ ] If AI track: eval examples written, cost budget set

---

## CTO VALIDATION (filled by CTO, not the team)

> Do not fill this section. The CTO reviews and fills it after submission.

### Checks

| # | Check | Pass / Fail | CTO note |
|---|---|---|---|
| 1 | Brief complete — no empty fields outside §10 | | |
| 2 | Track clearly chosen; AI checklist filled if applicable | | |
| 3 | Stack locked — no "TBD" in tech choices | | |
| 4 | Module Ownership Map — no overlapping owners | | |
| 5 | Repo Owner + Deputy named | | |
| 6 | Threat model is specific, not generic | | |
| 7 | MVP scope is realistic for the stated timeline | | |
| 8 | AI eval examples are concrete and testable | | |
| 9 | No compliance gap (regulated data → pack started) | | |
| 10 | Team Claude split makes sense given the module map | | |

### Decision

- **GO** ✅ — proceed to P1 Plan & Design
- **NO-GO** ❌ — fix the following before resubmitting:
  1.
  2.

**CTO sign-off:** Jeeva (Founder / CTO) — **Date:**
