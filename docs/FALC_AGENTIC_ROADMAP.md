# Falc — Agentic Roadmap (CTO brainstorm, 2026-07-05)

> Where Falc is today and where it can go to be **fully helpful and agentic**. Owner-requested ("as a
> CTO, think of other things Falc can do"). This is a candidate list to prioritise — **not** committed
> scope. Each item below inherits the ADR-019 safety spine: **propose → confirm → execute**, with
> delete/high-impact actions **always** requiring a human confirm (never auto-mode-skippable).

## Where Falc is today (shipped, ADR-019)
- **Reads:** `getReport`, `listExpenses` (now returns `id`), `topMerchants`.
- **Writes (propose→confirm):** edit an expense, soft-delete, approve/reject review, add a template field.
- **Safety:** server-side auto-mode gate (only edit + review-decision may auto-confirm), fresh
  re-validation at confirm, forced stop after a proposal, injection-hardened system prompt, escaped
  confirm card, input-lock while pending. Live-verified end-to-end.

## The gaps that stop it being "fully agentic" — grouped by value

### A. Action breadth (dashboard parity — anything a human can click, Falc can propose)
1. **Bulk edits** — "recategorise every Starbucks to Meals" → one confirm card listing N rows (with an
   impact cap: "this changes 47 rows"). The single biggest agentic lever; needs a bulk-proposal shape.
2. **Full template management** — rename / remove / reorder fields, not just add (today it's add-only).
3. **Duplicate merge** — "merge these two 99 Speed Mart rows" (ties into the #5 duplicate detector).
4. **Currency actions** — re-convert a row, set the account default currency.
5. **Trigger an export** — "export last month to Excel" → returns the download (reuse `/api/excel`).
6. **Re-run OCR / re-extract** on a stored receipt image (now that ADR-018 keeps the image).

### B. Proactive insight (Falc opens the conversation, not just answers)
7. **On-open briefing** — "3 receipts need review, 2 look like duplicates, you're 20% over last month on Fuel."
8. **Trend / anomaly narration** — surface spikes, new merchants, unusual amounts in plain English.
9. **Budget thresholds** — "tell me when dining crosses RM500 this month" → a standing watch.

### C. Automation rules (the real leap — durable, not one-shot)
10. **Standing categorisation rules** — "always categorise Shell as Fuel & Auto" → writes a
    category-correction/memory rule (reuses the existing `lib/categoryMemory` + #14 upsert).
11. **Auto-approve rules** — "auto-approve anything under RM10" (server-enforced, per-client configurable).
12. **Scheduled digests** — "send me a weekly summary every Monday" (Telegram/email; ties to the bot).

### D. Trust, explainability & reversibility (CTO must-haves as power grows)
13. **"Why this category?"** — surface the categorizer's source/confidence for a row.
14. **Persistent audit log** — every Falc write recorded (who/what/before→after/when); "what did you
    change today?" Today the proposal store is in-memory only — an audit trail should be DB-backed.
15. **Undo** — "undo that last edit" reverses the last confirmed action from the audit journal.

### E. Ingestion in-chat
16. **Drop a receipt into Falc** — attach an image in chat → OCR → propose the parsed row to save.

## Sequencing recommendation (CTO)
- **Now-ish (high value, contained):** #1 bulk edits, #5 export trigger, #10 standing category rules,
  #14 persistent audit log (it de-risks everything after it).
- **Next:** #2 full template mgmt, #7 on-open briefing, #15 undo (needs #14 first).
- **Later / needs infra:** #11 auto-approve rules, #12 scheduled digests, #16 in-chat ingestion, #6 re-OCR.

## Cross-cutting guardrails (apply to ALL of the above)
- Keep the **propose→confirm** spine; **bulk & delete & rule-creation always confirm** (impact preview
  first). Auto-mode stays limited to low-risk single edits + review decisions, server-decided.
- **Persist the audit log** before shipping bulk/rules — reversibility and accountability scale with power.
- **Per-client config (ADR-020):** which Falc actions/rules are enabled is a **per-client delivery
  setting**, not a global on/off — some clients will want a read-only Falc, others fully agentic.
