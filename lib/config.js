'use strict';
require('dotenv').config();

const cfg = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  // Public @handle (not a secret) — lets the dashboard render a clickable t.me/<bot>?start=
  // deep link for clerk bot-binding (Team view) instead of a bare code to copy-paste.
  // Optional: unset -> the frontend falls back to showing the raw code (setup/provision.js's
  // CLI bindingLink() already has this exact same optional/degrade pattern).
  BOT_USERNAME: (process.env.BOT_USERNAME || '').replace(/^@/, '').trim(),
  GROQ_KEY: process.env.GROQ_KEY,
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
};

// Model routing (ARCHITECTURE §3.5). IDs come from .env so deprecations are a config change (ADR-006).
// Fallback defaults kept in sync with ADR-007: llama-4-maverick is decommissioned and
// llama-4-scout is Preview-only, so both vision slots fall back to the one production vision model.
cfg.MODEL_ROUTES = {
  visionDefault: process.env.VISION_MODEL || 'qwen/qwen3.6-27b',
  visionEscalate: process.env.VISION_MODEL_HEAVY || 'qwen/qwen3.6-27b',
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
  ['BOT_TOKEN', 'GROQ_KEY', 'SB_URL', 'SB_KEY'].forEach(k => {
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
  ].join(' · ');
}

module.exports = { cfg, assertConfig, configSummary };
