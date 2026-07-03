# Design — User onboarding / Telegram chat-id linking (personal + business)

> **Decision:** ADR-018 (proposed). **Status:** SPEC ONLY — **build is ON HOLD**, gated by the Owner
> until the personal-account flow is fully verified end-to-end. Do not implement any part of this
> until explicitly cleared.
> **Owners:** schema (`account_members` table) + `lib/bot.js` allowlist replacement = **Barat**.
> Dashboard "generate invite" UI + admin/collaborator management screen = **Jeevan/Mugi**.
> **Tier:** Tier-2 (access control on financial data — same class as the current `ALLOWED_CHAT_IDS`).
> **Requested by:** Jeevan, relaying an Owner question about multi-user onboarding.

## Problem
Today, connecting a Telegram user to the bot is **manual and static**: `ALLOWED_CHAT_IDS` in `.env`
is a comma-separated list an operator edits by hand and the bot must be restarted to pick up
(`lib/bot.js`, added 2026-07-03). This works for two people (Barat + Jeevan) but does not scale to:
- **Business accounts** with an admin plus N collaborators, who need to self-onboard without
  someone hand-editing a config file and restarting the server per new hire.
- **Personal accounts** for new individual users, who should just work immediately with zero setup
  from an operator.

## Goal
A simple, self-service way for a real chat_id to become linked to an account, with a role, without
any code change or restart — while staying at least as safe as today's allowlist (no open bot).

## Proposed design — Telegram deep-link invites
Telegram supports a **deep-link start parameter**: `https://t.me/<bot>?start=<payload>` opens the
bot and Telegram sends the payload as the `/start <payload>` command text automatically. This is the
standard, zero-friction pattern for "join via link" bots.

### Flow
1. **Personal account:** no invite needed. The *first* chat_id to `/start` the bot with no payload
   (or that isn't already linked to an existing account) is auto-registered as that account's owner.
   Matches today's "it just works" personal UX — nothing changes for a solo user.
2. **Business account — invite an admin/collaborator:**
   - From the dashboard, an account owner/admin clicks "Invite" and picks a role (`admin` or
     `collaborator`).
   - The server generates a short-lived, single-use invite code, tied to `(account_id, role)`.
   - The UI shows a link: `https://t.me/<bot>?start=<code>`.
   - The invitee taps it → Telegram opens the bot → bot receives `/start <code>` → looks up the
     code → if valid (unused, not expired), links `(chat_id, account_id, role)` and marks the code
     used → replies with a welcome message naming their role and account.
   - An invalid/expired/already-used code gets a plain "that invite isn't valid, ask for a new one"
     reply — never a crash, never silently ignored (same never-silent standard as the rest of the bot).

### Data model change (replaces the static allowlist)
`ALLOWED_CHAT_IDS` (env var) is replaced by a proper table:
```sql
create table account_members (
  account_id text not null,
  chat_id    text not null,
  role       text not null check (role in ('admin', 'collaborator', 'owner')),
  joined_at  timestamptz not null default now(),
  primary key (account_id, chat_id)
);

create table account_invites (
  code       text primary key,           -- short random token, e.g. 10 chars
  account_id text not null,
  role       text not null check (role in ('admin', 'collaborator')),
  created_by text,                       -- chat_id of the inviter, for audit
  expires_at timestamptz not null,       -- short TTL, e.g. 7 days
  used_by    text,                       -- chat_id that redeemed it (null = unused)
  used_at    timestamptz
);
```
`lib/bot.js`'s allowlist check becomes a lookup against `account_members` (by `chat_id`) instead of
the static env list. **Backward-compatible transition:** `ALLOWED_CHAT_IDS` can stay as a secondary
fallback allowlist during rollout so existing setups don't break, and be removed once every real
user is migrated into `account_members` — exact removal timing is a follow-up decision, not v1.

## Security
- Invite codes are single-use and short-lived (TTL) — a leaked code has a narrow window and can't be
  reused after redemption.
- `role` is fixed at invite-creation time by the inviter (an existing admin/owner), not chosen by the
  invitee — a collaborator invite can never self-upgrade to admin.
- Only an existing `admin`/`owner` chat_id may generate an invite (dashboard-side auth check, same
  `checkDash`/`AUTH_REQUIRED` posture as everything else).
- No PII beyond a Telegram chat_id and role is stored — same sensitivity level as today's data.

## Non-goals (YAGNI, v1)
- No invite-link QR codes, no email-based invites (Telegram deep-link only).
- No self-service role changes / demotions via the bot itself (dashboard-only, admin-driven).
- No cross-account chat_id (one chat_id belongs to exactly one account in v1 — a person managing two
  businesses would need two Telegram accounts; revisit only if actually requested).
- No automatic removal/expiry of `account_members` rows (an admin removing a collaborator is a
  separate, explicit dashboard action — out of scope here).

## Decisions needed before Barat builds (once cleared for M2)
- **A.** Invite code TTL — 7 days proposed, confirm or adjust.
- **B.** Invite code length/charset — 10 random alphanumeric chars proposed (collision-safe enough
  at expected invite volumes; confirm).
- **C.** What happens if a chat_id that's already a member of Account X taps an invite for Account
  Y — reject (a chat_id can only belong to one account, per Non-goals) or allow switching? Recommend
  reject with a clear message, since silent account-switching on a financial bot is risky.
- **D.** Migration timing — when (if ever) to remove `ALLOWED_CHAT_IDS` as a fallback once
  `account_members` is proven in production.

## Test plan (once built)
- Personal: first `/start` (no payload) auto-registers; a second different chat_id later hitting
  plain `/start` does NOT also become owner of that same account (must go through an invite).
- Business: valid invite → correct role linked, welcome reply names the role; code marked used.
- Invalid/expired/reused code → safe rejection reply, no link created, no crash.
- Role integrity: a `collaborator`-role invite can never result in an `admin` link.
- Allowlist parity: a chat_id in `account_members` is served exactly like today's `ALLOWED_CHAT_IDS`
  entries across every entry point (photo, PDF, batch, text, callback_query — mirrors the existing
  allowlist test suite in `tests/bot.allowlist.test.js`).
- Migration safety: `ALLOWED_CHAT_IDS` entries (if still configured) continue to work unchanged
  alongside `account_members`, during the transition period.
