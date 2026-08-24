'use strict';
// quiet:true (dotenv 17+, small fix): dotenv now prints a marketing banner/tip line to
// stdout on every load by default ("◇ injected env... // tip: ..."). Harmless in normal
// server boot, but it silently prepended itself onto raw child-process stdout captured by
// tests/pdf.render-cap.qa.test.js's env-override probe, breaking an exact-equality assertion.
// Suppressed at the source rather than patched around in the test.
require('dotenv').config({ quiet: true });

const cfg = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  // Public @handle (not a secret) — lets the dashboard render a clickable t.me/<bot>?start=
  // deep link for clerk bot-binding (Team view) instead of a bare code to copy-paste.
  // Optional: unset -> the frontend falls back to showing the raw code (setup/provision.js's
  // CLI bindingLink() already has this exact same optional/degrade pattern).
  BOT_USERNAME: (process.env.BOT_USERNAME || '').replace(/^@/, '').trim(),
  GROQ_KEY: process.env.GROQ_KEY,
  // 2026-07-21: vision OCR moved to OpenRouter (see lib/openrouter.js) — Groq's
  // llama-4-scout was decommissioned 2026-07-17 and its forced replacement (qwen on Groq)
  // proved unreliable on real receipts. GROQ_KEY stays required for text-only routes
  // (TEXT_MODEL/CLASSIFY_MODEL, Falc chat) — this is a separate, additional key.
  OPENROUTER_KEY: process.env.OPENROUTER_KEY,
  SB_URL: (process.env.SB_URL || '').replace(/\/$/, ''),
  SB_KEY: process.env.SB_KEY,
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  // Self-signed-host support (issue: registerWebhook was broken on a self-signed VPS —
  // Telegram won't trust the cert unless it's uploaded WITH setWebhook via the
  // `certificate` multipart field). Optional: path to the same .pem nginx serves.
  // Empty on hosts with a real (CA-trusted) cert, e.g. Render/Fly — unaffected.
  WEBHOOK_CERT_PATH: process.env.WEBHOOK_CERT_PATH || '',
  DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN || '',
  // ADR-025 amendment (Owner-approved, 2026-07-11 QA round): key for encrypted-at-rest,
  // RECOVERABLE branch-clerk passwords (lib/credCrypto.js) — an admin viewing a branch's
  // login again, distinct from the one-way scrypt password_hash login still checks.
  // Unset -> encryption is disabled (never stores plaintext); those branches degrade to
  // "no password on file, use Reset" in the dashboard, same as any legacy branch.
  CRED_ENC_KEY: process.env.CRED_ENC_KEY || '',
  // P6 hardening (§4.3): fail-closed auth. In production (or when explicitly forced via
  // AUTH_REQUIRED=true) checkDash refuses to serve when no DASHBOARD_TOKEN is configured,
  // instead of silently letting every request through. Read live (not cached) by checkDash
  // so tests can flip process.env.NODE_ENV / AUTH_REQUIRED without re-requiring the module —
  // see the AUTH_REQUIRED getter usage in routes/expenses.js.
  ACCOUNT_ID: process.env.ACCOUNT_ID || 'default',
  DEFAULT_CURRENCY: (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  DEFAULT_TAX_RATE: Number(process.env.DEFAULT_TAX_RATE || '0') || 0,
  PORT: Number(process.env.PORT || '3001'),
  // Resend for personal-mode "forgot password" emails (2026-07-27, lib/mailer.js) — swapped
  // from SendGrid (signup friction) then Gmail (Barat's final choice). RESEND_FROM_EMAIL can
  // be the no-setup test sender 'onboarding@resend.dev' (works immediately, no domain
  // verification) or a sender on a domain you've verified in Resend for production. Both
  // optional — unset means reset emails don't send (lib/mailer.js warns once, never throws);
  // no effect on any other feature, business included.
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || '',
  // In-app feedback (2026-08-09, lib/mailer.js's sendFeedbackEmail): where a user's "Contact
  // us" message actually lands. Falls back to RESEND_FROM_EMAIL if unset, so feedback works
  // out of the box the moment mail is configured at all — no extra required setup step.
  RESEND_FEEDBACK_TO: process.env.RESEND_FEEDBACK_TO || '',
  // HitPay (2026-07-30) — payment provider for the Free/Pro subscription upgrade. Sent as
  // the X-BUSINESS-API-KEY header on every HitPay API call. Optional/degrade-safe: unset
  // means the Upgrade-to-Pro flow shows "billing not configured yet" instead of throwing,
  // same pattern as RESEND_API_KEY above. HITPAY_SALT is the webhook signature secret
  // (Settings -> Payment Gateway -> API Keys, same screen as the API key) — used to verify
  // an incoming webhook actually came from HitPay before trusting it; also optional here
  // since it hasn't been generated yet, but required before the webhook route is live.
  HITPAY_API_KEY: process.env.HITPAY_API_KEY || '',
  HITPAY_SALT: process.env.HITPAY_SALT || '',
  // A 'live_' key talks to api.hit-pay.com; a sandbox key needs api.sandbox.hit-pay.com.
  // Detected from the key's own prefix rather than a separate on/off flag, so there's only
  // one thing to get right, not two that could disagree.
  HITPAY_API_URL: (process.env.HITPAY_API_KEY || '').startsWith('live_')
    ? 'https://api.hit-pay.com/v1'
    : 'https://api.sandbox.hit-pay.com/v1',
  // Google Sign-In (2026-07-30) — "Continue with Google" on the personal Login/Signup
  // screens. Optional/degrade-safe like HITPAY_* above: unset means the button shows
  // "Google sign-in isn't available yet" instead of throwing. GOOGLE_CLIENT_ID is not
  // secret (it's sent to the browser); GOOGLE_CLIENT_SECRET never leaves the server.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  // Sentry (2026-08-25): one free-tier SnapReceipt AI project for runtime error tracking.
  // Optional/degrade-safe: unset means Sentry is off and the existing structured JSON logs
  // remain the only error channel. Claude owns the actual DSN/env setup; code only reads it.
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  SENTRY_ENABLED: process.env.SENTRY_ENABLED || '',
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
  SENTRY_RELEASE: process.env.SENTRY_RELEASE || '',
  SENTRY_TRACES_SAMPLE_RATE: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0') || 0,
};

