'use strict';
// hitpayWebhook.js (2026-07-30) — HitPay tells us here when a subscription payment
// succeeds/fails/renews/cancels; this is what actually flips users.plan to 'pro' (or back
// to 'free'), not the checkout redirect (a user can close the tab before the redirect fires,
// or the payment can settle after they've already left — the webhook is the source of truth,
// same reasoning as every other payment-provider integration).
//
// Needs the RAW request body (express.raw, not express.json) because
// hitpay.verifyWebhookSignature() computes an HMAC over the exact bytes HitPay sent — a
// parsed-then-re-serialized JSON.stringify can reorder keys or change whitespace and would
// silently break every signature check (see lib/hitpay.js's own comment on this).
const express = require('express');
const { sbSelect, sbUpdate, sbInsert } = require('../lib/supabase');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');
const { verifyWebhookSignature } = require('../lib/hitpay');
const { cfg } = require('../lib/config');

const hitpayWebhookLimiter = createRateLimiter({ max: Number(process.env.HITPAY_WEBHOOK_RATE_MAX) || 240 });

let warnedNoSalt = false;

// applyStatus(userId, patch) — updates (or creates, on first checkout) the user's
// subscriptions row AND mirrors the plan onto users.plan in the same call, so grid.js's
// Export PDF gate (which reads users.plan directly) and Settings' Plan & Billing section
// both see the change immediately — no second sync step to keep consistent.
async function applyStatus(referenceUserId, { plan, status, hitpaySubscriptionId, currentPeriodEnd, billingCycle }, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const update = deps.sbUpdate || sbUpdate;
  const insert = deps.sbInsert || sbInsert;
  const existing = await select('subscriptions', { eq: { user_id: referenceUserId }, limit: 1 });
  const patch = {
    plan, status,
    ...(hitpaySubscriptionId != null ? { hitpay_subscription_id: hitpaySubscriptionId } : {}),
    ...(currentPeriodEnd != null ? { current_period_end: currentPeriodEnd } : {}),
    ...(billingCycle != null ? { billing_cycle: billingCycle } : {}),
  };
  if (existing[0]) {
    await update('subscriptions', { id: existing[0].id }, patch);
  } else {
    await insert('subscriptions', { user_id: referenceUserId, ...patch });
  }
  await update('users', { id: referenceUserId }, { plan });
}

module.exports = function mountHitpayWebhook(app) {
  app.post('/api/webhooks/hitpay', hitpayWebhookLimiter, express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const caps = getCapabilities();
    if (!caps.personalAuth) return res.sendStatus(404);

    if (!cfg.HITPAY_SALT) {
      if (!warnedNoSalt) {
        warnedNoSalt = true;
        console.warn('[hitpay webhook] HITPAY_SALT not set — refusing all webhook deliveries until configured.');
      }
      return res.sendStatus(503);
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const signature = req.get('Hitpay-Signature') || req.get('X-Hitpay-Signature') || '';
    if (!verifyWebhookSignature(rawBody, signature)) return res.sendStatus(401);

    // Acknowledge immediately (same "200 first, process after" pattern as the Telegram
    // webhook) — HitPay retries on a non-2xx/timeout, and our own processing failures
    // shouldn't turn into duplicate-delivery storms.
    res.sendStatus(200);

    let payload;
    try { payload = JSON.parse(rawBody); } catch (e) {
      console.error('[hitpay webhook] unparseable body:', e.message);
      return;
    }
    try {
      // `reference` round-trips the user_id we sent when creating the checkout
      // (lib/hitpay.js's createCheckout body) — this is how we know WHICH account a given
      // webhook delivery is about, without a separate lookup table.
      const userId = payload.reference || (payload.recurring_billing && payload.recurring_billing.reference);
      if (!userId) { console.warn('[hitpay webhook] no reference/user id in payload, ignoring'); return; }

      const status = String(payload.status || (payload.recurring_billing && payload.recurring_billing.status) || '').toLowerCase();
      const hitpaySubscriptionId = payload.id || (payload.recurring_billing && payload.recurring_billing.id) || null;

      if (status === 'succeeded' || status === 'active') {
        await applyStatus(userId, { plan: 'pro', status: 'active', hitpaySubscriptionId }, {});
      } else if (status === 'cancelled' || status === 'expired') {
        await applyStatus(userId, { plan: 'free', status: 'cancelled', hitpaySubscriptionId }, {});
      } else if (status === 'failed' || status === 'past_due') {
        // A failed/past-due charge does NOT immediately revoke Pro — HitPay/most providers
        // give a grace window (retries) before a subscription actually lapses; only an
        // explicit cancelled/expired status above removes access.
        await applyStatus(userId, { plan: 'pro', status: 'past_due', hitpaySubscriptionId }, {});
      } else {
        console.warn('[hitpay webhook] unrecognized status, no plan change:', status);
      }
    } catch (e) {
      console.error('[hitpay webhook] processing failed:', e.message);
    }
  });
};
