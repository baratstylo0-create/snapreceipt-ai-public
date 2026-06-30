# ARCHITECTURE — Receipt Analyser SaaS
> P1 design doc. Expands PROJECT_BRIEF §6. **The "Frozen interfaces" section is a contract:**
> once agreed, an owner may change a frozen signature ONLY by announcing it in `docs/WORKLOG.md`
> first and getting Owner sign-off — because other Claudes build against it.

## 1. Principles carried from the existing code (do not break)
- One backend process, **no build step**. Only runtime deps: `express`, `dotenv` (+ approved additions).
- Node 20+ **native `fetch`/`Buffer`** — no axios/node-fetch/multer. Reuse the `hreq()` helper.
- DB access is **server-side only** with the Supabase service-role key. Browser calls our `/api/*`.
- `expense_date` stays **TEXT** (OCR dates are messy; normalise to ISO in JS).
- Groq is rate-limited on free tier — keep the exponential backoff in `groqChat()`.
- Everything is scoped by `account_id` (forward-compatible to multi-tenant).

## 2. Target module layout (the modularization = first task, P1/P2)
`server.js` shrinks to **wiring only** (create app, mount routes, startup, webhook registration). Logic moves to:

```
lib/
  groq.js        [BARAT] Groq client, model routing, backoff. Exports groqChat(), groqVision().
  supabase.js    [BARAT] DB helpers. Exports sbSelect/sbInsert/sbUpdate/sbSoftDelete (account-scoped).
  templates.js   [BARAT] CSV field-template import/parse/store. Exports parseTemplate(), getFieldSpec().  ← SHARED CONTRACT
  ocr.js         [BARAT] receipt → fields, driven by a field spec. Exports extractReceipt().  (#4, #1 PDF)
  confidence.js  [BARAT] per-field confidence + low-confidence flags. Exports scoreConfidence().  (#11)
  categorize.js  [JEEVAN] line-item categorization. Exports categorizeLineItems().  (#6)
  anomaly.js     [JEEVAN] suspicious/invalid flagging. Exports detectAnomalies().  (#5)
  reports.js     [JEEVAN] day/week/month/year aggregation. Exports buildReport().  (#8)
  agent.js       [JEEVAN] dashboard assistant (chat + read-only tools). Exports runAgent().  (#9)
  excel.js       [JEEVAN] export expenses to .xlsx matching field spec. Exports exportExcel().  (#2)
  currency.js    [JEEVAN] FX fetch+cache, convert to local. Exports convertCurrency().  (#10)
  massupload.js  [JEEVAN] split a multi-receipt image into N. Exports splitReceipts().  (#7)
routes/
  webhook.js     [BARAT]  POST /webhook  (Telegram)
  upload.js      [JEEVAN] POST /api/upload (dashboard image/pdf/multi)  (#7, #1)
  templates.js   [BARAT]  POST /api/templates (import CSV), GET /api/templates  (#12)
  expenses.js    [JEEVAN] GET/PATCH/DELETE /api/expenses  ← SHARED CONTRACT (mostly stable; announce changes)
  reports.js     [JEEVAN] GET /api/reports  (#8)
  agent.js       [JEEVAN] POST /api/agent  (#9)
public/index.html [MUGI]  dashboard + template-import UI + business structure
schema.sql        [BARAT]
```
**Collision rule:** you edit ONLY files marked with your name. To touch a SHARED CONTRACT file or a frozen signature, announce in WORKLOG first.

## 3. Frozen interfaces (build against these — do not assume internals)

### 3.1 Field spec (the heart of #12) — produced by `lib/templates.js`
```js
// getFieldSpec(account_id) -> FieldSpec
// FieldSpec = {
//   account_id: string,
//   columns: [ { key: string,        // canonical key, e.g. "merchant"
//                label: string,       // exact CSV header the customer wrote, e.g. "Vendor"
//                type: "text"|"date"|"number"|"currency"|"category",
//                required: boolean } ],
//   updated_at: string
// }
// parseTemplate(csvText) -> FieldSpec.columns   (maps headers -> canonical keys; unknown headers kept as type "text")
```
OCR (#4), Excel (#2), and the dashboard all read `FieldSpec.columns` to know **what to extract and what to output**. Excel emits columns in `label` order; OCR extracts only `key`s present.

### 3.2 Groq layer — `lib/groq.js`
```js
// groqChat(messages, { model?, max_tokens?, temperature? }) -> string
// groqVision(imageUrlOrBuffer, promptText, { model?, max_tokens? }) -> string   // returns raw model text
// MODEL_ROUTES = { visionDefault, visionEscalate, text, classify }            // ids resolved from .env
```
Anyone calling vision (#7 mass upload, #9 agent) goes through these — never call the Groq HTTP API directly.

### 3.3 Supabase layer — `lib/supabase.js`
```js
// sbSelect(table, { eq?, order?, limit? }) -> rows[]      (always inject account_id)
// sbInsert(table, row) -> void
// sbUpdate(table, { id, account_id }, patch) -> rows[]
// sbSoftDelete(table, { id, account_id }) -> void
```

### 3.4 Expense object (DB row shape) — extended for new features
Existing columns stay. **New columns (Barat adds to schema.sql at P3):**
`confidence jsonb` (per-field, for #11), `anomaly jsonb` (flags+reason, for #5), `currency_original text` + `amount_original numeric` + `fx_rate numeric` (for #10), `template_id` (FK to field_templates, for #12).

### 3.5 Model routing (PROJECT_BRIEF §4)
Verified live by Barat 2026-07-01 — see DECISIONS ADR-007 for full notes.

| Use | env var | verified id |
|---|---|---|
| Vision default | `VISION_MODEL` | `qwen/qwen3.6-27b` ✅ Production (replaces llama-4-scout — Preview-only; ADR-007) |
| Vision escalate | `VISION_MODEL_HEAVY` | `qwen/qwen3.6-27b` ✅ (same; llama-4-maverick not listed — monitor for production replacement) |
| Text / agent / anomaly | `TEXT_MODEL` | `llama-3.3-70b-versatile` ✅ Production |
| Cheap classify / narrate | `CLASSIFY_MODEL` | `openai/gpt-oss-20b` ✅ Production (ADR-006) |

Escalate vision→heavy when confidence is low or input is a multi-receipt/PDF page.

## 4. Data flow (end to end)
`import CSV template → templates.js stores FieldSpec → receipt in (Telegram/upload, image/PDF/multi) → [massupload.splitReceipts if multi] → ocr.extractReceipt(img, fieldSpec) via groq → confidence.scoreConfidence → categorize + anomaly + currency.convert → supabase insert → dashboard / reports / excel render per FieldSpec`

## 5. Build order (dependency-aware)
1. **P1/P2:** modularize `server.js` → `lib/` + `routes/` (no behaviour change); set frozen interfaces above. *(Owner-coordinated; small focused PRs.)*
2. **P3 (Barat):** schema additions, `supabase.js`, `groq.js`, `templates.js` (#12) — unblocks everyone.
3. **Parallel features:** Barat (ocr/#4,#1,#11) ‖ Jeevan (#6,#5,#8,#2,#10,#7,#9) ‖ Mugi (#3 + business). Each = one branch = one PR.
4. **P6–P9:** hardening, observability, tests/evals, deploy.
