# ⚠️ PRE-DEMO / PRE-HANDOFF CHECKLIST — do these before showing a customer or handing off

> Running list of things that are FINE for internal testing now, but MUST be done before a
> real demo / customer / public handoff. Add to it as we go; tick when done.

## 🔴 Rotate exposed secrets (security — deferred, not urgent while internal-testing only)
These are safe in `.env` (gitignored) — the issue is only that they were **pasted into an AI
chat transcript** this session (Vibe-Coder checklist: "never paste private keys into AI chats").
No misuse; low risk while we're the only ones testing. **Rotate before demo/handoff:**

- [ ] **`DASHBOARD_TOKEN`** — the bearer that gates every `/api/*` + `/receipt` route. Generate a
      new random string, replace in `.env`, restart the server.
- [ ] **Groq API key(s)** — the pool in `GROQ_KEYS` (incl. the backup key pasted 2026-07-04).
      Rotate in the Groq console, replace in `.env`.
- [ ] After rotating, confirm nothing else references the old values (grep, deploy env).

## 🟡 Config hardening before a real launch
- [ ] **Rate limits** — for the demo, local `.env` was bumped high (`UPLOAD_RATE_MAX`/`AGENT_RATE_MAX=2000`,
      `DASH_AUTH_RATE_MAX=600`) so nobody hits a limit while showing it off. For production, return these
      to sane backstop values (the Owner's standing directive: "never throttle a legit busy user", but keep
      a real runaway backstop). NOT baked into `.env.example` on purpose.
- [ ] **`.env` in repo root holds LIVE creds** (Supabase + Groq) — treat as dev-exposed (ADR-015);
      rotate to per-customer creds before onboarding a real customer.
- [ ] **Bot token** — repo `.env` currently has no `BOT_TOKEN`; the live bot runs on Barat's machine.
      Confirm the production bot token + `WEBHOOK_SECRET` + `ALLOWED_CHAT_IDS` are set wherever it's hosted.

## 🟢 Security posture — reviewed 2026-07-04 (Vibe-Coder checklist), verdict: no critical breach
Passing: no secrets in frontend, sessionStorage (not localStorage) token, strict CSP + security headers,
generic error messages (no internals), `checkDash` on every API route + `account_id` scoping + confirm-time
ownership re-checks (bot delete/category-pick), no raw SQL (PostgREST + encodeURIComponent), size/type/pixel
caps on uploads, `npm audit` = 0. Telegram: `ALLOWED_CHAT_IDS` allowlist (covers `callback_query`), webhook
secret, no PII/images in logs. Open follow-ups (non-critical): #17 template label sanitization (server-side;
render is already escaped), session-token expiry/rotation for M2, structured security logging for M2.
