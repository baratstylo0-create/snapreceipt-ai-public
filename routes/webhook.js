'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { handleUpdate } = require('../lib/bot');
const { createRateLimiter } = require('../lib/ratelimit');

// P6 abuse defense: cap requests per source IP on the PUBLIC webhook (it's reachable
// by anyone, and the secret check below can be probed). Generous default — Telegram
// delivers a bot's updates from its own IPs, so real traffic stays well under this;
// tune via WEBHOOK_RATE_MAX. Runs before JSON parsing so limited requests aren't parsed.
const webhookLimiter = createRateLimiter({ max: Number(process.env.WEBHOOK_RATE_MAX) || 240 });

module.exports = function mountWebhook(app) {
  app.post('/webhook', webhookLimiter, express.json({ limit: '2mb' }), (req, res) => {
    if (cfg.WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== cfg.WEBHOOK_SECRET) return res.sendStatus(401);
    res.sendStatus(200);
    handleUpdate(req.body).catch(e => console.error('[handleUpdate]', e.message));
  });
};
