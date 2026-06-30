/**
 * Receipt Analyser SaaS — server entry (wiring only).
 * All logic lives in lib/* and routes/*. See docs/ARCHITECTURE.md.
 */
'use strict';
const express = require('express');
const { cfg, assertConfig } = require('./lib/config');
const { registerWebhook } = require('./lib/telegram');

const mountWebhook = require('./routes/webhook');
const mountExpenses = require('./routes/expenses');
const mountReceipt = require('./routes/receipt');
const mountMisc = require('./routes/misc');

assertConfig();

const app = express();
app.set('trust proxy', true);
mountWebhook(app);
mountExpenses(app);
mountReceipt(app);
mountMisc(app);

if (process.argv.includes('--register-only')) {
  registerWebhook().then(() => process.exit(0));
} else {
  app.listen(cfg.PORT, () => {
    console.log('[receipt-saas] listening on :' + cfg.PORT + '  (account: ' + cfg.ACCOUNT_ID + ')');
    setTimeout(registerWebhook, 1500);
  });
}