// Model routing (ARCHITECTURE §3.5). IDs come from .env so deprecations are a config change (ADR-006).
// 2026-07-21: vision (visionDefault/visionEscalate) moved OFF Groq entirely, to OpenRouter
// (lib/openrouter.js) — Groq decommissioned llama-4-scout 2026-07-17; the forced replacement
// (qwen/qwen3.6-27b on Groq) proved unreliable enough on real receipts that the Owner asked to
// move providers rather than keep tuning around it. OpenRouter still serves the original Scout
// model under the slug 'meta-llama/llama-4-scout' (confirmed against OpenRouter's own model
// catalog, NOT Groq's longer 'meta-llama/llama-4-scout-17b-16e-instruct' id — different
// provider, different slug). text/classify are UNCHANGED and still route through Groq.
// 2026-08-23 (Barat: "try to strong the OCR on date reading"): visionEscalate used to
// default to the SAME model as visionDefault — no real escalation path existed even though
// lib/ocr.js's extractReceipt() was written to use it. Now a genuinely stronger paid vision
// model, only called when the cheap default's date read isn't plausible (see extractReceipt's
// escalation logic + lib/money.js's isDatePlausible) — cost is incurred only on the receipts
// that actually need it, not on every capture. gpt-4o-mini: strong, well-established OCR/
// digit-recognition accuracy on OpenRouter at a modest per-call cost; override via
// VISION_MODEL_HEAVY if a different model is preferred later.
cfg.MODEL_ROUTES = {
  visionDefault: process.env.VISION_MODEL || 'meta-llama/llama-4-scout',
  visionEscalate: process.env.VISION_MODEL_HEAVY || 'openai/gpt-4o-mini',
  text: process.env.TEXT_MODEL || 'llama-3.3-70b-versatile',
  classify: process.env.CLASSIFY_MODEL || 'openai/gpt-oss-20b',
};

