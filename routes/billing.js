'use strict';
// billing.js (2026-07-30) — HitPay checkout for the Free/Pro upgrade. checkDash-gated (same
// auth every other personal-mode route uses) + personalAuth-gated (404 otherwise) — business
// accounts have no plan concept and never see this route at all.
const express = require('express');
const { checkDash } = require('./expenses');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const hitpay = require('../lib/hitpay');
const { cfg } = require('../lib/config');
const { sbSelect } = require('../lib/supabase');

// Checkout creation hits a real external API and (once configured) can start a real billing
// relationship — deliberately tight, matching signup/login-class limiters, not the generous
// per-minute ceilings used for read-heavy routes.
const checkoutLimiter = createRateLimiter({ max: Number(process.env.BILLING_CHECKOUT_RATE_MAX) || 10 });

module.exports = function mountBilling(app) {
  // POST /api/billing/checkout { billingCycle: 'monthly'|'yearly' } -> { ok, checkoutUrl }
  app.post('/api/billing/checkout', checkoutLimiter, checkDash, express.json({ limit: '1kb' }), async (req, res) => {
    const caps = getCapabilities();
    if (!caps.personalAuth) return res.status(404).json({ error: 'not found' });
    // Guests and business roles have no billing concept — only a real personal owner can reach
    // HitPay checkout (mirrors the free-tier cap's own role gate in lib/bot.js/routes/upload.js).
    if (!req.scope || req.scope.role !== 'owner' || !req.user || !req.user.user_id) {
      return res.status(403).json({ error: 'not available for this account' });
    }
    if (!hitpay.isConfigured()) {
      return res.status(503).json({ error: 'billing_not_configured', message: 'Payments aren\'t set up yet — please check back soon.' });
    }
    const billingCycle = req.body && req.body.billingCycle;
    if (billingCycle !== 'monthly' && billingCycle !== 'yearly') {
      return res.status(400).json({ error: 'billingCycle must be "monthly" or "yearly"' });
    }
    try {
      // req.user carries the session's identity but not the raw username/email column
      // (lookupSession's shape is deliberately minimal — see lib/auth.js) — one small lookup
      // for the email HitPay's checkout needs to prefill, same query shape /api/config
      // already uses for the plan lookup.
      const rows = await sbSelect('users', { eq: { id: req.user.user_id }, limit: 1 });
      const account = rows[0];
      if (!account) return res.status(404).json({ error: 'account not found' });
      const redirectUrl = (cfg.PUBLIC_URL || (req.protocol + '://' + req.get('host'))) + '/?billing=return';
      const result = await hitpay.createCheckout({
        email: account.username,
        name: account.display_name || account.username,
        billingCycle,
        userId: req.user.user_id,
        redirectUrl,
      });
      if (!result.ok) return res.status(502).json({ error: 'checkout_failed', message: result.error });
      return res.json({ ok: true, checkoutUrl: result.checkoutUrl });
    } catch (e) {
      console.error('[billing checkout]', e.message);
      return res.status(502).json({ error: 'checkout failed' });
    }
  });
};
