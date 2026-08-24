'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { handleUpdate } = require('../lib/bot');
const { createRateLimiter } = require('../lib/ratelimit');
// P-04a (#37): the shared, multi-instance layer that wraps the in-process limiter above.
const { createAbuseLimiter } = require('../lib/sharedLimit');

// P6 abuse defense: cap requests per source IP on the PUBLIC webhook (it's reachable
// by anyone, and the secret check below can be probed). Generous default — Telegram
// delivers a bot's updates from its own IPs, so real traffic stays well under this;
// tune via WEBHOOK_RATE_MAX. Runs before JSON parsing so limited requests aren't parsed.
const webhookLimiter = createAbuseLimiter({ name: 'bot.webhook', max: Number(process.env.WEBHOOK_RATE_MAX) || 240 });

let warnedNoSecret = false;

module.exports = function mountWebhook(app) {
  app.post('/webhook', webhookLimiter, express.json({ limit: '2mb' }), (req, res) => {
    // #43 fail-closed: mirrors the checkDash pattern. When auth is required (production,
    // or AUTH_REQUIRED=true) a missing WEBHOOK_SECRET is a misconfiguration — REFUSE the
    // request (503) rather than silently accepting unauthenticated updates from anyone.
    // In dev with no secret we stay permissive but warn once so the gap is visible.
    if (!cfg.WEBHOOK_SECRET) {
      if (cfg.AUTH_REQUIRED) return res.sendStatus(503);
      if (!warnedNoSecret) {
        warnedNoSecret = true;
        console.warn('[webhook] WEBHOOK_SECRET not set — accepting unauthenticated updates (dev only). Set WEBHOOK_SECRET, or AUTH_REQUIRED/production to enforce.');
      }
    } else if (req.get('X-Telegram-Bot-Api-Secret-Token') !== cfg.WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    handleUpdate(req.body).catch(e => console.error('[handleUpdate]', e.message));
  });
};
