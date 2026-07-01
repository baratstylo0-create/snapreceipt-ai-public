# Spec — #5 Anomaly detection + admin review queue

> Status: approved (brainstorm 2026-07-01). Owner: Jeevan. Branch: `feature/jeevan-p5-anomaly`.
> Frozen interface (ARCHITECTURE §3): `lib/anomaly.js` exports `detectAnomalies()`.

## Goal
Flag suspicious/invalid expenses at ingestion and route them to an admin accept/reject queue.
Detection never auto-acts — a human always decides.

## `lib/anomaly.js`
`async detectAnomalies(expense, opts?)` →
`{ flagged: boolean, reasons: [{ type, detail, severity, confidence? }], status_suggestion }`
- `opts`: `{ history?, businessType?, groqChat?, useLLM?, duplicateWindowDays?, outlierFactor?, outlierMinSamples? }`
  (`history` = prior expenses for dup/outlier context; `groqChat`/`useLLM` are test seams).
- `status_suggestion` = `needs_review` if any detector fires, else `saved`.

### Four detectors
1. **duplicate** (deterministic) — same normalized merchant + rounded amount + date within
   `duplicateWindowDays` (default 3) as an existing `history` row. severity high.
2. **outlier** (deterministic, robust) — amount > `outlierFactor`× (default 5) the **median**
   amount for that merchant, once ≥ `outlierMinSamples` (default 4) peers exist. severity medium.
3. **data_quality** (deterministic) — amount missing/≤0; date missing or impossible (e.g. 2026-13-40);
   `subtotal + tax ≠ total` (±0.02). severity low. (Present-but-messy dates are NOT flagged —
   `expense_date` is intentionally messy TEXT.)
4. **personal** (LLM watchdog, `TEXT_MODEL`) — conservative, business-context aware; flags only
   when clearly personal AND confidence ≥ 0.8. Caged like #6: JSON out, receipt text as untrusted
   DATA, never obeys embedded instructions. Graceful: LLM failure/garbage → no personal flag.
   **Capability-gated (ADR-010):** runs only when the account has `businessProfile` on. For a
   personal account every expense is personal, so this detector stays OFF; the other three run for all.

## Status machine
`saved` (clean, default) → `needs_review` (flagged) → `approved` | `rejected`.
`rejected` rows are kept for audit but should be excluded from report/Excel totals.

## Admin queue — `routes/review.js` (NEW, mounted in `server.js`)
- `GET /api/review` — lists `status = needs_review` expenses (+ their `anomaly` reasons). `checkDash` gate.
- `POST /api/review/:id { decision: 'approve'|'reject', note? }` — sets `status`, and records the
  decision audit into the existing `expenses.anomaly` jsonb (`anomaly.review = {decision, note, at}`),
  so **no schema change is needed**. Invalid decision → 400; DB error → 502.
- Namespace supabase import so route tests can stub `sbSelect`/`sbUpdate` (same pattern as reports).

## Handoffs (collision-safe — not edited in this PR)
- **Barat (`lib/ocr.js`/`lib/bot.js`):** at ingestion, call `detectAnomalies(expense, { history, businessType })`,
  store `result` in `expenses.anomaly`, and set `status = result.status_suggestion`.
- **J1 (`reports`/`excel`):** exclude `status = 'rejected'` from totals (1-line `status=neq.rejected`
  filter) once PR #8 merges. Documented so we don't edit files under active review.

## Testing (TDD, no network — history + groqChat injected)
Each detector: flag + no-flag + a boundary (dup window edge, outlier min-samples, impossible date,
math mismatch). LLM personal: flagged when confident-personal; business context suppresses a false
positive; low-confidence not flagged; LLM throw/garbage → graceful. Aggregation (multiple reasons,
`status_suggestion`). Review route: list, approve, reject (+note audit), bad decision → 400, DB error → 502.

## Out of scope
Ingestion wiring (Barat), reports exclusion (J1, post-#8), a dedicated dashboard review UI (Mugi),
notifications on flag, ML-based anomaly scoring.
