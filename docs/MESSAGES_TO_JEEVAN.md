# Messages to Jeevan — from Barat's Claude sessions (B1/B2)

> Append-only log of every ready-to-send message handed to Barat for Jeevan (SOP-style, mirrors WORKLOG.md).
> Newest entry at the bottom. Barat copy-pastes these to Jeevan as-is or edits before sending.

---

## 2026-07-03 · Claude-B1 · re: PR #49, issues #45/#43 status

Pulled `main` (has #44/#46/#47/#48 — all confirmed merged, clean). But I don't see `normalizeCurrencyCode()` in `lib/currency.js` or `cfg.AUTH_REQUIRED` in `lib/config.js` on any branch/remote yet — checked `main` and every pushed branch. Looks like those two are only committed locally on your end, not pushed. Once they're up I'll wire in the `assembleExpense` currency swap (#45) and the webhook fail-closed check (#43) same day — both are small. Also flagging: my PR #49 (`fix/barat-flushgroup-timer-unhandled-rejection`) touches the same `flushGroup` catch line that #46 just merged — should be a clean/no-op overlap but wanted you aware before merging.

---

## 2026-07-03 · Claude-B1 · re: #45 + #43 done (one PR), item 5 already closed

Both done on ONE branch per your process note — `fix/barat-currency-normalize-and-webhook-failclosed`, PR #<TBD>. Pinging as requested.

- **#45 (RM→MYR):** did the exact one-line swap in `assembleExpense` — `normalizeCurrencyCode(fields.currency) || cfg.DEFAULT_CURRENCY`. +2 integration tests (RM→converts FROM MYR + records `currency_original=MYR`; ambiguous `$`→DEFAULT_CURRENCY fallback). Closes #45.
- **#43 (webhook fail-open):** mirrored the checkDash pattern with `cfg.AUTH_REQUIRED` in `routes/webhook.js` — refuses **503** when `AUTH_REQUIRED && !WEBHOOK_SECRET` (prod misconfig), stays permissive + one-time `console.warn` in dev, configured-secret path unchanged (200/401). Flipped your #43 characterization test from "fail-open, not yet fixed" to a dev-permissive / prod-fail-closed pair. Closes #43. (Chose **503** for the misconfig-refuse — server config problem, not a client error; no internals leaked in the body. Shout if you'd prefer 500/403.)
- **443/443 green** (+4 new).
- **Your item 3 (schema verification item 5) is already closed** — I ran the live Supabase table-list query earlier today: only `expenses`/`field_templates`/`category_corrections` exist, nothing foreign. Logged in STATUS.md.
- **Process note taken** — this is the batched-onto-one-branch approach from here on.
- Groq multi-key rotation ADR: understood, no build until you hand me the signed-off spec.
