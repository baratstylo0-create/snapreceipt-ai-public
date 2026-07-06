'use strict';
// Per-account UI settings — HTTP surface (owner request 2026-07-05).
//   GET /api/settings/category-colors -> { colors: { "<category>": "#rrggbb" } }
//   PUT /api/settings/category-colors  body { colors: {...} } -> the stored map
//
// First (and currently only) consumer is the Overview donut's custom category
// colours. Storing them server-side (account-scoped) instead of only in the
// browser's localStorage lets a user's chosen colours follow them across
// browsers and devices.
//
// Uses the frozen lib/supabase.js helpers (which auto-inject account_id, so a
// request can never read/write another tenant's row). No new lib file — this
// route owns its own small validation + upsert against the generic
// `account_settings` (account_id, key, value jsonb) table (see schema.sql M6).

const express = require('express');
const supabase = require('../lib/supabase'); // namespace import so tests can stub sbSelect/sbInsert/sbUpdate
const { checkDash } = require('./expenses'); // reuse the optional dashboard-token gate
const { createRateLimiter } = require('../lib/ratelimit');

const SETTINGS_KEY = 'category_colors';
const BODY_LIMIT = '64kb';
// Guardrails on the untrusted colour map (SOP §7.2 — validate at the boundary):
// cap how many categories + how long a category key can be, and require every
// value to be a strict #rrggbb hex so nothing but a colour can ever be stored.
const MAX_ENTRIES = 200;
const MAX_KEY_LEN = 128;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Same per-IP limiter shape the other authed API routes use (blunts token
// brute-force since the write path sits behind the optional dashboard token).
const settingsLimiter = createRateLimiter({ max: Number(process.env.SETTINGS_RATE_MAX) || 60 });

// sanitizeColorMap(raw) -> { "<trimmed lowercase name>": "#rrggbb" }
// Drops any entry whose key is blank/too long or whose value isn't a valid
// 6-digit hex. Tolerates non-object / null / array input (returns {}). Pure —
// exported for unit tests. Keys are normalised (trim + lowercase) to match the
// frontend's normaliseCategoryKey so "Rent & Lease" and " rent & lease " map
// to the same stored entry.
function sanitizeColorMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const rawKey of Object.keys(raw)) {
    if (n >= MAX_ENTRIES) break;
    const key = String(rawKey).trim().toLowerCase();
    if (key === '' || key.length > MAX_KEY_LEN) continue;
    const val = raw[rawKey];
    if (typeof val !== 'string' || !HEX_RE.test(val.trim())) continue;
    out[key] = val.trim();
    n++;
  }
  return out;
}

module.exports = function mountSettings(app) {
  // Read the account's stored category colours (empty map when none saved yet).
  app.get('/api/settings/category-colors', settingsLimiter, checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const rows = await supabase.sbSelect('account_settings', { eq: { key: SETTINGS_KEY }, limit: 1 });
      const value = rows[0] && rows[0].value && typeof rows[0].value === 'object' ? rows[0].value : {};
      res.json({ colors: sanitizeColorMap(value) });
    } catch (e) {
      console.error('[api/settings get]', e.message);
      res.status(502).json({ error: 'load failed' });
    }
  });

  // Replace the account's stored category colours with the posted map.
  app.put('/api/settings/category-colors',
    settingsLimiter,
    checkDash,
    express.json({ limit: BODY_LIMIT }),
    async (req, res) => {
      res.set('Access-Control-Allow-Origin', '*');
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const colors = sanitizeColorMap(body.colors);
        const updated_at = new Date().toISOString();
        // Upsert on (account_id, key). sbSelect/sbInsert/sbUpdate all scope to
        // cfg.ACCOUNT_ID, so this only ever touches this account's own row.
        const existing = await supabase.sbSelect('account_settings', { eq: { key: SETTINGS_KEY }, limit: 1 });
        if (existing[0]) {
          await supabase.sbUpdate('account_settings', { id: existing[0].id }, { value: colors, updated_at });
        } else {
          await supabase.sbInsert('account_settings', { key: SETTINGS_KEY, value: colors, updated_at });
        }
        res.json({ colors });
      } catch (e) {
        console.error('[api/settings put]', e.message);
        res.status(502).json({ error: 'save failed' });
      }
    },
    // express.json() throws synchronously on a malformed body before the handler
    // runs; keep a route-local catch so that never falls through to Express's
    // default handler (which leaks a stack trace + file paths — SOP §7.2).
    (err, req, res, next) => {
      if (res.headersSent) return next(err);
      console.error('[api/settings put] body-parser error:', err && err.message);
      res.status(400).json({ error: 'malformed request body' });
    });
};

module.exports.sanitizeColorMap = sanitizeColorMap;
