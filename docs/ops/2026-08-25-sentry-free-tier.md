# Sentry free-tier setup

Owner direction on 2026-08-25: use one Sentry free-tier setup for SnapReceipt AI, so the team does not have to reason about multiple observability tools or split projects during the full-app build.

## Runtime model

- One Sentry organization/project for SnapReceipt AI.
- One DSN in deployment config: `SENTRY_DSN`.
- The backend sends runtime exceptions only when `SENTRY_DSN` is set and `SENTRY_ENABLED` is not `false`.
- Local development and CI remain safe with Sentry off by default.
- `SENTRY_TRACES_SAMPLE_RATE` defaults to `0` to preserve free-tier quota; turn on tracing only deliberately.

## Privacy boundary

Sentry must never receive receipt images, OCR raw output, request bodies, cookies, authorization headers, dashboard tokens, Telegram secrets, Supabase keys, merchant details, card details, amounts, email addresses, phone numbers, or user identifiers.

The adapter in `lib/sentry.js` enforces this with `sendDefaultPii:false`, request-context stripping, path ID scrubbing, dropped breadcrumbs, and an allow-list for scalar tags/extras.

## Agent split

- Claude: Sentry account/project, DSN, deployment environment variables, alert routing, and any dashboard-side Sentry settings.
- Codex: application wiring, privacy scrubbing, tests, and documentation.

## Activation

Set these in the deployment environment, not in git:

```env
SENTRY_DSN=<project dsn>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<git-sha-or-release-tag>
SENTRY_TRACES_SAMPLE_RATE=0
```

Restart the app after changing deployment config. `configSummary()` prints `sentry=on` at boot when the DSN is active.