// PDF ingestion (#1, ADR-014) — render resolution and a hard byte cap checked BEFORE
// parsing (defends decompression/page bombs and Groq cost-drain, SOP §7.2/§7.3).
cfg.PDF_RENDER_DPI = Number(process.env.PDF_RENDER_DPI) || 150;
cfg.PDF_MAX_BYTES  = Number(process.env.PDF_MAX_BYTES)  || 20 * 1024 * 1024; // 20 MB
// Hard cap on rendered pixels per page (width*height at render scale). A tiny PDF can
// declare a huge MediaBox (e.g. 20000x20000pt) to force a multi-GB bitmap alloc — the
// byte cap alone doesn't stop it. 40 MP comfortably fits any real page (A3 @150dpi ≈
// 4.3 MP; A4 @600dpi ≈ 35 MP) while blocking the bomb. Checked BEFORE page.render.
cfg.PDF_MAX_RENDER_PIXELS = Number(process.env.PDF_MAX_RENDER_PIXELS) || 40_000_000;

// Shared page/image cap for both #7 mass-upload and #1 PDF ingestion (same knob, no
// new one per the design). bot.js/routes/upload.js already read process.env directly
// with the identical default; exported here too so lib/pdf.js has one canonical source.
cfg.MASS_MAX_IMAGES = Number(process.env.MASS_MAX_IMAGES) || 10;

// Automation-impact metrics (round-2 plan R2 / task C4). The stated assumption behind the
// client-facing "hours saved" figure: how long a receipt took to key in by hand before us.
// A knob, not a magic number — a client can be shown (and, per contract, agree to) their own
// figure. Default 2.5 min/receipt. Read by lib/metrics.js via routes/metrics.js.
cfg.MANUAL_MINUTES_PER_RECEIPT = Number(process.env.MANUAL_MINUTES_PER_RECEIPT) || 2.5;

// AUTH_REQUIRED is a live getter (not a snapshot) so tests can toggle NODE_ENV /
// AUTH_REQUIRED at request time without re-requiring this module. Production always
// requires auth; AUTH_REQUIRED=true forces the same behavior in any environment
// (e.g. staging) that isn't NODE_ENV=production.
Object.defineProperty(cfg, 'AUTH_REQUIRED', {
  enumerable: true,
  get() { return process.env.NODE_ENV === 'production' || process.env.AUTH_REQUIRED === 'true'; },
});

// P6 hardening (§4.5): the dashboard's own origin, for tightening
// Access-Control-Allow-Origin on token-gated routes. Empty by default (dev-permissive —
// routes fall back to '*'); production should set this to the exact dashboard origin,
// e.g. https://receipts.yourdomain.com (no trailing slash, no path).
cfg.DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

cfg.SB_REST = cfg.SB_URL + '/rest/v1';
cfg.sbH = { apikey: cfg.SB_KEY, Authorization: 'Bearer ' + cfg.SB_KEY, 'Content-Type': 'application/json' };

// Startup guard — surface missing secrets loudly (moved from server.js:36-38).
function assertConfig() {
  ['BOT_TOKEN', 'GROQ_KEY', 'OPENROUTER_KEY', 'SB_URL', 'SB_KEY'].forEach(k => {
    if (!process.env[k]) console.error('[FATAL] Missing env var:', k, '— set it in .env');
  });
}

// One-line summary of the ACTIVE runtime config, printed on every boot (server.js) so a
// stale/misconfigured setting is visible immediately rather than only surfacing in the
// data later. Motivated by the "all receipts saved as USD" incident: DEFAULT_CURRENCY was
// changed in .env mid-session but the running process kept its old snapshot (dotenv loads
// .env into process.env ONCE at startup — a file edit never reaches a running process; a
// restart is the only fix). Reads straight off cfg so there is no second, driftable copy.
function configSummary() {
  return [
    'account=' + cfg.ACCOUNT_ID,
    'currency=' + cfg.DEFAULT_CURRENCY,
    'tax=' + cfg.DEFAULT_TAX_RATE,
    'auth=' + (cfg.AUTH_REQUIRED ? (cfg.DASHBOARD_TOKEN ? 'on' : 'REQUIRED-but-no-token!') : 'off'),
    'sentry=' + (cfg.SENTRY_DSN && cfg.SENTRY_ENABLED !== 'false' ? 'on' : 'off'),
  ].join(' · ');
}

module.exports = { cfg, assertConfig, configSummary };
