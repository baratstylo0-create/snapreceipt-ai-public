'use strict';
require('dotenv').config();

const cfg = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  GROQ_KEY: process.env.GROQ_KEY,
  SB_URL: (process.env.SB_URL || '').replace(/\/$/, ''),
  SB_KEY: process.env.SB_KEY,
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN || '',
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

cfg.SB_REST = cfg.SB_URL + '/rest/v1';
cfg.sbH = { apikey: cfg.SB_KEY, Authorization: 'Bearer ' + cfg.SB_KEY, 'Content-Type': 'application/json' };

// Startup guard — surface missing secrets loudly (moved from server.js:36-38).
function assertConfig() {
  ['BOT_TOKEN', 'GROQ_KEY', 'SB_URL', 'SB_KEY'].forEach(k => {
    if (!process.env[k]) console.error('[FATAL] Missing env var:', k, '— set it in .env');
  });
}

module.exports = { cfg, assertConfig };
