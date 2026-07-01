'use strict';
const path = require('path');
const express = require('express');
const { cfg } = require('../lib/config');

module.exports = function mountMisc(app) {
  app.get('/health', (req, res) => res.json({ ok: true, service: 'receipt-saas', account: cfg.ACCOUNT_ID }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
};
