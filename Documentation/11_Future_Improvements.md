# Future Improvements

## Purpose
Planned improvements and hardening steps — based on the code, decision log, and open issues, not speculation.

## Overview
The core product (personal + business) is built and tested. Remaining work falls into three groups: **pre-launch operations**, **security hardening**, and **product enhancements**.

## Key Components

**A. Pre-launch operations**
| Item | Notes |
|---|---|
| Rotate all secrets | Dashboard token, AI keys, DB key used during development |
| Enable AI Zero-Data-Retention | On the business client's AI account |
| First validated production deploy | Runbook exists; a verified end-to-end deploy is the gate |
| Uptime monitoring | External monitor on `/health` |
| Independent DB backup | Held outside the primary account |
| Reset demo rate limits | Return relaxed limits to production values |

**B. Security hardening (recorded, not yet enabled)**
| Item | Notes |
|---|---|
| Database-level RLS | JWT-scoped policies beneath the app-layer scope |
| Session expiry tuning | Shorter, rotating sessions for business users |
| Legacy `company_id` backfill | Needed before a "company-only" role |
| Template label sanitisation | Extra defence-in-depth on imported labels |

**C. Product enhancements**
| Item | Notes |
|---|---|
| Client-specific statement layout | Faithful reproduction of first client's format |
| Per-image receipt links (batch) | Keep each photo's own link in a multi-photo batch |
| Bot help text polish | Align guide text with the newest delete flow |
| "Edit in place" on bot delete | Update the list message instead of a fresh one |
| Observability Phase 2 | Optional error tracking, default off, per-client opt-in |
| Multi-tenant evolution | Shared multi-tenant + RLS if scale demands |

## How It Works (prioritisation)
```mermaid
flowchart LR
    A[Pre-launch ops] --> B[Go live] --> C[Security hardening] --> D[Enhancements] --> E[Scale if needed]
```

## Notes
- Exact scope/timing of each item is a business decision — **Requires Manual Review**.
- Core promise unchanged: personal stays as-is; business features are additive and flag-gated.
