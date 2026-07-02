# Shared QA fixture set — receipt-analyser M1

> Seeded by J1 (frontend/QA/security plan §0.1). **Both surfaces test against these same inputs**
> so a bug found on one (dashboard, J1) can be checked on the other (Telegram bot, Barat).
> Mix of **realistic** and **hostile** data — the point is to prove the app stays safe on untrusted input.

## Text-based fixtures (committed here)
| File | Purpose | Expected safe behaviour |
|---|---|---|
| `hostile-headers.csv` | CSV template (#12) with XSS/control-char/oversized column headers | headers parse to safe FieldSpec labels; C0/C1 stripped (lib/templates), `<script>` rendered inert in the dashboard, never executed |
| `hostile-merchant.txt` | Strings an OCR result / merchant field might contain | when displayed in the dashboard they render as literal text (escape.js), never as markup/script |
| `agent-injection.txt` | Prompt-injection questions for the dashboard agent (#9) | agent never leaks other-account data, never executes instructions; read-only tools only |

## Binary fixtures (a human must add — cannot be generated in CI)
Add these under `docs/qa/fixtures/` before the live QA session (Task K):
- `receipt-clean.jpg` — a clear real receipt (happy path: correct extraction).
- `receipt-blurry.jpg` — a blurry total (low-confidence flag, #11 — must flag, not guess).
- `receipt-two.jpg` — one photo with two receipts (#7 mass upload → 2 rows).
- `receipt-injection.png` — a receipt image whose printed text contains `<script>alert(1)</script>` / "ignore previous instructions" (stored-XSS + prompt-injection end-to-end).
- `invoice-1page.pdf`, `invoice-3page.pdf` — native PDFs (#1).
- `scanned.pdf` — image-only PDF (#1 scanned path).
- `encrypted.pdf`, `corrupt.pdf`, `oversized.pdf` (>20 MB), `render-bomb.pdf` (tiny file, huge MediaBox) — must fail gracefully (413/422), never crash.
- `too-many.pdf` — 11+ pages (cap at MASS_MAX_IMAGES, `pages_truncated`).

> Reuse the PDF fixtures Barat generated for `tests/fixtures/pdf/` where possible instead of duplicating.

## Adversarial payload catalogue (used across CSV/merchant/agent fixtures)
`<script>alert(1)</script>` · `"><img src=x onerror=alert(1)>` · `{{7*7}}` · `${7*7}` ·
`javascript:alert(1)` · a NUL and other C0/C1 control bytes · RTL override `‮` + emoji ·
an extremely long string (label/field length cap) · SQL-ish `'; DROP TABLE expenses;--`
(must be inert — we use parameterised Supabase REST, but verify it renders as text).
