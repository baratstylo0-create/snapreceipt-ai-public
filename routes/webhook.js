'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { handleUpdate } = require('../lib/bot');

module.exports = function mountWebhook(app) {
  app.post('/webhook', express.json({ limit: '2mb' }), (req, res) => {
    if (cfg.WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== cfg.WEBHOOK_SECRET) return res.sendStatus(401);
    res.sendStatus(200);
    handleUpdate(req.body).catch(e => console.error('[handleUpdate]', e.message));
  });
};
